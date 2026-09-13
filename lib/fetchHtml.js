// lib/fetchHtml.js
// Given a URL and an exact snapshot timestamp, this fetches the page as it
// looked at that moment, using Wayback's "if_" (iframe) mode. That mode
// does two things at once: it suppresses the Wayback toolbar, and it keeps
// Wayback's own link-rewriting, so every stylesheet, image, and script tag
// in the page already points at a working archived URL instead of a
// relative path that has nothing to resolve against once the page is
// sitting in our iframe. That's what makes the page actually look right,
// instead of bare unstyled text with broken images.
//
// (We tried the "id_" raw mode plus a manual <base> tag first, but that
// breaks for the most common kind of link on real sites: a root-relative
// path like "/css/style.css" resolves against a <base> tag to entirely the
// wrong place, since the browser drops everything after the domain rather
// than everything after the timestamp. "if_" avoids that problem
// completely because Wayback has already made every link absolute.)
//
// The actual network request goes through lib/httpGet.js, which decodes
// compression itself rather than relying on fetch()'s automatic behavior,
// since that's what was silently corrupting snapshots before.

const db = require('../db');
const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');

const getCached = db.prepare('SELECT html FROM snapshot_html WHERE cache_key = ?');
const insertCached = db.prepare(`
  INSERT INTO snapshot_html (cache_key, url, timestamp, html, fetched_at)
  VALUES (@cache_key, @url, @timestamp, @html, @fetched_at)
`);

async function fetchArchivedHtml(url, timestamp) {
  const cacheKey = `${url}::${timestamp}`;
  const cached = getCached.get(cacheKey);
  if (cached) return cached.html;

  const endpoint = `https://web.archive.org/web/${timestamp}if_/${url}`;
  const html = await schedule(() => fetchText(endpoint));

  insertCached.run({ cache_key: cacheKey, url, timestamp, html, fetched_at: Date.now() });
  return html;
}

module.exports = { fetchArchivedHtml };