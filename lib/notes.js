// lib/notes.js
//
// Notes are an append-only log now, not a single editable note: every
// save adds a new dated entry rather than overwriting the last one, so a
// person builds up a running journal of observations on a site over time.
// Each entry can still be edited or removed individually later.
//
// Keyed by (user, url), not by which two dates are being compared, so the
// whole log for a site follows you no matter which snapshots you're
// currently looking at. "user" isn't a login - it's a random id in a
// long-lived cookie (see server.js), enough to keep one browser's notes
// consistent without any signup. Swapping that for a real authenticated
// id later wouldn't require changing anything here.
//
// Named notes_by_url, not notes - the project's existing db already has a
// `notes` table with a different shape (id, ts_from, ts_to columns, one
// row per exact date-pair comparison). A new table name avoids colliding
// with that existing table and its data entirely.

const crypto = require('crypto');
const db = require('../db');

// An earlier version of this file created notes_by_url with a different
// shape (user_id + url as the primary key, no id column, one row per
// site). CREATE TABLE IF NOT EXISTS is a no-op against a table that
// already exists in that old shape, which is exactly what breaks every
// query below with "no such column: id". This checks the actual columns
// on disk and, if it finds that older shape, drops and recreates the
// table fresh. Safe for this project at this stage since it holds no
// notes worth preserving yet; if that's no longer true for you, back up
// data/palimpsest.db before restarting the server.
const existingColumns = db.prepare("PRAGMA table_info(notes_by_url)").all();
if (existingColumns.length && !existingColumns.some((c) => c.name === 'id')) {
  db.exec('DROP TABLE notes_by_url');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS notes_by_url (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_notes_by_url_user_url ON notes_by_url (user_id, url)');

const listStmt = db.prepare(
  'SELECT id, body, created_at, updated_at FROM notes_by_url WHERE user_id = ? AND url = ? ORDER BY created_at DESC'
);
const insertStmt = db.prepare(`
  INSERT INTO notes_by_url (id, user_id, url, body, created_at, updated_at)
  VALUES (@id, @user_id, @url, @body, @created_at, @updated_at)
`);
const updateStmt = db.prepare(
  'UPDATE notes_by_url SET body = @body, updated_at = @updated_at WHERE id = @id AND user_id = @user_id AND url = @url'
);
const deleteStmt = db.prepare('DELETE FROM notes_by_url WHERE id = ? AND user_id = ? AND url = ?');

function toNote(row) {
  return { id: row.id, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
}

function listNotes(userId, url) {
  return listStmt.all(userId, url).map(toNote);
}

function addNote(userId, url, body) {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  const now = Date.now();
  const row = { id: crypto.randomUUID(), user_id: userId, url, body, created_at: now, updated_at: now };
  insertStmt.run(row);
  return toNote(row);
}

// Returns the updated note, or null if the edit emptied it out (in which
// case the entry is deleted rather than left as a blank card).
function editNote(userId, url, id, body) {
  const trimmed = (body || '').trim();
  if (!trimmed) {
    deleteStmt.run(id, userId, url);
    return null;
  }
  const updated_at = Date.now();
  updateStmt.run({ id, user_id: userId, url, body, updated_at });
  return { id, body, updatedAt: updated_at };
}

function removeNote(userId, url, id) {
  deleteStmt.run(id, userId, url);
}

module.exports = { listNotes, addNote, editNote, removeNote };

