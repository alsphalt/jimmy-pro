'use strict';
require('./env').loadEnv();

/* M-Pesa runs on East Africa Time; keep "today" and daily totals aligned. */
process.env.TZ = process.env.TZ || 'Africa/Nairobi';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const mpesa = require('./mpesa');
const endpoints = require('./endpoints');
const b2b = require('./b2b');
const kyc = require('./kyc');

store.load();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAYMENT_TTL_MS = Number(process.env.PAYMENT_TTL_MS) || 30 * 60 * 1000;

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '512kb' }));

/* ------------------------------------------------------------------ helpers */

const sseClients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function shortCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function uniqueRef() {
  let ref = `JP-${shortCode(6)}`;
  let guard = 0;
  while (store.payments.some((p) => p.ref === ref) && guard < 50) {
    ref = `JP-${shortCode(6)}`;
    guard += 1;
  }
  return ref;
}

function baseUrl(req) {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function payUrl(req, payment) {
  return `${baseUrl(req)}/pay/${payment.ref}`;
}

function decorate(req, p) {
  const s = mpesa.resolveSettings();
  return {
    ...p,
    phonePretty: mpesa.prettyPhone(p.phone),
    payerPhonePretty: mpesa.prettyPhone(p.payerPhone),
    payUrl: payUrl(req, p),
    businessName: s.businessName,
    expired: p.status === 'pending' && Date.now() - new Date(p.createdAt).getTime() > PAYMENT_TTL_MS,
  };
}

function findPayment(idOrRef) {
  const needle = String(idOrRef || '').toLowerCase();
  return store.payments.find(
    (p) => p.id.toLowerCase() === needle || String(p.ref).toLowerCase() === needle
  );
}

function applyOutcome(payment, { status, resultCode, resultDesc, receipt, phone }) {
  payment.status = status;
  payment.resultCode = String(resultCode);
  payment.resultDesc = resultDesc || mpesa.resultMessage(resultCode);
  if (status === 'success') {
    payment.mpesaReceipt = receipt || null;
    payment.completedAt = new Date().toISOString();
    if (phone) payment.payerPhone = phone;
  } else {
    payment.completedAt = new Date().toISOString();
  }
  payment.updatedAt = new Date().toISOString();
  store.save();
  broadcast('payment', { payment: payment });
  return payment;
}


function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function requireAdmin(req, res, next) {
  const pin = (process.env.ADMIN_PIN || '').trim();
  if (!pin) return next();
  const supplied = req.get('x-admin-pin') || req.body?.adminPin || '';
  if (supplied === pin) return next();
  return res.status(401).json({ error: 'A valid admin PIN is required to change settings.' });
}

/* There is no demo mode: any endpoint that would move money refuses to run
   until real Daraja credentials are saved. */
function ensureLive(res) {
  const s = mpesa.resolveSettings();
  if (s.live) return true;
  res.status(503).json({
    error:
      'M-Pesa is not configured. Save your consumer key, secret, passkey and shortcode in Settings first.',
    missing: s.missing,
  });
  return false;
}

/* One live prompt per payment at a time. A second push overwrites
   checkoutRequestId/merchantRequestId, which orphans the first prompt: if the
   customer then pays the *first* prompt, its callback matches nothing and a
   settled payment stays "pending" forever. */
const PUSH_GRACE_MS = 90 * 1000;

function pushInFlight(payment) {
  if (payment.status !== 'pending' || !payment.checkoutRequestId) return false;
  const last = new Date(payment.lastPushAt || payment.updatedAt || payment.createdAt).getTime();
  return Number.isFinite(last) && Date.now() - last < PUSH_GRACE_MS;
}

function isExpired(payment) {
  return Date.now() - new Date(payment.createdAt).getTime() > PAYMENT_TTL_MS;
}

/* --------------------------------------------------------------- SSE stream */

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  sseClients.add(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      /* noop */
    }
  }, 25000);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

/* -------------------------------------------------------------------- system */

