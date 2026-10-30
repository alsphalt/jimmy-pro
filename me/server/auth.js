'use strict';
/**
 * Identity: accounts, long-lived sessions, trusted devices, PIN, recovery.
 *
 * Design notes that matter:
 *  - Passwords and PINs are per-secret salted scrypt hashes. Nothing reversible
 *    is stored, and the same cleartext never produces the same hash twice.
 *  - Session tokens are random 32-byte values. Only their SHA-256 is persisted,
 *    so a leaked db.json cannot be replayed as a live session.
 *  - Sessions are idle-based: they live two years from the last time they were
 *    used, not two years from login. A user who keeps using the app stays
 *    signed in; one who disappears is expired.
 *  - A device is only trusted after it is proven to be the same browser that
 *    signed in before (device cookie), otherwise the account PIN is required.
 *  - There is no email delivery configured, so nothing here claims to send one.
 */
const crypto = require('crypto');
const store = require('./store');

const SESSION_TTL_MS = 730 * 24 * 60 * 60 * 1000; /* two years idle */
const TOUCH_AFTER_MS = 6 * 60 * 60 * 1000; /* extend at most this often */
const SESSION_COOKIE = 'jp_session';
const DEVICE_COOKIE = 'jp_device';
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;

/* Which payment account types exist, and what can actually be verified for each.
   Daraja exposes no "send the customer a 7-digit code" endpoint for any of them,
   so `sevenDigitCode` is false across the board rather than silently pretending.
   `kyc` = Safaricom's validateID (ID number must belong to the MSISDN owner). */
const ACCOUNT_TYPES = {
  till: {
    label: 'Till number (Buy Goods)',
    transactionType: 'CustomerBuyGoodsOnline',
    sevenDigitCode: false,
    kyc: false,
    note: 'Money lands in the till. Daraja has no code-verification call for tills.',
  },
  paybill: {
    label: 'Paybill',
    transactionType: 'CustomerPayBillOnline',
    sevenDigitCode: false,
    kyc: false,
    note: 'Money lands in the paybill account.',
  },
  pochi: {
    label: 'Pochi la Biashara',
    transactionType: 'CustomerBuyGoodsOnline',
    sevenDigitCode: false,
    kyc: true,
    note: 'Personal-business wallet. Ownership is checked against the phone holder identity.',
  },
  sendmoney: {
    label: 'Send Money (personal number)',
    transactionType: 'CustomerPayBillOnline',
    sevenDigitCode: false,
    kyc: true,
    note: 'P2P transfers are not collectable by a business; prompts still need a shortcode.',
  },
  bank: {
    label: 'Bank account',
    transactionType: null,
    sevenDigitCode: false,
    kyc: false,
    note: 'Settlement goes to a bank; M-Pesa collection still runs through a shortcode.',
  },
};

/* ------------------------------------------------------------------ hashing */

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(secret), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: derived.toString('hex'), N: 16384, r: 8, p: 1 };
}

