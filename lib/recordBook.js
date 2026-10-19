// lib/recordBook.js
//
// One site's whole record, assembled on the server, in one request.
//
// ## Why this exists
//
// A record of 741 captures used to reach the browser as 741 separate requests:
// one per adjacent pair of captures, each one a round trip that re-read both
// pages from the database, re-ran the diff, and shipped ~50KB of JSON. The
// browser could not begin until the last of them landed, and at the rate the
// server could turn them around that was about a hundred seconds of a progress
// card for a record the database had held, in full, the entire time.
//
// The same 741 captures are one `SELECT` and three seconds. So they are read
// as one, cached in memory as one, and sent as one, and the film opens on the
// first response instead of the seven hundred and forty-first.
//
// ## The two halves of a record, and why they are read separately
//
// A record is documents (the pages themselves) and numbers (what changed to
// reach each page). They have very different costs:
//
//   documents  37MB for settlement.org, one query, ~3s, and they never change.
//   numbers    one diff per pair at ~66ms, so ~50s for that same record, and
//              also never change, they are reproducible from the documents.
//
// Reading them together would mean the film waiting fifty seconds for numbers
// it shows one caption at a time. So the documents are sent the moment they are
// asked for, and the numbers are compiled here, once per site, in the
// background, and written to record_steps so that every later reading of that
// site, the film, the dashboard, another tab, next month, gets them for the
// price of one small query.
//
// ## Why the compile lives on the server
//
// Because it is the same answer for everyone. Computing it in the browser meant
// every tab, every session, and both views paying the same fifty seconds again,
// and paying it in requests. Here it happens once, it survives a reload, it is
// resumable (a restart loses nothing; the rows already written are read back),
// and the loop yields to the event loop as it goes so a long compile cannot
// make the server stop answering.

const { db } = require('../db');
const { measurePair, stepNumbers } = require('./measurePair');

// The shape of a compiled step. Bump this when the diff engine's output
// changes, and every stored row is retired rather than mixed with numbers
// measured by different rules, the same contract snapshot_html's stamp has.
// 2: links and images are compared by where they point rather than by how the
//    archive spelled them, and a run of changed leaves is paired by similarity
//    instead of by tag order. Both change the numbers, so the old ones go.
// 3: every step is measured through the shared pipeline (lib/measurePair.js),
//    the same diff plus the same silent-image promotions and proven-no-op
//    demotions the compare view applies, so the dashboard counts what the
//    changes list counts. Single-letter link runs also merge into their line.
//    All three change the numbers, so the old ones go.
const RECORD_STEPS_VERSION = 3;

// Assembled records kept in memory. A record is tens of megabytes, so this is
// deliberately tiny: what it is for is the second and third reader of the
// record that is already open (the film after the dashboard, a reload, a
// second tab), not for holding a library.
const DOCS_MEMO_MAX = 2;

// Pairs per write, and how long one slice of the compile may hold the thread
// before yielding. The diff is synchronous, so the yield is what keeps a fifty
// second compile from being fifty seconds of a frozen server.
const COMPILE_WRITE_BATCH = 24;
const COMPILE_TICK_MS = 120;

// url -> { count, rows: [[ts, html], ...], json }
const docsMemo = new Map();

// url -> the compile in flight or the last one to finish
const compiles = new Map();

function memoGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  map.delete(key);
  map.set(key, hit);   // most recently used last
  return hit;
}

function memoPut(map, key, value, max) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * Every capture of this address that is already on file, in order, as
 * `[[timestamp, html], ...]`, plus the same array already stringified, because
 * it is sent as part of a JSON body and stringifying 37MB of markup again for
 * every reader would be work nobody asked for.
 *
 * Keyed on the row count as well as the url: when a walk adds captures the
 * count changes, the memo misses, and the next reader gets the longer record
 * rather than a stale one.
 */
