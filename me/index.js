'use strict';
/**
 * Vercel entry point.
 *
 * Vercel's Express detection looks for a file called `index`, `app` or `server`
 * at the project root (or under `src/`) that exports the Express app. Jimmy Pro
 * keeps its server in `server/index.js`, which is none of those places, so a
 * plain deploy built the static files only and every `/api/...` request hit the
 * platform's HTML 404 - which is exactly what the UI reports as
 * "Request failed (404)".
 *
 * This file is that missing handle. `npm start` is untouched: it still runs
 * `server/index.js` directly, which binds the port.
 */
const app = require('./server/index.js');

module.exports = app;
