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

async function fetchArchivedHtml(url, timestamp) {
  const cacheKey = `${url}::${timestamp}`;

  const cachedResult = await db.execute({
    sql: 'SELECT html FROM snapshot_html WHERE cache_key = ?',
    args: [cacheKey],
  });
  const cached = cachedResult.rows[0];
  if (cached) return cached.html;

  const endpoint = `https://web.archive.org/web/${timestamp}if_/${url}`;
  const html = await schedule(() => fetchText(endpoint));

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
