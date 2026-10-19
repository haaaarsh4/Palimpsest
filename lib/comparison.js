// lib/comparison.js
//
// One comparison, built once.
//
// Two things made opening the same pair twice cost the same as the first time:
// the pipeline (fetch two captures, parse both, diff them, route their assets)
// ran per request, and the answer was never revalidated with the browser, so a
// reload or a return to a comparison was a fresh request that rebuilt
// everything. Both are fixed here, in one place, because every route that shows
// panes needs the same treatment:
//
//   - the result is kept in memory, keyed by the pair and by the revisions of
//     every pass that shaped it, so a second request for the same pair is a Map
//     lookup (and an ETag match is a 304 with no body at all);
//   - identical requests that arrive while the first is still running share
//     that one run rather than starting a second one, which is what a reader
//     double-clicking Compare used to cause;
//   - the two documents the panes are given have their assets pointed at
//     /api/asset (lib/routeAssets.js), and the stylesheets they name are warmed
//     into data/assets/ immediately, so a pane arrives styled instead of
//     arriving and then waiting a minute for the Archive to hand over its CSS.
//
// The diff itself is always computed on the *prepared* documents, never on the
// routed ones: routing rewrites src attributes, and a comparison whose record
// of what an image pointed at had been rewritten would report changes that are
// not there (and show its own proxy URLs in the change cards).

const crypto = require('crypto');
const { fetchArchivedHtml } = require('./fetchHtml');
const { measurePair } = require('./measurePair');
const { PREPARE_VERSION } = require('./prepareCapture');
const { routedDocument, warmStylesheets, warmStylesheetsFromRaw, warmImagesFromRaw, prepareAssets, ROUTE_VERSION } = require('./routeAssets');
const { ASSET_VERSION } = require('./assetCache');

// How long a comparison may spend putting a page's assets in the cache before
// it is handed to the panes. Everything that makes it in is a file read when
// the pane asks for it, so the page arrives complete instead of filling in one
// picture at a time; everything that does not is still fetched by the browser,
// in parallel, from the same cache. The deadline is what keeps an Archive that
// has lost a picture from holding up a page that has fifty others.
const ASSET_BUDGET_MS = 12000;

// How many whole comparisons are kept. Each is two documents and a change list
// (a few megabytes at the top end), so this is a deliberate ceiling rather than
// an unbounded map: readers move between a handful of pairs, and anything past
// that is rebuilt from the disk cache in well under a second anyway.
const LIMIT = 8;
const cache = new Map(); // key -> value, oldest first
const inflight = new Map(); // key -> Promise<value>

function keyFor(url, from, to, origin) {
  return `${url}|${from}|${to}|${origin || ''}|p${PREPARE_VERSION}|r${ROUTE_VERSION}|a${ASSET_VERSION}`;
}

function etagFor(seed, oldHtml, newHtml) {
  return crypto.createHash('sha1')
    .update(seed + '|')
    .update(oldHtml)
    .update(newHtml)
    .digest('hex');
}

function remember(key, value) {
  cache.set(key, value);
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
}