function verifySecret(secret, record) {
  if (!record || !record.salt || !record.hash) return false;
  const derived = crypto.scryptSync(String(secret), record.salt, 64, {
    N: record.N || 16384,
    r: record.r || 8,
    p: record.p || 1,
  });
  const expected = Buffer.from(record.hash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('hex');

/* -------------------------------------------------------------------- users */

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function findUserByEmail(email) {
  const key = normalizeEmail(email);
  return store.users.find((u) => u.email === key) || null;
}

function findUserById(id) {
  return store.users.find((u) => u.id === id) || null;
}

function publicUser(user) {
  if (!user) return null;
  const account = user.account || null;
  const type = account ? ACCOUNT_TYPES[account.type] : null;
  return {
    id: user.id,
    email: user.email,
    name: user.name || '',
    phone: user.phone || '',
    business: user.business || null,
    account: account
      ? {
          type: account.type,
          label: type ? type.label : account.type,
          number: account.number || '',
          verification: account.verification || { status: 'unverified', method: null },
          sevenDigitCode: Boolean(type && type.sevenDigitCode),
        }
      : null,
    pinSet: Boolean(user.pin),
    profileComplete: Boolean(user.name && user.phone && user.business && user.business.name),
    onboardingComplete: Boolean(user.name && user.phone && user.business?.name && user.account?.number && user.pin),
    createdAt: user.createdAt,
  };
}

function register({ email, password }) {
  const key = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) {
    const err = new Error('Enter a valid email address.');
    err.status = 400;
    throw err;
  }
  if (String(password || '').length < 8) {
    const err = new Error('Use a password of at least 8 characters.');
    err.status = 400;
    throw err;
  }
  if (findUserByEmail(key)) {
    const err = new Error('An account with that email already exists. Log in instead.');
    err.status = 409;
    throw err;
  }

  const user = {
    id: newId(),
    email: key,
    /* No mail transport is configured, so this stays false and nothing claims
       otherwise. It is recorded so a later verification step can act on it. */
    emailVerified: false,
    password: hashSecret(password),
    name: '',
    phone: '',
    business: null,
    account: null,
    pin: null,
    pinAttempts: 0,
    pinLockedUntil: null,
    recoveryCodes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.users.push(user);
  store.save();
  return user;
}

function updateProfile(user, { name, phone, business }) {
  if (name !== undefined) user.name = String(name).trim().slice(0, 80);
  if (phone !== undefined) {
    const digits = String(phone).replace(/\D/g, '');
    const normalised = digits.startsWith('254')
      ? digits
      : digits.startsWith('0')
        ? `254${digits.slice(1)}`
        : digits.length === 9
          ? `254${digits}`
          : digits;
    if (!/^254[17]\d{8}$/.test(normalised)) {
      const err = new Error('Enter a valid Safaricom number, e.g. 0712 345 678.');
      err.status = 400;
      throw err;
    }
    user.phone = normalised;
  }
  if (business !== undefined) {
    const b = business || {};
    user.business = {
      name: String(b.name || '').trim().slice(0, 80),
      town: String(b.town || '').trim().slice(0, 60),
      category: String(b.category || '').trim().slice(0, 60),
    };
  }
  user.updatedAt = new Date().toISOString();
  store.save();
  return user;
}

function setAccount(user, { type, number }) {
  const meta = ACCOUNT_TYPES[type];
  if (!meta) {
    const err = new Error('Choose a supported account type.');
    err.status = 400;
    throw err;
  }
  const clean = String(number || '').replace(/\s/g, '');
  if (clean.length < 4 || clean.length > 32) {
    const err = new Error('Enter the account or business number (4-32 characters).');
    err.status = 400;
    throw err;
  }
  user.account = {
    type,
    number: clean,
    verification: {
      status: 'unverified',
      method: null,
      /* Honest capability report: no provider offers the 7-digit flow here. */
      sevenDigitCodeSupported: Boolean(meta.sevenDigitCode),
      reason: meta.sevenDigitCode
        ? null
        : 'Daraja does not provide a code-verification endpoint for this account type.',
      updatedAt: new Date().toISOString(),
    },
  };
  user.updatedAt = new Date().toISOString();
  store.save();
  return user;
}


/**
 * How money is collected for a business's chosen account type.
 *
 * Daraja's STK push settles to a *shortcode*: Buy Goods (till/pochi) or Paybill.
 * It cannot push to a personal number or straight into a bank account, so those
 * two types are refused with an explanation instead of being sent down a flow
 * that would fail at Safaricom with something opaque.
 */
function collectionPlan(user) {
  const account = user?.account;
  if (!account || !account.number) {
    return { supported: true, source: 'settings', shortcode: null, transactionType: null, note: 'Using the install default.' };
  }
  const number = String(account.number).replace(/\s/g, '');
  const numeric = /^\d{5,7}$/.test(number);

  if (account.type === 'till') {
    if (!numeric) {
      return { supported: false, reason: 'A till number is 5-7 digits. Check the number you entered.', type: 'till' };
    }
    return { supported: true, type: 'till', shortcode: number, transactionType: 'CustomerBuyGoodsOnline', note: 'Buy Goods prompt to the till.' };
  }
  if (account.type === 'pochi') {
    if (!numeric) {
      return { supported: false, reason: 'A Pochi la Biashara number is 5-7 digits.', type: 'pochi' };
    }
    return { supported: true, type: 'pochi', shortcode: number, transactionType: 'CustomerBuyGoodsOnline', note: 'Buy Goods prompt to the Pochi store number.' };
  }
  if (account.type === 'paybill') {
    if (!numeric) {
      return { supported: false, reason: 'A paybill number is 5-7 digits.', type: 'paybill' };
    }
    return { supported: true, type: 'paybill', shortcode: number, transactionType: 'CustomerPayBillOnline', note: 'Paybill prompt; the account reference identifies the customer.' };
  }
  if (account.type === 'sendmoney') {
    return {
      supported: false,
      type: 'sendmoney',
      reason:
        'A Send Money number cannot receive an M-Pesa request. STK collects to a shortcode, so a business needs a till ' +
        'or paybill. Sending to a personal number is a B2C payout, which is a different flow (and needs its own Daraja product).',
    };
  }
  if (account.type === 'bank') {
    return {
      supported: false,
      type: 'bank',
      reason:
        'M-Pesa cannot settle an STK push into a bank account. Collection needs a paybill or till; the bank is where ' +
        'the money is swept afterwards, not where the customer pays.',
    };
  }
  return { supported: false, reason: 'That account type has no collection flow.' };
}

/* ---------------------------------------------------------------------- pin */

function setPin(user, pin) {
  if (!/^\d{4,6}$/.test(String(pin || ''))) {
    const err = new Error('Choose a PIN of 4 to 6 digits.');
    err.status = 400;
    throw err;
  }
  user.pin = hashSecret(pin);
  user.pinAttempts = 0;
  user.pinLockedUntil = null;
  user.updatedAt = new Date().toISOString();
  store.save();
  return user;
}

function pinLocked(user) {
  return Boolean(user.pinLockedUntil && new Date(user.pinLockedUntil).getTime() > Date.now());
}

function verifyPin(user, pin) {
  if (!user.pin) {
    const err = new Error('No PIN is set on this account yet.');
    err.status = 400;
    throw err;
  }
  if (pinLocked(user)) {
    const err = new Error('Too many wrong attempts. Try again in a few minutes.');
    err.status = 429;
    throw err;
  }
  if (!verifySecret(pin, user.pin)) {
    user.pinAttempts = (user.pinAttempts || 0) + 1;
    if (user.pinAttempts >= PIN_MAX_ATTEMPTS) {
      user.pinLockedUntil = new Date(Date.now() + PIN_LOCK_MS).toISOString();
      user.pinAttempts = 0;
    }
    user.updatedAt = new Date().toISOString();
    store.save();
    const err = new Error('That PIN is not correct.');
    err.status = 401;
    throw err;
  }
  user.pinAttempts = 0;
  user.pinLockedUntil = null;
  store.save();
  return true;
}

/** One-time codes, shown when the PIN is created. */
function issueRecoveryCodes(user) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  user.recoveryCodes = codes.map((code) => ({ hash: sha256(code), usedAt: null }));
  store.save();
  return codes;
}

function useRecoveryCode(user, code) {
  const wanted = sha256(String(code || '').trim().toUpperCase());
  const match = user.recoveryCodes.find((c) => !c.usedAt && c.hash === wanted);
  if (!match) return false;
  match.usedAt = new Date().toISOString();
  store.save();
  return true;
}

/* The store exposes its collections as getters, so they must be mutated in
   place - reassigning would throw (and did). */
function dropSessions(predicate) {
  const list = store.sessions;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (predicate(list[i])) list.splice(i, 1);
  }
}