/* Names only, never values - enough to tell "env not applied" from "wrong key". */
function configSource() {
  const envKeys = [
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_PASSKEY',
    'MPESA_SHORTCODE',
    'MPESA_CALLBACK_URL',
    'PUBLIC_URL',
  ].filter((k) => String(process.env[k] || '').trim());
  const savedKeys = Object.keys(store.settings || {});
  return {
    env: envKeys,
    savedInApp: savedKeys,
    using: envKeys.length ? 'environment' : savedKeys.length ? 'app settings' : 'nothing',
  };
}

app.get('/api/health', (req, res) => {
  const s = mpesa.resolveSettings();
  res.json({
    ok: true,
    name: 'Jimmy Pro',
    version: require('../package.json').version,
    mode: s.live ? 'live' : 'unconfigured',
    environment: s.environment,
    missing: s.missing,
    config: configSource(),
    callbackUrlSet: Boolean(s.callbackUrl),
    uptime: Math.round(process.uptime()),
    payments: store.payments.length,
    time: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------------ settings */

app.get('/api/settings', (req, res) => {
  const s = mpesa.resolveSettings();
  res.json({
    ...mpesa.publicSettings(),
    callbackSuggestion: `${baseUrl(req)}/api/mpesa/callback`,
    publicUrl: baseUrl(req),
    adminPinRequired: Boolean((process.env.ADMIN_PIN || '').trim()),
    settlement: {
      /* Where the money actually lands, and where the owner sits. */
      receiver: s.shortcode,
      receiverType: s.transactionType === 'CustomerBuyGoodsOnline' ? 'Buy Goods till' : 'Paybill',
      ownerMsisdn: s.ownerMsisdn,
      canSettleToOwnerMsisdn: false,
      note:
        'STK Push settles to the shortcode. A personal number can only receive funds ' +
        'through a B2C payout (separate Daraja product + approval).',
    },
  });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const locked = mpesa.envLockedFields();
  const next = { ...store.settings };

  const editable = [
    'environment',
    'consumerKey',
    'consumerSecret',
    'passkey',
    'shortcode',
    'transactionType',
    'callbackUrl',
    'businessName',
    'initiatorName',
    'senderShortcode',
    'b2bCommandId',
    'resultUrl',
    'timeoutUrl',
    'kycShortcode',
  ];

  for (const key of editable) {
    if (locked[key]) continue;
    if (b[key] === undefined) continue;
    if (key === 'consumerSecret' || key === 'passkey' || key === 'consumerKey') {
      /* an empty string means "leave the stored secret alone" */
      if (b[key] === '' || b[key] === null) continue;
      next[key] = String(b[key]).trim();
      continue;
    }
    if (key === 'environment') {
      next[key] = String(b[key]).toLowerCase() === 'production' ? 'production' : 'sandbox';
      continue;
    }
    if (key === 'transactionType') {
      next[key] =
        b[key] === 'CustomerBuyGoodsOnline' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline';
      continue;
    }
    next[key] = String(b[key]).trim();
  }

  /* A missing shortcode in sandbox would break every request: default it. */
  if (!next.shortcode && next.environment !== 'production') next.shortcode = '174379';

  for (const key of ['callbackUrl', 'resultUrl', 'timeoutUrl']) {
    if (next[key] && !/^https?:\/\//i.test(next[key])) {
      return res.status(400).json({
        error: `${key === 'callbackUrl' ? 'Callback' : key === 'resultUrl' ? 'Result' : 'Timeout'} URL must start with http:// or https://`,
      });
    }
  }

  store.setSettings(next);
  store.save();
  mpesa.getAccessToken({ force: true }).catch(() => {});
  res.json({ ok: true, settings: mpesa.publicSettings() });
});

app.post('/api/settings/test', requireAdmin, async (req, res) => {
  const s = mpesa.resolveSettings();
  if (!s.consumerKey || !s.consumerSecret) {
    return res.status(400).json({
      ok: false,
      error: 'Add your consumer key and consumer secret first.',
    });
  }
  try {
    const token = await mpesa.getAccessToken({ force: true });
    return res.json({
      ok: true,
      message: 'Safaricom accepted your credentials.',
      environment: s.environment,
      tokenPreview: `${token.slice(0, 6)}...${token.slice(-4)}`,
      expiresIn: 3599,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/reset', requireAdmin, (req, res) => {
  store.setSettings({});
  store.save();
  res.json({ ok: true, settings: mpesa.publicSettings() });
});

/* ------------------------------------------------------------------ payments */

app.post('/api/payments', async (req, res) => {
  if (!ensureLive(res)) return;
  const b = req.body || {};

  /* Daraja settles an STK push to a shortcode/till, never to a personal handset.
     Refuse the request loudly instead of quietly ignoring the field. */
  const phoneTarget = b.settleToMsisdn || b.receiverMsisdn || b.payToMsisdn;
  if (phoneTarget && mpesa.normalizePhone(phoneTarget)) {
    return res.status(400).json({
      error:
        'Your M-Pesa number cannot be the receiver of an STK push. Money settles to the shortcode ' +
        `(${mpesa.resolveSettings().shortcode}). To land funds on a personal number you need a B2C ` +
        'payout after collection, or a Buy Goods till registered to that number.',
    });
  }

  const requestedMode = b.mode === 'link' ? 'link' : 'prompt';

  /* A shared link has no payer yet - the payer supplies their number. */
  let phone = null;
  if (requestedMode === 'prompt') {
    phone = mpesa.normalizePhone(b.phone);
    if (!phone) {
      return res.status(400).json({
        error: 'Enter a valid Kenyan number, e.g. 0712 345 678 or 254712345678.',
      });
    }
  }

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: 'Amount must be at least KES 1.' });
  }
  if (amount > 250000) {
    return res.status(400).json({ error: 'Amount cannot exceed KES 250,000 per request.' });
  }

  const payment = {
    id: crypto.randomUUID(),
    ref: uniqueRef(),
    phone,
    payerPhone: null,
    amount: Math.round(amount),
    accountReference: String(b.accountReference || 'JimmyPro').slice(0, 60),
    description: String(b.description || 'Payment request').slice(0, 140),
    status: 'pending',
    mode: 'live',
    flow: requestedMode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    checkoutRequestId: null,
    merchantRequestId: null,
    mpesaReceipt: null,
    resultCode: null,
    resultDesc: null,
    attempts: 0,
    history: [],
  };

  /* Share link: nothing is sent until the payer opens the link themselves. */
  if (requestedMode === 'link') {
    payment.history.push({ at: payment.createdAt, event: 'link_created' });
    store.payments.unshift(payment);
    store.save();
    broadcast('payment', { payment });
    return res.status(201).json({ payment: decorate(req, payment), linkOnly: true });
  }

  try {
    const push = await mpesa.stkPush(payment);
    payment.checkoutRequestId = push.checkoutRequestId;
    payment.merchantRequestId = push.merchantRequestId;
    payment.attempts = 1;
    payment.resultDesc = 'Prompt sent - waiting for the customer to enter their PIN';
    payment.history.push({
      at: new Date().toISOString(),
      event: 'stk_push_sent',
      detail: push.responseDescription,
    });
    store.payments.unshift(payment);
    store.save();
    broadcast('payment', { payment });
    return res.status(201).json({ payment: decorate(req, payment) });
  } catch (err) {
    payment.status = 'failed';
    payment.resultCode = 'request_error';
    payment.resultDesc = err.message;
    payment.completedAt = new Date().toISOString();
    payment.history.push({ at: payment.completedAt, event: 'stk_push_failed', detail: err.message });
    store.payments.unshift(payment);
    store.save();
    broadcast('payment', { payment });
    return res.status(502).json({ error: err.message, payment: decorate(req, payment) });
  }
});

app.get('/api/payments', (req, res) => {
  const { status, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  let rows = store.payments;

  if (status && status !== 'all') {
    rows = rows.filter((p) => p.status === status);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((p) =>
      [p.ref, p.phone, p.payerPhone, p.accountReference, p.description, p.mpesaReceipt]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    );
  }

  res.json({
    payments: rows.slice(0, limit).map((p) => decorate(req, p)),
    total: rows.length,
  });
});

app.get('/api/payments/:id', (req, res) => {
  const payment = findPayment(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  res.json({ payment: decorate(req, payment) });
});

app.post('/api/payments/:id/query', async (req, res) => {
  const payment = findPayment(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });

  if (payment.status !== 'pending') {
    return res.json({ payment: decorate(req, payment), unchanged: true });
  }

  try {
    const result = await mpesa.stkQuery(payment);
    if (result.pending) {
      payment.resultDesc = result.description || 'Waiting for the customer';
      payment.updatedAt = new Date().toISOString();
      store.save();
      return res.json({
        payment: decorate(req, payment),
        checked: true,
        message: payment.resultDesc,
      });
    }
    applyOutcome(payment, {
      status: result.status,
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
    });
    return res.json({ payment: decorate(req, payment), checked: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.post('/api/payments/:id/retry', async (req, res) => {
  if (!ensureLive(res)) return;
  const original = findPayment(req.params.id);
  if (!original) return res.status(404).json({ error: 'Payment not found.' });
  if (!original.phone) {
    return res.status(400).json({
      error: 'This request has no phone number yet. Share its pay link instead of prompting.',
    });
  }

  const clone = {
    ...original,
    id: crypto.randomUUID(),
    ref: uniqueRef(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    checkoutRequestId: null,
    merchantRequestId: null,
    mpesaReceipt: null,
    resultCode: null,
    resultDesc: null,
    attempts: 0,
    retryOf: original.ref,
    history: [{ at: new Date().toISOString(), event: 'retry_created', detail: `Retry of ${original.ref}` }],
  };

  try {
    const push = await mpesa.stkPush(clone);
    clone.checkoutRequestId = push.checkoutRequestId;
    clone.merchantRequestId = push.merchantRequestId;
    clone.attempts = 1;
    clone.resultDesc = 'Prompt sent - waiting for the customer to enter their PIN';
    store.payments.unshift(clone);
    store.save();
    broadcast('payment', { payment: clone });
    return res.status(201).json({ payment: decorate(req, clone) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});


app.delete('/api/payments/:id', (req, res) => {
  const index = store.payments.findIndex(
    (p) => p.id === req.params.id || String(p.ref).toLowerCase() === String(req.params.id).toLowerCase()
  );
  if (index === -1) return res.status(404).json({ error: 'Payment not found.' });
  const [removed] = store.payments.splice(index, 1);
  store.save();
  broadcast('payment_deleted', { id: removed.id, ref: removed.ref });
  res.json({ ok: true, deleted: removed.ref });
});

/* --------------------------------------------------------------------- stats */

app.get('/api/stats', (req, res) => {
  const payments = store.payments;
  const success = payments.filter((p) => p.status === 'success');
  const pending = payments.filter((p) => p.status === 'pending');
  const failed = payments.filter((p) => ['failed', 'cancelled', 'timeout'].includes(p.status));
  const collected = success.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = payments.filter((p) => new Date(p.createdAt) >= startOfToday);
  const todayCollected = today
    .filter((p) => p.status === 'success')
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  /* last 7 days series */
  const series = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const next = new Date(day.getTime() + 86400000);
    const amount = payments
      .filter(
        (p) =>
          p.status === 'success' && new Date(p.createdAt) >= day && new Date(p.createdAt) < next
      )
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    series.push({ date: day.toISOString().slice(0, 10), amount });
  }

  const settled = success.length + failed.length;
  res.json({
    collected,
    todayCollected,
    count: payments.length,
    successCount: success.length,
    pendingCount: pending.length,
    failedCount: failed.length,
    todayCount: today.length,
    successRate: settled ? Math.round((success.length / settled) * 100) : 0,
    average: success.length ? Math.round(collected / success.length) : 0,
    series,
    mode: mpesa.resolveSettings().live ? 'live' : 'unconfigured',
  });
});

/* ------------------------------------------------------------- business APIs */

app.get('/api/endpoints', (req, res) => {
  const s = mpesa.resolveSettings();
  res.json({
    environment: s.environment,
    baseUrl: endpoints.baseUrl(s.environment),
    endpoints: endpoints.describe(s.environment),
    b2bCommands: b2b.COMMANDS,
    identifierTypes: b2b.IDENTIFIER_TYPES,
    defaults: {
      resultUrl: s.resultUrl || `${baseUrl(req)}/api/b2b/callback`,
      timeoutUrl: s.timeoutUrl || `${baseUrl(req)}/api/b2b/timeout`,
      partyA: s.senderShortcode,
      initiatorName: s.initiatorName,
      kycShortcode: s.kycShortcode,
      commandId: s.b2bCommandId,
    },
    securityCredential: {
      ready: Boolean(mpesa.publicSettings().hasSecurityCredential),
      certificate: mpesa.publicSettings().certificate,
    },
  });
});

/* ------------------------------------------------------------------- B2B -- */

function decorateB2b(p) {
  return {
    ...p,
    commandLabel: (b2b.COMMANDS.find((c) => c.id === p.commandId) || {}).label || p.commandId,
  };
}

app.post('/api/b2b/payments', async (req, res) => {
  if (!ensureLive(res)) return;
  const s = mpesa.resolveSettings();
  const body = req.body || {};

  const record = {
    id: crypto.randomUUID(),
    ref: `BP-${shortCode(6)}`,
    amount: Math.round(Number(body.amount) || 0),
    partyA: String(body.partyA || s.senderShortcode || ''),
    partyB: String(body.partyB || '').replace(/\s/g, ''),
    commandId: String(body.commandId || s.b2bCommandId || 'BusinessPayBill'),
    senderIdentifierType: String(body.senderIdentifierType || '4'),
    receiverIdentifierType: String(body.receiverIdentifierType || '4'),
    accountReference: String(body.accountReference || 'JimmyPro').slice(0, 60),
    remarks: String(body.remarks || 'B2B payment').slice(0, 140),
    status: 'pending',
    mode: 'live',
    conversationId: null,
    originatorConversationId: null,
    transactionId: null,
    resultCode: null,
    resultDesc: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    raw: null,
  };

  if (!Number.isFinite(record.amount) || record.amount < 1) {
    return res.status(400).json({ error: 'Amount must be at least KES 1.' });
  }
  if (!/^\d{5,7}$/.test(record.partyB)) {
    return res.status(400).json({ error: 'Receiver shortcode (Party B) must be 5-7 digits.' });
  }
  if (!b2b.COMMANDS.some((c) => c.id === record.commandId)) {
    return res.status(400).json({ error: 'Unknown CommandID.' });
  }

  try {
    const result = await b2b.sendPayment({
      amount: record.amount,
      partyA: record.partyA,
      partyB: record.partyB,
      commandId: record.commandId,
      senderIdentifierType: record.senderIdentifierType,
      receiverIdentifierType: record.receiverIdentifierType,
      accountReference: record.accountReference,
      remarks: record.remarks,
      resultUrl: body.resultUrl || s.resultUrl || `${baseUrl(req)}/api/b2b/callback`,
      timeoutUrl: body.timeoutUrl || s.timeoutUrl || `${baseUrl(req)}/api/b2b/timeout`,
      initiatorName: body.initiatorName || s.initiatorName,
      securityCredential: body.securityCredential,
    });

    record.conversationId = result.conversationId;
    record.originatorConversationId = result.originatorConversationId;
    record.resultDesc = result.responseDescription;
    record.raw = { response: result.raw, request: result.request };
    record.updatedAt = new Date().toISOString();
    store.b2b.unshift(record);
    store.save();
    broadcast('b2b', { payment: record });
    return res.status(201).json({ payment: decorateB2b(record) });
  } catch (err) {
    record.status = 'failed';
    record.resultCode = 'request_error';
    record.resultDesc = err.message;
    record.completedAt = new Date().toISOString();
    record.updatedAt = record.completedAt;
    store.b2b.unshift(record);
    store.save();
    broadcast('b2b', { payment: record });
    return res.status(err.status === 400 ? 400 : 502).json({ error: err.message, payment: decorateB2b(record) });
  }
});

app.get('/api/b2b/payments', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    payments: store.b2b.slice(0, limit).map(decorateB2b),
    total: store.b2b.length,
  });
});

app.post('/api/b2b/payments/:id/refresh', (req, res) => {
  const payment = store.b2b.find((p) => p.id === req.params.id || p.ref === req.params.id);
  if (!payment) return res.status(404).json({ error: 'B2B payment not found.' });
  res.json({ payment: decorateB2b(payment) });
});

app.delete('/api/b2b/payments/:id', (req, res) => {
  const index = store.b2b.findIndex((p) => p.id === req.params.id || p.ref === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'B2B payment not found.' });
  const [removed] = store.b2b.splice(index, 1);
  store.save();
  broadcast('b2b_deleted', { id: removed.id });
  res.json({ ok: true, deleted: removed.ref });
});

app.post('/api/b2b/callback', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const parsed = b2b.parseResult(req.body);
  if (!parsed) {
    console.warn('[b2b callback] unrecognised body', JSON.stringify(req.body).slice(0, 400));
    return;
  }
  const payment =
    store.b2b.find((p) => p.conversationId === parsed.conversationId) ||
    store.b2b.find((p) => p.originatorConversationId === parsed.originatorConversationId);

  if (!payment) {
    console.warn('[b2b callback] no record for', parsed.conversationId);
    return;
  }
  if (payment.status !== 'pending') return;

  payment.status = parsed.resultCode === '0' ? 'success' : 'failed';
  payment.resultCode = parsed.resultCode;
  payment.resultDesc = parsed.resultDesc;
  payment.transactionId =
    parsed.transactionId || parsed.params.TransactionReceipt || payment.transactionId;
  payment.completedAt = new Date().toISOString();
  payment.updatedAt = payment.completedAt;
  payment.raw = { ...(payment.raw || {}), result: parsed };
  store.save();
  broadcast('b2b', { payment });
  console.log(`[b2b callback] ${payment.ref} -> ${payment.status}`);
});

app.post('/api/b2b/timeout', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const id = req.body?.Result?.ConversationID;
  const payment = store.b2b.find((p) => p.conversationId === id);
  if (payment && payment.status === 'pending') {
    payment.status = 'failed';
    payment.resultCode = 'timeout';
    payment.resultDesc = 'Queue timeout: no response from M-Pesa';
    payment.completedAt = new Date().toISOString();
    payment.updatedAt = payment.completedAt;
    store.save();
    broadcast('b2b', { payment });
  }
});

/* ------------------------------------------------------------------- KYC -- */

function maskId(idNumber) {
  const value = String(idNumber || '');
  if (value.length <= 4) return value;
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function decorateKyc(check) {
  return { ...check, idNumberMasked: maskId(check.idNumber) };
}

app.post('/api/kyc/validate', async (req, res) => {
  if (!ensureLive(res)) return;
  const s = mpesa.resolveSettings();
  const body = req.body || {};
  const msisdn = mpesa.normalizePhone(body.msisdn);

  if (!msisdn) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
  }
  const idNumber = String(body.idNumber || '').trim();
  if (!/^[A-Za-z0-9]{5,12}$/.test(idNumber)) {
    return res.status(400).json({ error: 'ID number should be 5-12 letters or digits.' });
  }
  const idType = String(body.idType || '01').trim();

  const check = {
    id: crypto.randomUUID(),
    ref: `KY-${shortCode(6)}`,
    msisdn,
    idNumber,
    idType,
    status: 'pending',
    code: null,
    description: null,
    mode: 'live',
    createdAt: new Date().toISOString(),
    raw: null,
  };

  try {
    const result = await kyc.validateId({
      msisdn,
      idNumber,
      idType,
      shortCode: body.shortCode || s.kycShortcode,
    });
    check.status = result.success ? 'valid' : 'invalid';
    check.code = result.code;
    check.description = result.description;
    check.raw = result.raw;
    store.kyc.unshift(check);
    store.save();
    broadcast('kyc', { check });
    return res.status(201).json({ check: decorateKyc(check) });
  } catch (err) {
    check.status = 'error';
    check.description = err.message;
    store.kyc.unshift(check);
    store.save();
    broadcast('kyc', { check });
    return res.status(err.status === 400 ? 400 : 502).json({
      error: err.message,
      check: decorateKyc(check),
    });
  }
});

app.get('/api/kyc/checks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    checks: store.kyc.slice(0, limit).map(decorateKyc),
    total: store.kyc.length,
  });
});

app.delete('/api/kyc/checks/:id', (req, res) => {
  const index = store.kyc.findIndex((c) => c.id === req.params.id || c.ref === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'KYC check not found.' });
  const [removed] = store.kyc.splice(index, 1);
  store.save();
  broadcast('kyc_deleted', { id: removed.id });
  res.json({ ok: true, deleted: removed.ref });
});

/* ---------------------------------------------------------------- public pay */

const promptHits = new Map();
/* Public endpoint: one entry per source IP, forever, would grow without bound. */
function prunePromptHits(now) {
  if (promptHits.size < 500) return;
  for (const [key, hits] of promptHits) {
    if (!hits.some((t) => now - t < 60000)) promptHits.delete(key);
  }
}

function rateLimit(req, res, next) {
  const key = req.ip || 'anon';
  const now = Date.now();
  prunePromptHits(now);
  const bucket = (promptHits.get(key) || []).filter((t) => now - t < 60000);
  if (bucket.length >= 6) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  }
  bucket.push(now);
  promptHits.set(key, bucket);
  return next();
}

app.get('/api/public/pay/:ref', (req, res) => {
  const payment = findPayment(req.params.ref);
  if (!payment) return res.status(404).json({ error: 'This payment link is not valid.' });
  const s = mpesa.resolveSettings();
  res.json({
    ref: payment.ref,
    businessName: s.businessName,
    amount: payment.amount,
    accountReference: payment.accountReference,
    description: payment.description,
    status: payment.status,
    mode: payment.mode,
    createdAt: payment.createdAt,
    completedAt: payment.completedAt,
    mpesaReceipt: payment.mpesaReceipt,
    expired: Date.now() - new Date(payment.createdAt).getTime() > PAYMENT_TTL_MS,
  });
});

app.post('/api/public/pay/:ref/prompt', rateLimit, async (req, res) => {
  if (!ensureLive(res)) return;
  const payment = findPayment(req.params.ref);
  if (!payment) return res.status(404).json({ error: 'This payment link is not valid.' });
  if (payment.status !== 'pending') {
    return res.status(409).json({ error: `This request is already ${payment.status}.` });
  }
  /* The payer page hides the button once expired; enforce it here too, or a
     direct POST keeps prompting real phones from a dead link. */
  if (isExpired(payment)) {
    return res.status(410).json({
      error: 'This payment request has expired. Ask the owner for a new link.',
      expired: true,
    });
  }
  if (pushInFlight(payment)) {
    return res.status(409).json({
      error: 'A prompt is already on its way to that phone. Wait for it to arrive.',
      pendingPrompt: true,
    });
  }
  const phone = mpesa.normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
  }

  try {
    const push = await mpesa.stkPush({ ...payment, phone });
    payment.payerPhone = phone;
    payment.checkoutRequestId = push.checkoutRequestId;
    payment.merchantRequestId = push.merchantRequestId;
    payment.lastPushAt = new Date().toISOString();
    payment.attempts = (payment.attempts || 0) + 1;
    payment.history.push({ at: new Date().toISOString(), event: 'stk_push_sent', detail: phone });
    store.save();
    broadcast('payment', { payment });
    return res.json({ ok: true, message: push.customerMessage || 'Prompt sent to your phone.' });
  } catch (err) {
    /* Keep the attempt visible to the owner: the link stays reusable, but the
       failed try (and the number it targeted) is part of the record. */
    payment.history.push({ at: new Date().toISOString(), event: 'stk_push_failed', detail: `${phone}: ${err.message}` });
    payment.updatedAt = new Date().toISOString();
    store.save();
    broadcast('payment', { payment });
    return res.status(502).json({ error: err.message });
  }
});

app.get('/pay/:ref', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pay.html'));
});

