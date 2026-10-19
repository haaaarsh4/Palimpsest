// server.js
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const { db, initSchema, ready } = require('./db');
const { fetchSnapshotList, normalizeInputUrl, snapshotProgress } = require('./lib/cdx');
const { fetchArchivedHtml } = require('./lib/fetchHtml');
const { parseArchivePageUrl } = require('./lib/archivePageUrl');
const { measurePair, stepNumbers } = require('./lib/measurePair');
const { generateInsight } = require('./lib/insight');
const { listNotes, addNote, editNote, removeNote } = require('./lib/notes');
const { analyzeClaims, CLAIMS_VERSION } = require('./lib/claims');
const { getAsset } = require('./lib/assetCache');
const { comparisonFor, pagesComparison, paneDocumentFor } = require('./lib/comparison');
const { fetchStylesheetText } = require('./lib/fetchCss');
const { recordDocsPage, recordCount, recordSteps, readStep, writeSteps, ensureCompileForUrl, compileState } = require('./lib/recordBook');

const app = express();
// Archived pages are enormously repetitive markup, which is exactly what
// gzip is good at: reading a site's whole history off the Archive moves tens
// of megabytes of pages, and compressed they are a small fraction of that.
// This has to sit above the static handler too, so the app's own CSS and JS
// are compressed as well.
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
// The app's own code must never be served from a stale copy. A browser that
// keeps an old timelapse.js and a new archiveStore.js is running a program that
// was never written: it showed a progress card reading "retrieving capture 1 of
// 741" beside "reaching for the Internet Archive", a pair of sentences the
// current code cannot produce, because the card and the reader had been
// downloaded months apart. `no-cache` still stores them; it just means every
// load asks first, and an unchanged file answers 304 in a millisecond.
// Clean URLs: the pages read /compare, /claims, /settlement and
// /sustainability. The files on disk keep their .html names; these routes
// serve them at the bare paths, and the old .html addresses redirect to the
// bare ones so there is exactly one address per page. Registered before the
// static handler so /compare.html never answers directly.
const CLEAN_PAGES = ['compare', 'claims', 'settlement', 'sustainability'];
CLEAN_PAGES.forEach((page) => {
  app.get('/' + page, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page + '.html'));
  });
  app.get('/' + page + '.html', (req, res) => {
    // req.url keeps the query string, so ?url= addresses survive the move.
    res.redirect(301, '/' + page + req.url.slice(('/' + page + '.html').length));
  });
});
const NO_STALE = /[.](?:js|html|css)$/i;
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (NO_STALE.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

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
// The timeline needs the shape of a record, not every one of its captures, and
// the difference is not small: nytimes.com has 436,339 captures, and sending
// them all as JSON is a 43MB response the browser then has to parse before it
// can draw anything - measured at 1.9 seconds on the server and several more
// in the page, on every visit, for a slider that draws a few hundred ticks.
//
// So the response is a faithful *sample* of the record, and it says so:
//
//   - the first and last captures are always here, because they are the ends
//     of the rail and the labels under it;
//   - every capture of the last 18 months is kept, because that is the part of
//     a history people compare ("what did it say last month");
//   - before that, one capture a month, which is the resolution the rail can
//     show anyway;
//   - and the whole sample is capped, so a pathological record cannot become
//     the next 43MB response.
//
// `total` is the real number of captures on file, and the page reports that;
// a link naming a capture the sample does not carry still works, because the
// client puts the two addresses it was given onto the rail itself (see
// ensureSnapshotEntries in public/app.js).
// Two resolutions, not one: the recent window is kept at one capture a DAY,
// the rest of the history at one a MONTH. Both are bounded, so the sample is
// under a thousand points whatever the record holds - and the history stays
// reachable, which is the part the old even-thinning destroyed: a 436,339-
// capture record blew past the cap inside its recent window, and the even
// step then thinned the whole sample by index, which is the old years' few
// monthly points against the recent years' hundreds of thousands. April 2017
// was not in the sample of a record that holds it, so a capture somebody
// picked could not be picked again.
const { sampleSnapshots, MAX_TIMELINE_POINTS, RECENT_WINDOW_MS } = require('./lib/sampleSnapshots');

// Reading a big record out of the database is the slow part of /api/snapshots
// (43MB of JSON parsed per request, ~2s), and the answer only changes when
// the list itself is refetched (once a day). So the sampled answer is kept in
// memory: a repeat visit, or a second tab, is answered without touching the
// database at all.
const sampleMemo = new Map(); // key -> { payload, at }
const SAMPLE_MEMO_TTL_MS = 60 * 60 * 1000;

function rememberSample(key, payload) {
  sampleMemo.set(key, { payload, at: Date.now() });
  // A handful of records is all anyone looks at; keep the map from growing
  // with every address ever typed.
  if (sampleMemo.size > 12) {
    const oldest = sampleMemo.keys().next().value;
    sampleMemo.delete(oldest);
  }
}

function recallSample(key) {
  const hit = sampleMemo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SAMPLE_MEMO_TTL_MS) {
    sampleMemo.delete(key);
    return null;
  }
  return hit.payload;
}

