// lib/cdx.js
// Talks to the Wayback Machine's CDX Server API, which is the index of
// every snapshot the Archive holds for a given URL. We ask it to collapse
// consecutive identical snapshots (by content digest) so what we get back
// is a clean list of moments where the page's content actually changed,
// not just moments where a crawler happened to visit.

const { db } = require('../db');
const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The shape of a cached snapshot list. Bumped when the fetch rules change so
// a list read by older rules is refetched rather than trusted: the cache
// holds bare arrays from before versioning, and version 1 is the first
// paginated fetch (see below), which retired the limit=2000 lists that cut
// big records off mid-history.
const SNAPSHOT_LIST_VERSION = 1;
// One page of the index. Large enough that a record is a handful of pages,
// small enough that one slow page does not hold the trace form hostage.
const CDX_PAGE_SIZE = 20000;

function normalizeInputUrl(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  const u = new URL(value);
  return (u.host + u.pathname).replace(/\/$/, '');
}

async function fetchSnapshotList(rawUrl) {
  const key = normalizeInputUrl(rawUrl);

  const cachedResult = await db.execute({
    sql: 'SELECT payload, fetched_at FROM snapshot_lists WHERE url = ?',
    args: [key],
  });
  const cached = cachedResult.rows[0];
  if (cached && Date.now() - Number(cached.fetched_at) < ONE_DAY_MS) {
    try {
      const parsed = JSON.parse(cached.payload);
      // Bare arrays are lists read before versioning (see above): never
      // trust them, they may be cut off mid-history by the old limit.
      if (parsed && parsed.v === SNAPSHOT_LIST_VERSION && Array.isArray(parsed.snapshots)) {
        return parsed.snapshots;
      }
    } catch (_) {
      // A row we cannot read is a row we fetch again.
    }
  }

  const snapshots = await fetchAllSnapshots(key);

  await db.execute({
    sql: `
      INSERT INTO snapshot_lists (url, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
    `,
    args: [key, JSON.stringify({ v: SNAPSHOT_LIST_VERSION, snapshots }), Date.now()],
  });

  return snapshots;
}

// The whole index for one address, not just the first page of it. The CDX
// `limit` caps a single response, and it used to cap the record itself: a
// 2000-row limit ended apple.com in July 2014 while the Archive holds its
// captures to this week, and the timeline, the dashboard and the film all
// read that cut-off list as the whole history. So the index is walked page
// by page (`from` advances past each page) until a page comes back short,
// which is the index saying there is nothing left. Pages overlap by one
// timestamp on purpose — captures share a second, and an exclusive bound
// would drop the ones standing on it — and rows are deduplicated, so the
// overlap is read twice and kept once.
// Live progress for the index walk, so the trace form can say what is
// happening while a slow Archive answers: which page is being read and how
// many captures are on file so far. Keyed by normalized address and deleted
// when the walk ends either way; entries older than ten minutes are treated
// as walks whose caller went away and swept on read.
const walkProgress = new Map(); // key -> { page, rows, startedAt }
const WALK_PROGRESS_TTL_MS = 10 * 60 * 1000;
function snapshotProgress(key) {
  const p = walkProgress.get(key);
  if (!p) return null;
  if (Date.now() - p.startedAt > WALK_PROGRESS_TTL_MS) {
    walkProgress.delete(key);
    return null;
  }
  return { page: p.page, rows: p.rows, elapsedMs: Date.now() - p.startedAt };
}

async function fetchAllSnapshots(key) {
  const seen = new Set();
  const snapshots = [];
  let from = null;
  let page = 0;
  walkProgress.set(key, { page: 0, rows: 0, startedAt: Date.now() });

  try {
  for (;;) {
    page++;
    const endpoint =
      'https://web.archive.org/cdx/search/cdx' +
      `?url=${encodeURIComponent(key)}` +
      '&output=json' +
      '&filter=statuscode:200' +
      '&collapse=digest' +
      `&limit=${CDX_PAGE_SIZE}` +
      (from ? `&from=${encodeURIComponent(from)}` : '');

    // Interactive: this is the request behind the trace form itself, so it
    // jumps ahead of any record walk rather than queueing behind all of it.
    const rows = await schedule(async () => {
      const raw = await fetchText(endpoint, { timeoutMs: 60000 });
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error('The Wayback Machine sent back something unexpected. Try again.');
      }
    }, { interactive: true });

    const [, ...dataRows] = rows.length ? rows : [[]];
    // One line per page in the server log: a big record is minutes of
    // index walking, and silence that long reads as a hung trace.
    console.error(`[cdx] ${key}: page ${page} gave ${dataRows.length} rows`);
    walkProgress.set(key, { page, rows: snapshots.length, startedAt: (walkProgress.get(key) || {}).startedAt || Date.now() });
    let kept = 0;
    for (const [, timestamp, original] of dataRows) {
      if (!/^\d{14}$/.test(String(timestamp || ''))) continue;
      const id = `${timestamp}::${original || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      snapshots.push({
        timestamp,
        original,
        date: toIsoDate(timestamp),
      });
      kept++;
    }
    // A short page is the end of the index. A full page advances the bound
    // past its last timestamp; no advance means no progress, which also ends
    // the walk rather than looping on the same page forever.
    if (dataRows.length < CDX_PAGE_SIZE) break;
    const lastTs = dataRows.length ? String(dataRows[dataRows.length - 1][1] || '') : '';
    if (!lastTs || lastTs === from) break;
    from = lastTs;
    // The bound is inclusive, so the page ahead re-reads the boundary rows;
    // the dedupe above keeps them once. But a boundary that keeps producing
    // only already-seen rows is also the end, whatever the page size says.
    if (!kept) break;
  }

  snapshots.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return snapshots;
  } finally {
    walkProgress.delete(key);
  }
}

function toIsoDate(ts) {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8);
  const h = ts.slice(8, 10) || '00', mi = ts.slice(10, 12) || '00', s = ts.slice(12, 14) || '00';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

module.exports = { fetchSnapshotList, normalizeInputUrl, snapshotProgress };