/* ----------------------------------------------------------------- devices */

function deviceFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[DEVICE_COOKIE] || null;
}

function listDevices(userId) {
  return store.devices
    .filter((d) => d.userId === userId && !d.revokedAt)
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

function trustDevice(user, deviceKey, req) {
  const now = new Date().toISOString();
  let device = store.devices.find((d) => d.userId === user.id && d.id === deviceKey && !d.revokedAt);
  if (!device) {
    device = {
      id: deviceKey,
      userId: user.id,
      label: describeAgent(req.get('user-agent') || ''),
      firstSeenAt: now,
      lastSeenAt: now,
      trustedAt: now,
    };
    store.devices.push(device);
  } else {
    device.lastSeenAt = now;
  }
  store.save();
  return device;
}

function describeAgent(ua) {
  const text = String(ua);
  const phone = /Android/i.test(text)
    ? 'Android phone'
    : /iPhone/i.test(text)
      ? 'iPhone'
      : /iPad|Tablet/i.test(text)
        ? 'Tablet'
        : /Macintosh/i.test(text)
          ? 'Mac'
          : /Windows/i.test(text)
            ? 'Windows PC'
            : /Linux/i.test(text)
              ? 'Linux PC'
              : 'Unknown device';
  const browser = /Edg\//i.test(text)
    ? 'Edge'
    : /OPR\//i.test(text)
      ? 'Opera'
      : /Chrome\//i.test(text)
        ? 'Chrome'
        : /Firefox\//i.test(text)
          ? 'Firefox'
          : /Safari\//i.test(text)
            ? 'Safari'
            : null;
  return browser ? `${phone} · ${browser}` : phone;
}

function revokeDevice(userId, deviceId) {
  const device = store.devices.find((d) => d.userId === userId && d.id === deviceId && !d.revokedAt);
  if (!device) {
    const err = new Error('That device is not on your account.');
    err.status = 404;
    throw err;
  }
  device.revokedAt = new Date().toISOString();
  /* Kill every session that belongs to it, immediately. */
  dropSessions((s) => s.deviceId === deviceId && s.userId === userId);
  store.save();
  return device;
}

/* ---------------------------------------------------------------- sessions */

function createSession(user, deviceId, req) {
  const token = newToken();
  const now = Date.now();
  const session = {
    id: newId(),
    userId: user.id,
    deviceId,
    tokenHash: sha256(token),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    userAgent: describeAgent(req.get('user-agent') || ''),
  };
  store.sessions.push(session);
  /* Opportunistic cleanup so the array cannot grow without bound. */
  dropSessions((s) => new Date(s.expiresAt).getTime() <= now);
  store.save();
  return { session, token };
}

/** Resolve a session token, rolling its expiry forward when it is in use. */
function resolveSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = store.sessions.find((s) => s.tokenHash === tokenHash);
  if (!session) return null;

  const now = Date.now();
  if (new Date(session.expiresAt).getTime() <= now) {
    dropSessions((s) => s.id === session.id);
    store.save();
    return null;
  }

  const device = store.devices.find((d) => d.id === session.deviceId && !d.revokedAt);
  if (!device) {
    /* Device removed remotely -> its sessions die with it. */
    dropSessions((s) => s.id === session.id);
    store.save();
    return null;
  }

  if (now - new Date(session.lastSeenAt).getTime() > TOUCH_AFTER_MS) {
    session.lastSeenAt = new Date(now).toISOString();
    session.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    device.lastSeenAt = session.lastSeenAt;
    store.save();
  }

  const user = findUserById(session.userId);
  if (!user) return null;
  return { session, device, user };
}

function revokeSession(sessionId) {
  dropSessions((s) => s.id === sessionId);
  store.save();
}

function revokeAllSessions(userId) {
  dropSessions((s) => s.userId === userId);
  store.save();
}

/* ----------------------------------------------------------------- cookies */

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function cookieString(name, value, { maxAge } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) bits.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (process.env.NODE_ENV === 'production' || (process.env.PUBLIC_URL || '').startsWith('https')) {
    bits.push('Secure');
  }
  return bits.join('; ');
}

module.exports = {
  ACCOUNT_TYPES,
  collectionPlan,
  SESSION_COOKIE,
  DEVICE_COOKIE,
  SESSION_TTL_MS,
  normalizeEmail,
  findUserByEmail,
  findUserById,
  publicUser,
  register,
  updateProfile,
  setAccount,
  setPin,
  verifyPin,
  pinLocked,
  issueRecoveryCodes,
  useRecoveryCode,
  hashSecret,
  verifySecret,
  deviceFromRequest,
  listDevices,
  trustDevice,
  revokeDevice,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  parseCookies,
  cookieString,
  describeAgent,
  newId,
  sha256,
};