app.get('/api/snapshots', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url parameter.' });
    const key = normalizeInputUrl(raw);
    let payload = recallSample(key);
    if (!payload) {
      const snapshots = await fetchSnapshotList(raw);
      const sample = sampleSnapshots(snapshots);
      payload = {
        url: key,
        total: snapshots.length,
        thinned: sample.length < snapshots.length,
        snapshots: sample,
      };
      rememberSample(key, payload);
    }
    // The list is a fact about an address that changes at most daily, and the
    // Archive is where it comes from: the browser may keep it, and a repeat
    // visit is answered without touching this server at all.
    res.set('Cache-Control', 'private, max-age=3600, must-revalidate');
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not reach the Wayback Machine. Try again in a moment.' });
  }
});

// Where the snapshot walk is, while /api/snapshots is still working on it:
// which index page is being read and how many captures are on file so far.
// The trace form polls this once a second so a slow Archive reads as slow,
// not stuck. Never cached: it names a moment, not a thing.
app.get('/api/snapshots-progress', (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url parameter.' });
    res.set('Cache-Control', 'no-store');
    res.json({ progress: snapshotProgress(normalizeInputUrl(raw)) });
  } catch (err) {
    res.status(400).json({ error: 'That address could not be read.' });
  }
});

// Where this app is answering from, as the browser sees it. Passed into every
// document the panes are given: a routed asset address has to be absolute to
// survive the capture's own <base href="https://web.archive.org/..."> (see
// proxyPath in lib/assetCache.js), and only the request knows what address the
// browser actually reached us on.
function selfOrigin(req) {
  try {
    return `${req.protocol}://${req.get('host')}`;
  } catch (_) {
    return '';
  }
}

// ---- Diff between two snapshot timestamps ---------------------------------
app.get('/api/diff', async (req, res) => {
  try {
    const { url, from, to } = req.query;
    if (!url || !from || !to) {
      return res.status(400).json({ error: 'Missing url, from, or to parameter.' });
    }
    const cleanUrl = normalizeInputUrl(String(url));
    const tsFrom = String(from);
    const tsTo = String(to);
    const result = await comparisonFor(cleanUrl, tsFrom, tsTo, { origin: selfOrigin(req) });
    // A repeat of the same comparison is answered from memory and revalidated
    // with an ETag, so returning to a comparison - or reloading it - costs the
    // browser a 304 instead of two archive reads and a diff.
    const etag = `"${result.etag}"`;
    res.set('Cache-Control', 'private, max-age=600, must-revalidate');
    res.set('ETag', etag);
    if (String(req.headers['if-none-match'] || '') === etag) return res.status(304).end();
    res.json({ oldHtml: result.oldHtml, newHtml: result.newHtml, changes: result.changes, counts: result.counts });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not build the diff for those two snapshots.' });
  }
});

