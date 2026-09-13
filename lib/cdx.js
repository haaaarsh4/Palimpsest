// lib/cdx.js
// Talks to the Wayback Machine's CDX Server API, which is the index of
// every snapshot the Archive holds for a given URL. We ask it to collapse
// consecutive identical snapshots (by content digest) so what we get back
// is a clean list of moments where the page's content actually changed,
// not just moments where a crawler happened to visit.

const db = require('../db');
const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const getCached = db.prepare('SELECT payload, fetched_at FROM snapshot_lists WHERE url = ?');
const upsertCached = db.prepare(`
  INSERT INTO snapshot_lists (url, payload, fetched_at) VALUES (@url, @payload, @fetched_at)
  ON CONFLICT(url) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`);

function normalizeInputUrl(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  const u = new URL(value);
  return (u.host + u.pathname).replace(/\/$/, '');
}

async function fetchSnapshotList(rawUrl) {
  const key = normalizeInputUrl(rawUrl);
  const cached = getCached.get(key);
  if (cached && Date.now() - cached.fetched_at < ONE_DAY_MS) {
    return JSON.parse(cached.payload);
  }

  const endpoint =
    'https://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(key)}` +
    '&output=json' +
    '&filter=statuscode:200' +
    '&collapse=digest' +
    '&limit=2000';

  const rows = await schedule(async () => {
    const raw = await fetchText(endpoint, { timeoutMs: 20000 });
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error('The Wayback Machine sent back something unexpected. Try again.');
    }
  });

  const [, ...dataRows] = rows.length ? rows : [[]];

  const snapshots = dataRows.map(([, timestamp, original]) => ({
    timestamp,
    original,
    date: toIsoDate(timestamp),
  }));

  upsertCached.run({ url: key, payload: JSON.stringify(snapshots), fetched_at: Date.now() });
  return snapshots;
}

function toIsoDate(ts) {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8);
  const h = ts.slice(8, 10) || '00', mi = ts.slice(10, 12) || '00', s = ts.slice(12, 14) || '00';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

module.exports = { fetchSnapshotList, normalizeInputUrl };