async function recordDocs(url) {
  const counted = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM snapshot_html WHERE url = ?',
    args: [url],
  });
  const count = Number(counted.rows[0] ? counted.rows[0].n : 0);

  const hit = memoGet(docsMemo, url);
  if (hit && hit.count === count) return hit;

  let rows = [];
  if (count) {
    const result = await db.execute({
      sql: 'SELECT timestamp, html FROM snapshot_html WHERE url = ? ORDER BY timestamp',
      args: [url],
    });
    rows = result.rows.map((r) => [String(r.timestamp), String(r.html)]);
  }

  const entry = { count, rows, json: JSON.stringify(rows) };
  memoPut(docsMemo, url, entry, DOCS_MEMO_MAX);
  return entry;
}

/**
 * One slice of a record's documents, read as a slice: the count plus only
 * the rows asked for, in timestamp order. The full-record read above loads
 * tens of megabytes and stringifies them on every call, so anything that
 * serves a page of captures (the record route's from/limit batches, the
 * film's behind-playback streamer) comes here instead and costs one small
 * indexed query rather than the whole history.
 */
async function recordDocsPage(url, from, limit) {
  const counted = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM snapshot_html WHERE url = ?',
    args: [url],
  });
  const count = Number(counted.rows[0] ? counted.rows[0].n : 0);
  if (!count) return { count: 0, rows: [] };
  const result = await db.execute({
    sql: 'SELECT timestamp, html FROM snapshot_html WHERE url = ? ORDER BY timestamp LIMIT ? OFFSET ?',
    args: [url, Math.max(1, limit), Math.max(0, from)],
  });
  return { count, rows: result.rows.map((r) => [String(r.timestamp), String(r.html)]) };
}

/**
 * Start this address's background compile when one is actually needed, and
 * do nothing otherwise. The check is a count plus the in-flight job, never
 * the documents: polling views ask every second or two, and answering each
 * poll with a thirty-seven megabyte read is what made the dashboard crawl
 * while numbers were still arriving. The full document read happens at most
 * once per record growth, when a new compile genuinely starts.
 */
async function ensureCompileForUrl(url) {
  const existing = compiles.get(url);
  if (existing && !existing.finished) return existing;
  const count = await recordCount(url);
  if (existing && existing.finished && existing.docCount === count && !existing.failed) return existing;
  if (!count) return existing || null;
  const docs = await recordDocs(url);
  return ensureCompile(url, docs);
}

/** The numbers already compiled for this address, keyed by capture timestamp. */
/** How many captures of this address are on file. One count, no documents. */
async function recordCount(url) {
  const counted = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM snapshot_html WHERE url = ?',
    args: [url],
  });
  return Number(counted.rows[0] ? counted.rows[0].n : 0);
}

async function recordSteps(url) {
  const result = await db.execute({
    sql: 'SELECT timestamp, counts, tags, totals FROM record_steps WHERE url = ? AND version = ?',
    args: [url, RECORD_STEPS_VERSION],
  });
  const map = new Map();
  for (const row of result.rows) {
    let counts, tags;
    try {
      counts = JSON.parse(String(row.counts));
      tags = JSON.parse(String(row.tags));
    } catch (_) {
      continue;   // a row we cannot read is a row we measure again
    }
    map.set(String(row.timestamp), { counts, tagCounts: tags, totals: Number(row.totals) || 0 });
  }
  return map;
}

/** The same thing for one pair, used by the step endpoint's write-through. */
async function readStep(url, timestamp) {
  const result = await db.execute({
    sql: 'SELECT counts, tags, totals FROM record_steps WHERE cache_key = ? AND version = ?',
    args: [`${url}::${timestamp}`, RECORD_STEPS_VERSION],
  });
  const row = result.rows[0];
  if (!row) return null;
  try {
    return { counts: JSON.parse(String(row.counts)), tagCounts: JSON.parse(String(row.tags)), totals: Number(row.totals) || 0 };
  } catch (_) {
    return null;
  }
}