// ---- Diff between the two pages currently open in the panes -----------------
// After following links inside the snapshots, the changes list describes the
// comparison the panes started from, not what they show. This diffs what
// they show: two full archived page addresses, as read from the panes'
// address bars. Each address is re-read through the same capture pipeline
// (/api/diff's fetchArchivedHtml + prepareCapture), so the annotated pages
// coming back render exactly like the snapshots do, outlines included  
// and the panes adopt them as the new comparison homes.
//
// Only web.archive.org page addresses are accepted (see
// lib/archivePageUrl.js): a pane can wander onto the live web, and this
// endpoint must never become a fetcher for an arbitrary server. Those
// refusals answer 400 with the plain-language reason; genuine failures
// answer 502 like the rest of the archive-backed routes.
app.get('/api/diff-pages', async (req, res) => {
  try {
    const { old, new: next } = req.query;
    if (!old || !next) {
      return res.status(400).json({ error: 'Missing old or new page address.' });
    }
    const a = parseArchivePageUrl(String(old));
    const b = parseArchivePageUrl(String(next));
    // Interactive, like /api/diff: someone is watching a spinner for this.
    // Same cache, same ETag: comparing the same two pages twice is a lookup.
    const result = await pagesComparison(a.url, a.timestamp, b.url, b.timestamp, { origin: selfOrigin(req) });
    const etag = `"${result.etag}"`;
    res.set('Cache-Control', 'private, max-age=600, must-revalidate');
    res.set('ETag', etag);
    if (String(req.headers['if-none-match'] || '') === etag) return res.status(304).end();
    res.json({ oldHtml: result.oldHtml, newHtml: result.newHtml, changes: result.changes, counts: result.counts });
  } catch (err) {
    console.error(err);
    const status = err.status === 400 ? 400 : 502;
    res.status(status).json({ error: err.status === 400 ? err.message : 'Could not build the diff for those two pages.' });
  }
});

// ---- One followed page, through the capture pipeline ------------------------
// A pane that follows a link must keep rendering like a snapshot: prepared
// (scripts stripped, base set, new-tab targets forced to the pane itself)
// and same-origin (srcdoc) so the next click is interceptable too. Loading
// the raw archive address directly would do neither: it renders cross-origin
// with its target="_blank" links intact, where the click handler cannot run
// and the sandbox blocks the popup, which is exactly how a language toggle
// reads as dead. Only archived page addresses are accepted, like
// /api/diff-pages above; anything else is a 400, never a generic fetch.
app.get('/api/page', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter.' });
    const parsed = parseArchivePageUrl(String(url));
    const html = await paneDocumentFor(parsed.url, parsed.timestamp, { origin: selfOrigin(req) });
    res.json({ html, url: String(url) });
  } catch (err) {
    console.error(err);
    const status = err.status === 400 ? 400 : 502;
    res.status(status).json({ error: err.status === 400 ? err.message : 'Could not load that archived page.' });
  }
});