/* ----------------------------------------------------------------- callbacks */

app.post('/api/mpesa/callback', (req, res) => {
  /* Always ACK: Safaricom retries aggressively on non-200 answers. */
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const parsed = mpesa.parseStkCallback(req.body);
  if (!parsed) {
    console.warn('[callback] unrecognised body', JSON.stringify(req.body).slice(0, 400));
    return;
  }

  const payment =
    store.payments.find((p) => p.checkoutRequestId === parsed.checkoutRequestId) ||
    store.payments.find((p) => p.merchantRequestId === parsed.merchantRequestId);

  if (!payment) {
    console.warn('[callback] no payment for', parsed.checkoutRequestId);
    return;
  }
  if (payment.status !== 'pending') return;

  /* Safaricom echoes the settled amount. Keep the record if it differs from
     what we asked for - that is a reconciliation signal, not a silent detail. */
  const settledAmount = parsed.amount == null ? null : Number(parsed.amount);
  if (Number.isFinite(settledAmount) && settledAmount !== Number(payment.amount)) {
    payment.amountMismatch = { expected: Number(payment.amount), settled: settledAmount };
    console.warn(
      `[callback] ${payment.ref} amount mismatch: asked ${payment.amount}, settled ${settledAmount}`
    );
  }

  applyOutcome(payment, {
    status: mpesa.mapStatus(parsed.resultCode),
    resultCode: parsed.resultCode,
    resultDesc: parsed.resultDesc,
    receipt: parsed.mpesaReceipt,
    phone: parsed.phone ? String(parsed.phone) : undefined,
  });
  payment.history.push({
    at: new Date().toISOString(),
    event: 'callback',
    detail: parsed.resultDesc,
    ...(payment.amountMismatch ? { amountMismatch: payment.amountMismatch } : {}),
  });
  store.save();
  console.log(`[callback] ${payment.ref} -> ${payment.status}`);
});

