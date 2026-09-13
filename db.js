// db.js
// A single local SQLite file holds everything Palimpsest needs to remember:
// the list of snapshot dates for a URL, the raw HTML of snapshots we've
// already fetched, user notes, and AI insights we've already generated.
// Caching all four of these is what keeps the app fast and keeps us from
// hammering the Wayback Machine every time someone nudges the slider.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'palimpsest.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshot_lists (
    url         TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshot_html (
    cache_key   TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    html        TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    ts_from     TEXT NOT NULL,
    ts_to       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS insights (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    ts_from     TEXT NOT NULL,
    ts_to       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    sources     TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_key ON notes (url, ts_from, ts_to);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_key ON insights (url, ts_from, ts_to);
`);

module.exports = db;
