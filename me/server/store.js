'use strict';
/**
 * Durable JSON store.
 * Writes are atomic (tmp file + rename) and debounced, so a crash mid-write
 * can never leave a truncated database behind.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Kept OUTSIDE server/ on purpose: `node --watch --watch-path=server` would
   otherwise restart the process every time a payment is saved, and the restart
   races the old listener for the port (EADDRINUSE). */
/* Vercel (and Lambda) give a read-only checkout plus a private /tmp. Writing
   next to the source throws there, so serverless runs keep the file in /tmp
   instead. That keeps the app up, but /tmp is per-instance: two invocations can
   see different data, so it is not a substitute for a real database. */
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : SERVERLESS
    ? path.join(os.tmpdir(), 'jimmy-pro')
    : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = () => ({
  settings: {},
  payments: [],
  b2b: [],
  kyc: [],
  /* Identity. Added alongside the payment collections so an existing db.json
     keeps working: missing arrays simply start empty. */
  users: [],
  sessions: [],
  devices: [],
  createdAt: new Date().toISOString(),
});

let db = EMPTY();
let saveTimer = null;

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      db = EMPTY();
      flush();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
      b2b: Array.isArray(parsed.b2b) ? parsed.b2b : [],
      kyc: Array.isArray(parsed.kyc) ? parsed.kyc : [],
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      createdAt: parsed.createdAt || new Date().toISOString(),
    };
  } catch (err) {
    console.error('[store] could not read db.json, starting fresh:', err.message);
    try {
      if (fs.existsSync(DB_FILE)) {
        fs.renameSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`);
      }
    } catch (_) {
      /* ignore */
    }
    db = EMPTY();
  }
}

function flush() {
  const payload = JSON.stringify(db, null, 2);
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  /* 0600: the file can hold Daraja credentials and customer PII. */
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {
    /* best effort on platforms without POSIX modes */
  }
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  }, 40);
}

module.exports = {
  get data() {
    return db;
  },
  get filePath() {
    return DB_FILE;
  },
  get payments() {
    return db.payments;
  },
  get b2b() {
    return db.b2b;
  },
  get kyc() {
    return db.kyc;
  },
  get settings() {
    return db.settings;
  },
  get users() {
    return db.users;
  },
  get sessions() {
    return db.sessions;
  },
  get devices() {
    return db.devices;
  },
  setSettings(next) {
    db.settings = next && typeof next === 'object' ? next : {};
  },
  save,
  flush,
  load,
};
