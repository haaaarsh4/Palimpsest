// lib/fetchHtml.js
// Given a URL and an exact snapshot timestamp, this fetches the page as it
// looked at that moment, using Wayback's "if_" (iframe) mode. That mode
// does two things at once: it suppresses the Wayback toolbar, and it keeps
// Wayback's own link-rewriting, so every stylesheet, image, and script tag
// in the page already points at a working archived URL instead of a
// relative path that has nothing to resolve against once the page is
// sitting in our iframe.
//
// The actual network request goes through lib/httpGet.js, which decodes
// compression itself rather than relying on fetch()'s automatic behavior,
// since that's what was silently corrupting snapshots before.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { db } = require('../db');
const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');
const { prepareCapture, PREPARE_VERSION, CAPTURE_STAMP_NAME } = require('./prepareCapture');

// A copy of every prepared capture, on this machine's disk.
//
// The database is the shared, permanent copy, but it is remote (Turso): reading
// one prepared page out of it is a round trip over the internet for a 700KB row,
// and the compare view reads two of them before it can draw anything. Measured
// on nytimes.com's 2026 front page: 3.9 seconds of a warm comparison were that
// read. The disk copy turns it into a file read, which is what makes coming back
// to a comparison - or opening the pane's home again - feel instant instead of
// like a new request.
//
// It is a cache, so it is allowed to be missing or stale: every path below still
// falls back to the database and then to the Archive, and nothing is written
// here that would not be written there. The data/ directory is already outside
// version control (see .gitignore) and data/assets/ already works this way for
// the film's pictures.
const CAPTURE_DIR = path.join(__dirname, '..', 'data', 'captures');
const MEMORY_LIMIT = 24;
const memory = new Map(); // cacheKey -> prepared html, most recent last

function captureFile(cacheKey) {
  return path.join(CAPTURE_DIR, crypto.createHash('sha1').update(cacheKey).digest('hex') + '.html');
}

function rememberInMemory(cacheKey, html) {
  try {
    memory.delete(cacheKey);
    memory.set(cacheKey, html);
    while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  } catch (_) { /* the copies below still stand */ }
}

async function readDiskCapture(cacheKey) {
  try {
    const html = await fsp.readFile(captureFile(cacheKey), 'utf8');
    return html || null;
  } catch (_) {
    return null;
  }
}

async function writeDiskCapture(cacheKey, html) {
  try {
    await fsp.mkdir(CAPTURE_DIR, { recursive: true });
    await fsp.writeFile(captureFile(cacheKey), html);
  } catch (_) { /* the database copy is the permanent one */ }
}

// How many captures are already on this machine, for the dashboard's own
// accounting of what a visit costs.
async function localCaptureCount() {
  try {
    const files = await fsp.readdir(CAPTURE_DIR);
    return files.filter((f) => f.endsWith('.html')).length;
  } catch (_) {
    return 0;
  }
}

const STAMP_RE = new RegExp(`<meta name="${CAPTURE_STAMP_NAME}" content="(\\d+)"`, 'i');

// Was this row written by the pipeline that is running now? A row that was not
// still renders, which is the danger: an older prepare left a page with the
// Wayback bundle in it and no base href, so it arrives as a plausible-looking
// page whose stylesheets 404 against this app. The browser checks the same
// stamp and refuses the document, which means it asks for that capture again on
// every single frame of the film.
function isCurrent(html) {
  if (typeof html !== 'string' || !html) return false;
  const m = STAMP_RE.exec(html);
  if (!m || Number(m[1]) !== PREPARE_VERSION) return false;
  // Comments are not elements: an IE conditional comment can carry a
  // `<script ...>` string that no parser ever instantiates (the browser
  // store checks this with a real DOM for the same reason). Testing the
  // raw string would flunk every read of such a row and re-prepare it
  // forever instead of serving it.
  return !/<script|<noscript/i.test(html.replace(/<!--[\s\S]*?-->/g, ''));
}

function stampedVersion(html) {
  const m = STAMP_RE.exec(String(html || ''));
  return m ? Number(m[1]) : 0;
}

