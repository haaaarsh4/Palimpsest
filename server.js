// server.js
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const { db, initSchema, ready } = require('./db');
const { fetchSnapshotList, normalizeInputUrl } = require('./lib/cdx');
const { fetchArchivedHtml } = require('./lib/fetchHtml');
const { diffSnapshots } = require('./lib/diffEngine');
const { generateInsight } = require('./lib/insight');
const { listNotes, addNote, editNote, removeNote } = require('./lib/notes');
const { analyzeClaims, CLAIMS_VERSION } = require('./lib/claims');

const app = express();
// Archived pages are enormously repetitive markup, which is exactly what
// gzip is good at: reading a site's whole history off the Archive moves tens
// of megabytes of pages, and compressed they are a small fraction of that.
// This has to sit above the static handler too, so the app's own CSS and JS
// are compressed as well.
app.use(compression());
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

// Every table has to actually exist before we serve a request that needs
// one. On Render that used to be a startup concern: init the schema, then
// listen. Serverless has no startup - a function is loaded, handed one
// request, and frozen. So schema setup is middleware, registered before
// every route: the first request in a cold container pays for it, later
// requests in that same container reuse the already-resolved promise, and a
// failure comes back as a 503 with a readable message instead of a hang.
app.use(async (req, res, next) => {
  try {
    await ready();
    next();
  } catch (err) {
    console.error('Failed to set up the database schema:', err);
    res.status(503).json({ error: 'Database is not reachable right now. Try again in a moment.' });
  }
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
    // Interactive: someone is dragging a handle and watching this pane, so
    // these jump ahead of any record walk in progress.
    const [oldHtml, newHtml] = await Promise.all([
      fetchArchivedHtml(cleanUrl, String(from), { interactive: true }),
      fetchArchivedHtml(cleanUrl, String(to), { interactive: true }),
    ]);
    const result = diffSnapshots(oldHtml, newHtml, { url: cleanUrl, tsFrom: String(from), tsTo: String(to) });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not build the diff for those two snapshots.' });
  }
});

// ---- One step of the record walk ------------------------------------------
// The dashboard and the timelapse need the same thing from every adjacent pair
// of captures: what changed, broken down by tag, and the page itself. They
// used to get it from /api/diff, which is the wrong shape for that job for two
// reasons. It returns the DIFF-ANNOTATED documents - every changed node
// outlined in red or green - and a film of a site aging should show the site,
// not the comparison. And it returns the full `changes` array, which is
// thousands of objects per pair, of which the dashboard reads exactly one
// property from each and then throws the rest away.
//
// So this returns the raw archived pages and the two summaries, and nothing
// else. `withOld=1` asks for the older page as well, and the walk asks for it
// exactly once - on its first step - because the page on the left of every
// later step is the page on the right of the one before. That single flag is
// what keeps a whole reading to one page per capture instead of two.
//
// The documents it returns are cached in Turso by fetchArchivedHtml under
// `${url}::${timestamp}`, so a step whose pages are already known costs no
// Archive request at all - which is why a second reading of the same site is
// essentially instant, for every visitor, on this server.
app.get('/api/record-step', async (req, res) => {
  try {
    const { url, from, to } = req.query;
    if (!url || !from || !to) {
      return res.status(400).json({ error: 'Missing url, from, or to parameter.' });
    }
    const cleanUrl = normalizeInputUrl(String(url));
    const wantOld = req.query.withOld === '1' || req.query.withOld === 'true';

    const [oldHtml, newHtml] = await Promise.all([
      fetchArchivedHtml(cleanUrl, String(from)),
      fetchArchivedHtml(cleanUrl, String(to)),
    ]);
    const { counts, tagCounts } = diffSnapshots(oldHtml, newHtml, { annotate: false });

    // fetchArchivedHtml already stripped the toolbar and any scripts and added
    // the base href, so what comes back here is a page that renders as itself.
    res.json({ counts, tagCounts, newHtml, oldHtml: wantOld ? oldHtml : undefined });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not retrieve that pair of captures.' });
  }
});

// ---- One capture, on its own -----------------------------------------------
// One page, asked for by name. Two things need it: repairing the single hole a
// failed step left behind, and a film whose next frame is a capture the record
// walk could not produce. Both are a person watching one page arrive, so this
// goes on the interactive lane. Left on the bulk lane it queued behind whatever
// record was being walked at the time — which is why one frame of the film
// could take a minute while the next took a second: it was waiting for the end
// of somebody else's thirteen-minute reading.
app.get('/api/capture', async (req, res) => {
  try {
    const { url, ts } = req.query;
    if (!url || !ts) {
      return res.status(400).json({ error: 'Missing url or ts parameter.' });
    }
    const cleanUrl = normalizeInputUrl(String(url));
    const html = await fetchArchivedHtml(cleanUrl, String(ts), { interactive: true });
    res.json({ html });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not retrieve that capture.' });
  }
});

// ---- Claims: what the page used to say -------------------------------------
// The analysis reads every capture of this address that is already on file —
// the same rows the compare view and the film read — so it costs no Archive
// request of its own and works on a record that was already read. A report is
// cached whole, keyed by (url, analysis version), and it is only reusable while
// the record has not grown: captures added after it was built would otherwise
// be invisible to it forever.
//
// Coverage is reported rather than assumed. `coverage.captures` is how many
// captures the report actually read, and the page compares that against the
// snapshot list and fetches the missing ones itself before asking again. An
// analysis of a third of a history is a perfectly good analysis of a third of a
// history, as long as it says which third.
app.get('/api/claims', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url parameter.' });
    const url = normalizeInputUrl(raw);

    const stored = await db.execute({
      sql: 'SELECT payload, captures FROM claim_reports WHERE url = ? AND version = ?',
      args: [url, CLAIMS_VERSION],
    });
    const onFile = Number((await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM snapshot_html WHERE url = ?',
      args: [url],
    })).rows[0].n);

    if (stored.rows[0] && Number(stored.rows[0].captures) === onFile && req.query.refresh !== '1') {
      return res.json({ report: JSON.parse(String(stored.rows[0].payload)), cached: true });
    }

    if (!onFile) {
      return res.status(409).json({
        error: 'No captures of this address are on file yet. Read its record first.',
        onFile: 0,
      });
    }

    const rows = (await db.execute({
      sql: 'SELECT timestamp, html FROM snapshot_html WHERE url = ? ORDER BY timestamp',
      args: [url],
    })).rows;
    const report = analyzeClaims(url, rows.map((r) => ({ timestamp: String(r.timestamp), html: String(r.html) })));

    await db.execute({
      sql: `INSERT INTO claim_reports (url, version, captures, generated_at, payload)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET version = excluded.version, captures = excluded.captures,
              generated_at = excluded.generated_at, payload = excluded.payload`,
      args: [url, CLAIMS_VERSION, onFile, Date.now(), JSON.stringify(report)],
    });

    res.json({ report, cached: false });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not analyze the claims on that record.' });
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

// Only listen when this file is the entry point. When Vercel requires it
// from api/index.js there is no port to bind - it wants the app itself.
if (require.main === module) {
  ready().then(() => {
    app.listen(PORT, () => {
      console.log(`Palimpsest is running at http://localhost:${PORT}`);
    });
  });
}

module.exports = { app, ready };