// ---- The whole record for one address --------------------------------------
// Every capture of this address that is already on file, in one response, plus
// whatever numbers have been compiled for it.
//
// This is what the film and the dashboard open on. They used to ask for the
// record one adjacent pair at a time, which meant the browser could not draw a
// frame until the seven hundred and fortieth round trip had come back, about a
// hundred seconds for a history the database had held in full the whole time.
// The same history is one query and three seconds, so it is one request.
//
// Two shapes, deliberately the same route:
//
//   GET /api/record?url=…                 documents, numbers, compile progress
//   GET /api/record?url=…&countsOnly=1    numbers and progress only
//
// The second is what a film asks for once a second while it plays, when the
// only thing still arriving is the numbers behind its rail. It carries no
// documents at all, so it costs one small query rather than thirty-seven
// megabytes.
//
// Asking for the record is also what starts the compile: a reader that wants
// the numbers is the reason to measure them. The documents go out immediately
// either way, the numbers are never allowed to hold up the pages.
app.get('/api/record', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing url parameter.' });
    const url = normalizeInputUrl(raw);
    const countsOnly = req.query.countsOnly === '1';

    // The documents can be asked for a slice at a time. That exists because the
    // whole record is tens of megabytes, and a reader should never have to wait
    // for all of it to see the first frame: the viewer opens on the numbers -
    // which are kilobytes - and pulls the pages in behind itself in batches it
    // can report progress on. Every branch below costs small indexed queries;
    // nothing here reads the whole history. It used to: each request loaded
    // every capture and re-stringified tens of megabytes, so a film polling
    // for numbers once a second paid thirty-seven megabytes a second while
    // the compile it was waiting on fought for the same thread.
    const from = Math.max(0, Number(req.query.from) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));

    // The numbers-only poll the film makes once a second while it plays must
    // never touch the documents: it is one count plus the compiled steps. The
    // compile is kicked only when one is actually needed (never started, or
    // the record grew since it finished), and that check is a count, not a
    // document read, so a running compile costs polls nothing at all.
    if (countsOnly) {
      const [count, steps] = await Promise.all([recordCount(url), recordSteps(url)]);
      await ensureCompileForUrl(url).catch(() => {});
      const counts = {};
      for (const [ts, step] of steps) counts[ts] = step;
      const body =
        '{"url":' + JSON.stringify(url) +
        ',"captures":' + count +
        ',"from":' + from +
        ',"limit":' + limit +
        ',"counts":' + JSON.stringify(counts) +
        ',"compile":' + JSON.stringify(compileState(url)) +
        '}';
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(body);
      return;
    }

    const [page, steps] = await Promise.all([
      recordDocsPage(url, from, limit),
      recordSteps(url),
    ]);
    // Reading the pages is what starts the compile: a reader that wants the
    // numbers is the reason to measure them. Started at most once per record
    // growth (see ensureCompileForUrl), never per chunk request.
    ensureCompileForUrl(url).catch(() => {});

    const counts = {};
    for (const [ts, step] of steps) counts[ts] = step;

    // Assembled by concatenation rather than JSON.stringify of the whole shape:
    // the slice is already the only documents on the wire, and re-encoding
    // more markup than that is work nobody asked for.
    const body =
      '{"url":' + JSON.stringify(url) +
      ',"captures":' + page.count +
      ',"from":' + from +
      ',"limit":' + limit +
      ',"counts":' + JSON.stringify(counts) +
      ',"compile":' + JSON.stringify(compileState(url)) +
      ',"rows":' + JSON.stringify(page.rows) +
      '}';

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not read that record.' });
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

    // The numbers for this pair may already have been compiled, by a film that
    // opened, by the dashboard, by this endpoint an hour ago, in which case
    // there is nothing to measure and the 66ms diff is skipped outright. If
    // they have not been, they are measured here and kept, because the answer
    // to "what changed between these two captures" is a fact about two
    // immutable documents and never needs measuring twice.
    let step = await readStep(cleanUrl, String(to));
    if (!step) {
      // The same pipeline as the compare view, not the bare diff: a step's
      // numbers must say what the changes list would say for this pair,
      // silent image changes promoted and proven no-ops demoted alike.
      // The annotated documents are discarded; only the numbers are kept.
      const measured = await measurePair(oldHtml, newHtml, { tsFrom: String(from), tsTo: String(to) });
      step = stepNumbers(measured);
      writeSteps(cleanUrl, [{ ts: String(to), ...step }]).catch(() => {});
    }

    // fetchArchivedHtml already stripped the toolbar and any scripts and added
    // the base href, so what comes back here is a page that renders as itself.
    res.json({ counts: step.counts, tagCounts: step.tagCounts, newHtml, oldHtml: wantOld ? oldHtml : undefined });
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
// record was being walked at the time, which is why one frame of the film
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

