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

const { db } = require('../db');
const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');
const { prepareCapture, PREPARE_VERSION, CAPTURE_STAMP_NAME } = require('./prepareCapture');

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
  return !/<script|<noscript/i.test(html);
}

// opts.interactive marks a fetch a person is watching a spinner for, which is
// what lets lib/rateLimiter.js serve it ahead of a bulk record walk instead of
// behind the whole of it. Left off, this is a background fetch and is polite.
async function fetchArchivedHtml(url, timestamp, opts = {}) {
  const cacheKey = `${url}::${timestamp}`;

  const cachedResult = await db.execute({
    sql: 'SELECT html FROM snapshot_html WHERE cache_key = ?',
    args: [cacheKey],
  });
  const cached = cachedResult.rows[0];
  if (cached) {
    if (isCurrent(cached.html)) return cached.html;
    // Repair it here rather than serving it. The stored html is a cache of
    // something reproducible, so re-preparing it is safe and idempotent, and it
    // happens once per row. Nothing is written to the Archive for this.
    const repaired = prepareCapture(cached.html, { url, timestamp });
    await db.execute({
      sql: 'UPDATE snapshot_html SET html = ? WHERE cache_key = ?',
      args: [repaired, cacheKey],
    });
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

  return html;
}

module.exports = { fetchArchivedHtml };