app.post('/api/mpesa/timeout', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const id = req.body?.Body?.stkCallback?.CheckoutRequestID;
  const payment = store.payments.find((p) => p.checkoutRequestId === id);
  if (payment && payment.status === 'pending') {
    applyOutcome(payment, {
      status: 'timeout',
      resultCode: '1037',
      resultDesc: 'Queue timeout: no response from the customer',
    });
  }
});

/* --------------------------------------------------------------------- misc */

app.get('/api/export.csv', (req, res) => {
  const header = [
    'Reference',
    'Created',
    'Phone',
    'Amount',
    'Account',
    'Description',
    'Status',
    'ResultCode',
    'Receipt',
    'Mode',
  ];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const p of store.payments) {
    lines.push(
      [
        p.ref,
        p.createdAt,
        p.phone,
        p.amount,
        p.accountReference,
        p.description,
        p.status,
        p.resultCode,
        p.mpesaReceipt,
        p.mode,
      ]
        .map(escape)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="jimmy-pro-payments.csv"');
  res.send(lines.join('\n'));
});

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    etag: true,
    /* Always revalidate: a stale shell would keep old JS after an update. */
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Unknown API route.' });
  }
  return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error.' });
});

function printBanner() {
  const s = mpesa.resolveSettings();
  console.log('');
  console.log('  Jimmy Pro');
  console.log('  ---------------------------------------------');
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Mode:     ${s.live ? 'LIVE (M-Pesa calls are real)' : 'NOT CONFIGURED (add Daraja credentials)'}`);
  if (!s.live) console.log(`  Missing:  ${s.missing.join(', ')}`);
  console.log(`  Env:      ${s.environment}`);
  console.log(`  Callback: ${s.callbackUrl || '(not set)'}`);
  console.log(`  Data:     ${store.filePath || '(default)'}`);
  if (s.ownerMsisdn) console.log(`  Owner:    ${s.ownerMsisdn}`);
  console.log('  ---------------------------------------------');
  console.log('');
}

/* `node --watch` restarts by spawning a new process before the old listener is
   fully closed, which surfaces as EADDRINUSE on :3000. Retry briefly instead of
   crashing with a stack trace, and only give up if the port is genuinely taken. */
let listenTries = 0;
const server = app.listen(PORT, printBanner);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenTries < 12) {
    listenTries += 1;
    if (listenTries === 1) {
      console.log(`  Port ${PORT} is still held by the previous process - retrying...`);
    }
    setTimeout(() => server.listen(PORT), 250);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use by another process.\n` +
        `  Stop it (lsof -i :${PORT} , then kill <pid>) or start on another port:\n` +
        `    PORT=3001 npm start\n`
    );
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  try {
    store.flush();
  } catch (_) {
    /* noop */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
