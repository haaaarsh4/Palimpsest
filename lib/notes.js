// lib/notes.js
//
// Notes are an append-only log: every save adds a new dated entry rather
// than overwriting the last one, so a person builds up a running journal
// of observations on a site over time. Each entry can still be edited or
// removed individually later.
//
// Keyed by (user, url), not by which two dates are being compared, so the
// whole log for a site follows a person no matter which two snapshots
// they're currently looking at. "user" isn't a login - it's a random id
// in a long-lived cookie (see server.js), enough to keep one browser's
// notes consistent without any signup.

const crypto = require('crypto');
const { db } = require('../db');

function toNote(row) {
  return { id: row.id, body: row.body, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

async function listNotes(userId, url) {
  const result = await db.execute({
    sql: 'SELECT id, body, created_at, updated_at FROM notes_by_url WHERE user_id = ? AND url = ? ORDER BY created_at DESC',
    args: [userId, url],
  });
  return result.rows.map(toNote);
}

async function addNote(userId, url, body) {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO notes_by_url (id, user_id, url, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, userId, url, body, now, now],
  });
  return { id, body, createdAt: now, updatedAt: now };
}

// Returns the updated note, or null if the edit emptied it out (in which
// case the entry is deleted rather than left as a blank card).
async function editNote(userId, url, id, body) {
  const trimmed = (body || '').trim();
  if (!trimmed) {
    await db.execute({
      sql: 'DELETE FROM notes_by_url WHERE id = ? AND user_id = ? AND url = ?',
      args: [id, userId, url],
    });
    return null;
  }
  const updatedAt = Date.now();
  await db.execute({
    sql: 'UPDATE notes_by_url SET body = ?, updated_at = ? WHERE id = ? AND user_id = ? AND url = ?',
    args: [body, updatedAt, id, userId, url],
  });
  return { id, body, updatedAt };
}

async function removeNote(userId, url, id) {
  await db.execute({
    sql: 'DELETE FROM notes_by_url WHERE id = ? AND user_id = ? AND url = ?',
    args: [id, userId, url],
  });
}

module.exports = { listNotes, addNote, editNote, removeNote };