// Rows stamped before this lost something re-preparing cannot put back: the
// pipeline strips scripts, so anything derived from a script (revision 9's
// loader-injected stylesheets) is unrecoverable from the stored row. Those
// rows refetch the raw capture once instead of being repaired in place.
// Re-preparing stays the path for rows at or above this floor: their fixes
// only ever needed the surviving markup. If a future revision needs the
// scripts again, it moves this floor, not the repair.
const REPREPARE_FLOOR = 9;

// opts.interactive marks a fetch a person is watching a spinner for, which is
// what lets lib/rateLimiter.js serve it ahead of a bulk record walk instead of
// behind the whole of it. Left off, this is a background fetch and is polite.
async function fetchArchivedHtml(url, timestamp, opts = {}) {
  const cacheKey = `${url}::${timestamp}`;

  // The closest copy first: this process's memory, then this machine's disk,
  // then the shared database, and only then the Archive itself.
  const fromMemory = memory.get(cacheKey);
  if (fromMemory && isCurrent(fromMemory)) return fromMemory;

  const fromDisk = await readDiskCapture(cacheKey);
  if (fromDisk && isCurrent(fromDisk)) {
    rememberInMemory(cacheKey, fromDisk);
    return fromDisk;
  }

  const cachedResult = await db.execute({
    sql: 'SELECT html FROM snapshot_html WHERE cache_key = ?',
    args: [cacheKey],
  });
  const cached = cachedResult.rows[0] || (fromDisk ? { html: fromDisk } : null);
  if (cached) {
    if (isCurrent(cached.html)) {
      rememberInMemory(cacheKey, cached.html);
      writeDiskCapture(cacheKey, cached.html);
      return cached.html;
    }
    if (stampedVersion(cached.html) < REPREPARE_FLOOR) {
      // Too old to repair: refetch the raw capture so the current pipeline
      // sees the scripts it derives content from. A failed refetch falls
      // back to the in-place repair rather than failing the pane.
      try {
        const endpoint = `https://web.archive.org/web/${timestamp}if_/${url}`;
        const fresh = prepareCapture(
          await schedule(() => fetchText(endpoint), opts),
          { url, timestamp }
        );
        await db.execute({
          sql: 'UPDATE snapshot_html SET html = ?, fetched_at = ? WHERE cache_key = ?',
          args: [fresh, Date.now(), cacheKey],
        });
        rememberInMemory(cacheKey, fresh);
        writeDiskCapture(cacheKey, fresh);
        return fresh;
      } catch (_) { /* fall through to the in-place repair below */ }
    }
    // Repair it here rather than serving it. The stored html is a cache of
    // something reproducible, so re-preparing it is safe and idempotent, and it
    // happens once per row. Nothing is written to the Archive for this.
    const repaired = prepareCapture(cached.html, { url, timestamp });
    await db.execute({
      sql: 'UPDATE snapshot_html SET html = ? WHERE cache_key = ?',
      args: [repaired, cacheKey],
    });
    rememberInMemory(cacheKey, repaired);
    writeDiskCapture(cacheKey, repaired);
    return repaired;
  }

  const endpoint = `https://web.archive.org/web/${timestamp}if_/${url}`;

  // Prepared BEFORE it is cached, and stored in exactly the form it is served
  // in. Both halves matter: a cached row is permanent and every reader gets it,
  // and the cache-hit path above returns the stored row verbatim, so storing
  // anything other than the served document makes the first read of a capture
  // correct and every later read wrong.
  //
  // prepareCapture is the same function the compare view runs, so a capture
  // renders identically in either. See lib/prepareCapture.js for why this
  // parses the page instead of rewriting the string.
  const html = prepareCapture(
    await schedule(() => fetchText(endpoint), opts),
    { url, timestamp }
  );

  // ON CONFLICT DO NOTHING guards against two concurrent requests for the
  // same url+timestamp both racing to cache the same row - harmless
  // either way, but this avoids a redundant write attempt erroring out.
  await db.execute({
    sql: `
      INSERT INTO snapshot_html (cache_key, url, timestamp, html, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO NOTHING
    `,
    args: [cacheKey, url, timestamp, html, Date.now()],
  });
  rememberInMemory(cacheKey, html);
  writeDiskCapture(cacheKey, html);

  return html;
}

module.exports = { fetchArchivedHtml, localCaptureCount, CAPTURE_DIR };
