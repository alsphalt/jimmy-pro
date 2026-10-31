'use strict';
/**
 * Durable JSON store.
 * Writes are atomic (tmp file + rename) and debounced, so a crash mid-write
 * can never leave a truncated database behind.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectBackend } = require('./store-backend');

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

/* One document, two possible homes: a file, or a single Postgres row when
   DATABASE_URL is set. See store-backend.js for why serverless needs the latter. */
const backend = selectBackend({ dir: DATA_DIR });

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
let writeChain = Promise.resolve();

/* Accepts a document from any source and keeps only what this build understands,
   so an older or partially-written file can never crash a request. */
function adopt(parsed) {
  const next = parsed && typeof parsed === 'object' ? parsed : {};
  db = {
    settings: next.settings && typeof next.settings === 'object' ? next.settings : {},
    payments: Array.isArray(next.payments) ? next.payments : [],
    b2b: Array.isArray(next.b2b) ? next.b2b : [],
    kyc: Array.isArray(next.kyc) ? next.kyc : [],
    users: Array.isArray(next.users) ? next.users : [],
    sessions: Array.isArray(next.sessions) ? next.sessions : [],
    devices: Array.isArray(next.devices) ? next.devices : [],
    createdAt: next.createdAt || new Date().toISOString(),
  };
}

let ready = null;

/** Connect and pull the document once; safe to call from every request. */
function init() {
  if (!ready) {
    ready = (async () => {
      const doc = await backend.init();
      if (doc) adopt(doc);
      return true;
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * With shared storage another instance may have written since we loaded, so each
 * request re-reads the row. With a file this is a no-op: this process is the only
 * writer.
 */
async function refresh() {
  if (backend.kind !== 'postgres') return;
  await init();
  const doc = await backend.read();
  if (doc) adopt(doc);
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      db = EMPTY();
      flush();
      return;
    }
    adopt(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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
  if (backend.kind === 'postgres') {
    /* Write-through: a session created here must be visible to the next request,
       which may land on another instance. Serialise writes so the last state
       wins rather than an older one overwriting a newer one. */
    writeChain = writeChain
      .then(() => backend.write(db))
      .catch((err) => console.error('[store] write failed:', err.message));
    return;
  }
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
  init,
  refresh,
  backend: backend.kind,
  get data() {
    return db;
  },
  get filePath() {
    return backend.kind === 'postgres' ? null : DB_FILE;
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
