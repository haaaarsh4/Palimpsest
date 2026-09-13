// server.js
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { initSchema } = require('./db');
const { fetchSnapshotList, normalizeInputUrl } = require('./lib/cdx');
const { fetchArchivedHtml } = require('./lib/fetchHtml');
const { diffSnapshots } = require('./lib/diffEngine');
const { generateInsight } = require('./lib/insight');
const { listNotes, addNote, editNote, removeNote } = require('./lib/notes');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Every visitor gets a random, anonymous id in a long-lived cookie the
// first time they show up. It's not a login - there's no password and no
// signup - but it's enough for "this browser's notes stay this browser's
// notes" across every visit and every site it traces.
app.use((req, res, next) => {
  if (req.cookies && req.cookies.pdiff_uid) {
    req.pdiffUserId = req.cookies.pdiff_uid;
  } else {
    const uid = crypto.randomUUID();
    res.cookie('pdiff_uid', uid, {
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5, // 5 years
      httpOnly: true,
      sameSite: 'lax',
    });
    req.pdiffUserId = uid;
  }
  next();
});

// ---- Snapshot list (feeds the timeline slider) ----------------------------
app.get('/api/snapshots', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url parameter.' });
    const snapshots = await fetchSnapshotList(raw);
    res.json({ url: normalizeInputUrl(raw), snapshots });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not reach the Wayback Machine. Try again in a moment.' });
  }
});

// ---- Diff between two snapshot timestamps ---------------------------------
app.get('/api/diff', async (req, res) => {
  try {
    const { url, from, to } = req.query;
    if (!url || !from || !to) {
      return res.status(400).json({ error: 'Missing url, from, or to parameter.' });
    }
    const cleanUrl = normalizeInputUrl(String(url));
    const [oldHtml, newHtml] = await Promise.all([
      fetchArchivedHtml(cleanUrl, String(from)),
      fetchArchivedHtml(cleanUrl, String(to)),
    ]);
    const result = diffSnapshots(oldHtml, newHtml, { url: cleanUrl, tsFrom: String(from), tsTo: String(to) });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not build the diff for those two snapshots.' });
  }
});

// ---- Notes (an append-only log per user + url, follows you across every
// date pair you compare on that site) --------------------------------------
app.get('/api/notes', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter.' });
    const notes = await listNotes(req.pdiffUserId, normalizeInputUrl(String(url)));
    res.json({ notes });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not load notes right now.' });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { url, body } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url.' });
    const note = await addNote(req.pdiffUserId, normalizeInputUrl(String(url)), String(body || ''));
    if (!note) return res.status(400).json({ error: 'Note is empty.' });
    res.json(note);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not save that note right now.' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  try {
    const { url, body } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url.' });
    const note = await editNote(req.pdiffUserId, normalizeInputUrl(String(url)), req.params.id, String(body || ''));
    res.json(note || { id: req.params.id, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not save that edit right now.' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter.' });
    await removeNote(req.pdiffUserId, normalizeInputUrl(String(url)), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not delete that note right now.' });
  }
});

// ---- AI insight -------------------------------------------------------------
app.post('/api/insight', async (req, res) => {
  try {
    const { url, from, to, dateFrom, dateTo, changes, counts } = req.body || {};
    if (!url || !from || !to) return res.status(400).json({ error: 'Missing url, from, or to.' });
    const result = await generateInsight({
      url: normalizeInputUrl(String(url)),
      tsFrom: String(from),
      tsTo: String(to),
      dateFrom,
      dateTo,
      changes: changes || [],
      counts: counts || { added: 0, removed: 0, changed: 0 },
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not generate an insight right now.' });
  }
});

// Every table has to actually exist before we start accepting requests -
// initSchema is async now (CREATE TABLE over the network), so this waits
// for it to finish rather than firing it off as a side effect on require.
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Palimpsest is running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to set up the database schema:', err);
    process.exit(1);
  });