// ---- One asset, from this app's own cache ----------------------------------
// The pictures, stylesheets and scripts an archived capture references. The
// Archive charges seconds for a resource it has not served recently, and a
// capture's markup names its assets with that capture's own timestamp, so a
// history of a thousand frames asks it for tens of thousands of resources that
// are really a few hundred files. Each one is fetched here exactly once, kept in
// data/assets/, and served from disk from then on, which is what turns a frame
// that took four seconds into a frame that takes forty milliseconds. The markup
// the app renders is written to point at this route (see tlCanonicalize), so the
// browser never crosses the network for a frame at all.
app.get('/api/asset', async (req, res) => {
  try {
    const mod = String(req.query.m || 'im_');
    const ts = String(req.query.t || '');
    const url = String(req.query.u || '');
    if (!/^\d{14}$/.test(ts) || !url) {
      return res.status(400).json({ error: 'Missing or malformed t or u parameter.' });
    }
    const asset = await getAsset(mod, ts, url);
    if (!asset) return res.status(404).end();
    // Immutable: the URL carries the capture's timestamp and the original
    // address, so the same URL can never mean a different file.
    res.set('Content-Type', asset.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(asset.body);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not retrieve that asset.' });
  }
});

// ---- One asset, addressed the way a document addresses its neighbours ------
// `GET /api/asset-dir/<timestamp><modifier>/<original url>`, the same cache as
// /api/asset, but addressed by a *path* rather than by a query string.
//
// This exists because of the one kind of asset the query-shaped route cannot
// serve: a RELATIVE one. An archived document arrives carrying the Archive's own
// <base href>, and a page whose image is written `images/crest.gif` resolves
// against that base, straight back to web.archive.org, at two to twelve seconds
// a file and sometimes refused outright (fonts are fetched with CORS, and the
// Archive sends no such header). Every relative URL in a twenty-seven year
// record was therefore a page arriving a piece at a time, and the render is
// where a film feels it.
//
// A path can be appended to. So the film rewrites the document's base to this
// route, carrying the capture's own timestamp, so the picture is still the
// version that capture saw, and every relative URL the page has resolves
// through this cache instead. One file per resource, fetched once, served from
// disk thereafter, exactly like the absolute ones.
//
// The tail is consumed verbatim, query string and all, because that is what the
// browser resolved to; only the timestamp and the Archive's modifier are peeled
// off the front.
app.get(/^\/api\/asset-dir\//, async (req, res) => {
  try {
    // An optional `v<digits>/` segment in front, which is the client's asset
    // revision and nothing else (it is stripped rather than parsed: the cache
    // key below must not depend on it, or every revision would fetch the whole
    // record again). It exists because these URLs are cached immutable for a
    // year, and a correction to an asset can only reach a browser that has the
    // old one by arriving at a new address.
    const rest = req.originalUrl
      .slice('/api/asset-dir/'.length)
      .replace(/^v\d+\//i, '');
    const m = /^(\d{14})([a-z_]*)\/(.+)$/i.exec(rest);
    if (!m) return res.status(400).json({ error: 'Malformed asset path.' });
    let url = m[3];
    try { url = decodeURI(url); } catch (_) { /* left encoded, and still fetched */ }
    const asset = await getAsset(m[2] || 'im_', m[1], url);
    if (!asset) return res.status(404).end();
    res.set('Content-Type', asset.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(asset.body);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not retrieve that asset.' });
  }
});

// ---- One stylesheet's raw text, for reading cross-origin rules --------------
// Archived stylesheets arrive without CORS headers, so the browser refuses to
// let the panes read their rules through document.styleSheets, and the exact
// hiding rule (the other half of every "why is this change invisible" answer)
// usually lives in exactly those sheets. A server-to-server fetch is not
// subject to CORS at all, so this route reads the text here and hands it back
// as plain text; the pane re-parses it into a detached stylesheet that is
// never applied, only queried (see hydrateBlockedStylesheets in app.js).
// Only http(s) addresses are fetched, and the response is cacheable for a day:
// a capture's stylesheets never change.
app.get('/api/css', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: 'Missing or malformed url parameter.' });
    }
    const text = await fetchStylesheetText(raw);
    if (!text) return res.status(404).end();
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(text);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not retrieve that stylesheet.' });
  }
});

// ---- Claims: what the page used to say -------------------------------------
// The analysis reads every capture of this address that is already on file  
// the same rows the compare view and the film read, so it costs no Archive
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
//
// A port already in use is the ordinary outcome of starting this a second
// time, the first one is still running, usually in another terminal or
// editor tab. Node's default for that is a twenty-line stack dump ending in
// "Failed running server.js" under --watch, which reads like the app is
// broken rather than like the app is already up. So it is caught here and
// answered in one line, with the commands that fix it, and a clean exit
// (exit 0, because nothing failed) so --watch waits quietly for the next
// edit instead of reporting a crash.
if (require.main === module) {
  ready()
    .then(() => {
      const server = app.listen(PORT, () => {
        console.log(`Palimpsest is running at http://localhost:${PORT}`);
      });
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          console.error(
            `Port ${PORT} is already in use, so Palimpsest is probably already running.\n` +
              `  See what has it:   lsof -i :${PORT}\n` +
              `  Stop it:           kill $(lsof -t -i :${PORT})\n` +
              `  Or run this copy on another port:   PORT=${Number(PORT) + 1} npm run dev`
          );
          process.exit(0);
        }
        if (err && err.code === 'EACCES') {
          console.error(`Port ${PORT} needs permission this process does not have. Try: PORT=8080 npm run dev`);
          process.exit(1);
        }
        console.error('Palimpsest could not start:', (err && err.message) || err);
        process.exit(1);
      });
    })
    .catch((err) => {
      console.error('Palimpsest could not reach its database:', (err && err.message) || err);
      process.exit(1);
    });
}

module.exports = { app, ready };
