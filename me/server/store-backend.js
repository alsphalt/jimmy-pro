'use strict';
/**
 * Where the document lives.
 *
 * The file backend is the default and is right for a laptop, a VPS or any host
 * with a real disk. It is wrong for serverless: each instance gets its own
 * /tmp, so a session created by one instance does not exist for the next
 * request, and the browser is bounced between "Continue" and "Sign in" forever.
 *
 * A Postgres backend fixes that by giving every instance the same row. It is
 * selected with DATABASE_URL; everything above this file keeps working on a
 * plain in-memory object.
 */
const fs = require('fs');
const path = require('path');

const TABLE = 'jimmy_state';
const ROW_ID = 1;

/* ------------------------------------------------------------------ file --- */
function createFileBackend({ dir }) {
  const file = path.join(dir, 'db.json');
  return {
    kind: 'file',
    file,
    async init() {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return null;
    },
    /* Nothing to reload: this process is the only writer. */
    async read() {
      return null;
    },
    async write(doc) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/* -------------------------------------------------------------- postgres --- */
function createPgBackend({ pool }) {
  return {
    kind: 'postgres',
    async init() {
      /* Best effort: a constrained role may not own the schema, and another
         instance may create it concurrently. If the table really is missing the
         read below fails and says so. */
      try {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id integer PRIMARY KEY,
             doc text NOT NULL,
             updated_at timestamp NOT NULL DEFAULT now()
           )`
        );
        await pool.query(
          `INSERT INTO ${TABLE} (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [ROW_ID, JSON.stringify({})]
        );
      } catch (err) {
        console.warn('[store] could not prepare the table:', err.message.split('\n')[0]);
      }
      return this.read();
    },
    async read() {
      const { rows } = await pool.query(`SELECT doc FROM ${TABLE} WHERE id = $1`, [ROW_ID]);
      const raw = rows[0]?.doc;
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async write(doc) {
      await pool.query(`UPDATE ${TABLE} SET doc = $2, updated_at = now() WHERE id = $1`, [
        ROW_ID,
        JSON.stringify(doc),
      ]);
    },
  };
}

function selectBackend({ dir }) {
  const url = process.env.DATABASE_URL;
  if (!url) return createFileBackend({ dir });
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    throw new Error(
      'DATABASE_URL is set but the "pg" package is missing. Run: npm install pg'
    );
  }
  const pool = new Pool({
    connectionString: url,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    max: 3,
  });
  return createPgBackend({ pool });
}

module.exports = { createFileBackend, createPgBackend, selectBackend };