// The shared body of every comparison: two prepared documents in, the pane's
// two routed documents plus the change list out, with the whole thing cached.
//
// `sides.origin` is this app's own address (http://localhost:3000 here), and it
// is part of the cache key because the routed documents name their assets with
// it: the panes' <base href> points at the Archive, so an asset address has to
// be absolute to reach us at all (see proxyPath in lib/assetCache.js).
async function build(key, seed, sides) {
  const hit = cache.get(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const started = Date.now();
  const job = (async () => {
    let mark = started;
    const lap = () => { const now = Date.now(); const ms = now - mark; mark = now; return ms; };
    const [oldRaw, newRaw] = await Promise.all([
      fetchArchivedHtml(sides.oldUrl, sides.oldTs, { interactive: true }),
      fetchArchivedHtml(sides.newUrl, sides.newTs, { interactive: true }),
    ]);
    // The stylesheets are warmed BEFORE the diff runs, which is the whole
    // speed of the comparison: warming a sheet means asking the Archive for
    // it, and the diff takes seconds, so the sheets have the length of the
    // diff to arrive instead of starting after it. By the time the browser
    // parses the pane, its <link> requests are file reads. The addresses come
    // from the raw markup (see warmStylesheetsFromRaw) so nothing is parsed
    // twice waiting for them. Fire and forget, deliberately: the diff below
    // is awaited in the same breath.
    warmStylesheetsFromRaw(oldRaw, { url: sides.oldUrl, timestamp: sides.oldTs });
    warmStylesheetsFromRaw(newRaw, { url: sides.newUrl, timestamp: sides.newTs });
    // Then the pictures, on a narrower rack so the sheets - the difference
    // between a pane that looks like the site and a pane that looks broken -
    // are always answered first.
    warmImagesFromRaw(oldRaw, { url: sides.oldUrl, timestamp: sides.oldTs });
    warmImagesFromRaw(newRaw, { url: sides.newUrl, timestamp: sides.newTs });
    const fetchMs = lap();
    const measured = await measurePair(oldRaw, newRaw, { tsFrom: sides.oldTs, tsTo: sides.newTs });
    const measureMs = lap();
    const [oldHtml, newHtml] = await Promise.all([
      routedDocument(measured.oldHtml, { url: sides.oldUrl, timestamp: sides.oldTs, origin: sides.origin }),
      routedDocument(measured.newHtml, { url: sides.newUrl, timestamp: sides.newTs, origin: sides.origin }),
    ]);
    // A second pass over the routed documents, which catches anything the raw
    // scan missed - a sheet the diff itself introduced, a link spelled in a
    // way the string scan does not read - and is a no-op for the rest, since
    // every URL it finds has already been asked for.
    warmStylesheets(oldHtml, { url: sides.oldUrl, timestamp: sides.oldTs });
    warmStylesheets(newHtml, { url: sides.newUrl, timestamp: sides.newTs });
    // And then the whole page: every picture, sheet and inline background the
    // routed documents name, fetched into the cache before the panes are given
    // the markup. This is the difference between a pane that fades in finished
    // and one that assembles itself while the reader watches.
    const [oldReady, newReady] = await Promise.all([
      prepareAssets(oldHtml, { deadlineMs: ASSET_BUDGET_MS }),
      prepareAssets(newHtml, { deadlineMs: ASSET_BUDGET_MS }),
    ]);
    // Whatever the second pass still could not get. The panes hide these
    // quietly (a broken picture would print its alt text across the design),
    // and the log says which ones so a hole in a pane can be traced to a file
    // the Archive no longer serves instead of guessed at.
    const unavailable = (oldReady.missing || []).concat(newReady.missing || []);
    // One line per built comparison: the phases are the only honest way to
    // answer "why was that slow" without guessing, and a pane waiting nine
    // seconds should say which of the three it waited for.
    console.error(`[diff] ${sides.oldUrl} ${sides.oldTs}->${sides.newTs}: fetch ${fetchMs}ms, measure ${measureMs}ms, route ${lap()}ms, ` +
      `assets ${oldReady.done}/${oldReady.asked}+${newReady.done}/${newReady.asked}` +
      (unavailable.length ? ` (${unavailable.length} unavailable)` : '') +
      ` (${Date.now() - started}ms total)`);
    return {
      oldHtml,
      newHtml,
      changes: measured.changes,
      counts: measured.counts,
      etag: etagFor(seed, oldRaw, newRaw),
    };
  })();
  inflight.set(key, job);
  try {
    const value = await job;
    remember(key, value);
    return value;
  } finally {
    inflight.delete(key);
  }
}

// One address, two captures of it: what the compare view opens with.
function comparisonFor(url, from, to, { origin } = {}) {
  return build(keyFor(url, from, to, origin), `${url}|${from}|${to}`, {
    oldUrl: url, oldTs: from, newUrl: url, newTs: to, origin,
  });
}

// Two arbitrary archived pages: the panes' own addresses, after following
// links. Each side keeps its own address and its own timestamp.
function pagesComparison(oldUrl, oldTs, newUrl, newTs, { origin } = {}) {
  return build(keyFor(`${oldUrl}~${newUrl}`, oldTs, newTs, origin), `${oldUrl}@${oldTs}~${newUrl}@${newTs}`, {
    oldUrl, oldTs, newUrl, newTs, origin,
  });
}


// One pane's document on its own (a followed page), routed the same way so a
// page reached by clicking a link looks like the snapshot it came from.
async function paneDocumentFor(url, timestamp, { origin } = {}) {
  const raw = await fetchArchivedHtml(url, timestamp, { interactive: true });
  const html = await routedDocument(raw, { url, timestamp, origin });
  warmStylesheetsFromRaw(raw, { url, timestamp });
  warmImagesFromRaw(raw, { url, timestamp });
  warmStylesheets(html, { url, timestamp });
  return html;
}

module.exports = { comparisonFor, pagesComparison, paneDocumentFor, cache };
