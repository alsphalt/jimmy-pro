'use strict';
/**
 * Durable JSON store.
 * Writes are atomic (tmp file + rename) and debounced, so a crash mid-write
 * can never leave a truncated database behind.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = () => ({
  settings: {},
  payments: [],
  b2b: [],
  kyc: [],
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
  fs.writeFileSync(tmp, payload, 'utf8');
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
  setSettings(next) {
    db.settings = next && typeof next === 'object' ? next : {};
  },
  save,
  flush,
  load,
};
