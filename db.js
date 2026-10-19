// db.js
//
// Turso (libSQL) replaces the local SQLite file. The SQL itself barely
// changes anywhere in this project - it's still SQLite under the hood -
// the real change everywhere else is that every query is now async
// (await db.execute(...)) instead of synchronous (db.prepare(...).get()).
//
// Needs two environment variables (see the deploy steps for how to get
// them): TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
//
// Every table's schema lives in one place here (initSchema) rather than
// scattered across each lib file the way the old sqlite version did.
// That's not just tidiness - CREATE TABLE is an async call now, so it has
// to actually finish before the server starts accepting requests.
// server.js awaits initSchema() once at startup instead of every file
// quietly creating its own table as a side effect of being required.

require('dotenv').config();
const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error(
    "Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN. Set both in your .env locally, or in your host's environment variables once deployed."
  );
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initSchema() {
  // Cache of CDX (snapshot list) lookups, one row per traced site.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS snapshot_lists (
      url TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  // Cache of individual archived HTML fetches, one row per url+timestamp.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS snapshot_html (
      cache_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      html TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  // Cache of generated AI insights, one row per url+date-pair.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      ts_from TEXT NOT NULL,
      ts_to TEXT NOT NULL,
      summary TEXT NOT NULL,
      sources TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // The measured change between each capture and the one before it: the
  // numbers the rail, the dashboard and the film's caption are all drawn from.
  //
  // They are stored rather than recomputed because computing them is the
  // expensive half of reading a record, one diff of two captured pages costs
  // about 66ms, so a 741-capture history is roughly fifty seconds of parsing  
  // and because the answer never changes. The documents are immutable and so
  // is the difference between two of them, so this is a cache in the strict
  // sense: reproducible from snapshot_html, permanent once written.
  //
  // One row per capture (the one on the right of the pair), keyed the same way
  // snapshot_html is, so a capture and its numbers can be addressed together.
  // `version` is the diff engine's shape: bumping it retires every row rather
  // than mixing numbers measured by two different rules.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS record_steps (
      cache_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      counts TEXT NOT NULL,
      tags TEXT NOT NULL,
      totals INTEGER NOT NULL,
      version INTEGER NOT NULL,
      computed_at INTEGER NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_record_steps_url ON record_steps (url)');
  // Every record read filters captures by site: without this the database
  // scans every site's captures for every request, and a record request
  // costs the whole table rather than the one site asked for.
  await db.execute('CREATE INDEX IF NOT EXISTS idx_snapshot_html_url ON snapshot_html (url, timestamp)');

  // Cached claim reports: one row per traced address. The payload is the whole
  // dossier (threads, events, scores, charts), and the version is what makes an
  // old row safe to ignore when the analysis rules change, the report is
  // rebuilt from the same cached captures at no Archive cost, so the only
  // thing a version bump costs is one pass over rows we already have.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS claim_reports (
      url TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      captures INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  // The notes log: many rows per (user, url), an append-only journal.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes_by_url (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_notes_by_url_user_url ON notes_by_url (user_id, url)');

  // The project's very first notes table (id, ts_from, ts_to columns, one
  // row per exact date-pair comparison) is deliberately not recreated
  // here. Nothing in the app has referenced it for a while now - this is
  // a clean start on Turso rather than dragging dead schema along.
}

// On a long-running server initSchema is called once at boot. On Vercel
// there is no boot, so ready() is what gets awaited instead: it runs the
// schema exactly once per container and hands the same promise to every
// other request that lands in that container. A failed attempt clears the
// cached promise so the next request retries rather than being stuck
// replaying one rejection forever.
let schemaPromise = null;

function ready() {
  if (!schemaPromise) {
    schemaPromise = initSchema().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

module.exports = { db, initSchema, ready };