async function writeSteps(url, rows) {
  if (!rows.length) return;
  const values = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const args = [];
  const now = Date.now();
  for (const row of rows) {
    args.push(
      `${url}::${row.ts}`, url, row.ts,
      JSON.stringify(row.counts), JSON.stringify(row.tagCounts || {}),
      Number(row.totals) || 0, RECORD_STEPS_VERSION, now
    );
  }
  await db.execute({
    sql: `
      INSERT INTO record_steps (cache_key, url, timestamp, counts, tags, totals, version, computed_at)
      VALUES ${values}
      ON CONFLICT(cache_key) DO UPDATE SET
        counts = excluded.counts,
        tags = excluded.tags,
        totals = excluded.totals,
        version = excluded.version,
        computed_at = excluded.computed_at
    `,
    args,
  });
}

/** Where the compile for this address has got to, for anything that wants to say so. */
function compileState(url) {
  const job = compiles.get(url);
  if (!job) return { running: false, done: 0, total: 0, known: false, failed: false };
  return {
    running: !job.finished,
    done: job.done,
    total: job.total,
    known: true,
    failed: !!job.failed,
    // Every pair this compile set out to measure has been measured, and it is
    // not still working: the numbers for this record are complete and stay
    // complete until the record grows, which a later full request notices.
    settled: job.finished && !job.failed && job.done === job.total,
  };
}

/**
 * Compile this address's numbers, unless they are already being compiled or
 * already are. Returns the job so a caller can report progress; never rejects,
 * because a compile that fails is a compile that will be tried again on the
 * next open, not an error the film has to know about.
 */
function ensureCompile(url, docs) {
  const existing = compiles.get(url);
  if (existing && !existing.finished) return existing;
  // Finished, and for exactly this record: nothing left to do.
  if (existing && existing.docCount === docs.count && existing.total === existing.done && !existing.failed) return existing;

  const job = { url, docCount: docs.count, done: 0, total: 0, finished: false, failed: false };
  compiles.set(url, job);
  job.promise = compile(url, job, docs)
    .catch((err) => {
      console.error(`Could not compile the record for ${url}:`, err);
      job.failed = true;
    })
    .finally(() => { job.finished = true; });
  return job;
}

async function compile(url, job, docs) {
  const already = await recordSteps(url);
  const pairs = [];
  for (let i = 0; i + 1 < docs.rows.length; i++) {
    if (!already.has(docs.rows[i + 1][0])) pairs.push(i);
  }

  job.total = pairs.length;
  if (!pairs.length) return;

  let batch = [];
  let tickAt = Date.now();

  for (let k = 0; k < pairs.length; k++) {
    const i = pairs[k];
    try {
      // The shared pipeline, so the compiled numbers are the compare view's
      // numbers: silent image changes promoted, proven no-ops demoted. The
      // annotated documents are discarded; only the numbers are compiled.
      // Costs more per pair than the bare diff (two serializations plus, for
      // pairs with candidate pictures, the image bytes), which is why this
      // stays a background job whose rows are written once and read forever.
      const measured = await measurePair(docs.rows[i][1], docs.rows[i + 1][1], {
        tsFrom: docs.rows[i][0],
        tsTo: docs.rows[i + 1][0],
      });
      batch.push({ ts: docs.rows[i + 1][0], ...stepNumbers(measured) });
    } catch (err) {
      // One pair the engine cannot read is one pair without numbers, which the
      // rail already draws honestly. The rest of the record is still compiled.
      console.error(`Could not measure ${url} at ${docs.rows[i + 1][0]}:`, err);
    }
    job.done++;

    if (batch.length >= COMPILE_WRITE_BATCH || Date.now() - tickAt >= COMPILE_TICK_MS) {
      const flushing = batch;
      batch = [];
      await writeSteps(url, flushing);
      await new Promise((r) => setImmediate(r));
      tickAt = Date.now();
    }
  }

  await writeSteps(url, batch);
}

module.exports = { recordDocs, recordDocsPage, ensureCompileForUrl, recordCount, recordSteps, readStep, writeSteps, compileState, ensureCompile, RECORD_STEPS_VERSION };
