// lib/assetCache.js
//
// The Archive is expensive in a way that no amount of client-side cleverness
// can fix: a resource it has not served recently comes back out of cold storage
// and costs it two to three seconds, its own server-timing header says so, and
// the browser re-requests those assets for every capture it renders, because a
// capture's markup names them with that capture's own timestamp and the response
// does not survive in the HTTP cache. A film of a site's history therefore pays
// seconds per picture, per frame, forever.
//
// So the app keeps its own copy. Every asset a capture references is fetched
// ONCE, from wherever the Archive keeps it, and written to data/assets/. From
// then on it is a file read served over loopback, milliseconds, on any later
// frame, in any later session, on any machine that has this checkout. Fidelity
// is the Archive's own rewriting honored: the URL a frame asks for carries the
// timestamp the markup chose, so the picture is the version that capture saw.
//
// Files rather than the database: assets are binary, they are large, and the
// database here is remote (Turso) where a few hundred images per site would cost
// bandwidth on every read. data/ is already outside version control.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'assets');

// The revision of what this app hands back for one address.
//
// An asset's response lives in two caches, and one of them cannot be told to
// change its mind: the browser is promised `immutable, max-age=1y`, so a
// stylesheet it has already been given is never asked for again, which means a
// fix to how a stylesheet is rewritten could never reach a browser that had
// seen the broken one. Bumping this changes the address the client asks for
// (public/timelapse.js appends the same number), and the key this cache reads,
// so a correction to an asset's contents arrives here and there at once.
//
// 1 -> 2: stylesheets' own url() references. The Archive writes nearly every
// asset reference as a root-relative `/web/<timestamp><modifier>/<original>`,
// and the first revision of this file only recognised the shape that names
// web.archive.org, so the rest were resolved against the stylesheet's own
// address, and every font and background image in every cached sheet pointed at
// a URL on the original site that does not exist.
//
// 2 -> 3: a picture the Archive does not hold. It answers 200 with its own HTML
// "not available" page, which the browser then refuses to decode and draws as a
// broken-image glyph, in the film and in every downloaded frame. Revision 3
// answers those with a blank pixel (see asPicture), and the address has to change
// for the same reason as above: the wrong answer is already immutable in
// somebody's browser cache.
//
// 3 -> 4: the answers a failure used to leave behind. A request that was refused,
// timed out or dropped served a 404 (nothing drawn: a broken-image glyph with the
// markup's alt text spilled across the design), and a picture the Archive
// answered its own HTML page for served a blank pixel - both cached here and in
// the browser as immutable for a year. The fetch is retried now
// (fetchArchiveWithRetry) and the panes silence what still cannot be drawn, but
// neither correction can reach a browser holding the old answer under the old
// address, so the address moves. Sheets are refetched once because of it (their
// key carries this number); pictures' bytes are re-asked only where the browser
// had stored the wrong answer.
const ASSET_VERSION = 4;
// The client's rack gives up at 25s; this has to answer before that, or a cold
// asset is asked for twice and the second ask waits for the first. The Archive
// answering slower than this is the Archive having a bad moment, and the answer
// to that is a retry, not a longer wait.
const TIMEOUT_MS = 20000;
const MAX_BYTES = 12 * 1024 * 1024;
// The Archive is one origin with a fixed appetite, and its rate rule is about
// how often its *index* is asked, which lib/rateLimiter.js enforces on the CDX
// calls. Assets are a different service - a CDN fronting stored files - and a
// cold one costs two to three seconds however few of them we ask for at once,
// so the width here decides how long a pane waits for its stylesheets: at six,
// a page with thirty sheets is five rounds of the Archive being slow. Ten
// keeps it to three, and is still an order of magnitude fewer sockets than the
// browser itself opens for the same page.
const WIDTH = 10;

const inflight = new Map();   // key -> Promise<asset|null>, so a URL is fetched once
let active = 0;
const queue = [];

function withSlot(fn) {
  return new Promise((resolve) => {
    const run = () => {
      active++;
      fn().then(resolve).catch(() => resolve(null)).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < WIDTH) run();
    else queue.push(run);
  });
}

function keyFor(mod, ts, url) {
  return crypto.createHash('sha1').update(`${mod}|${ts}|${url}`).digest('hex');
}

// Is this asset a stylesheet? Asked before anything is fetched, because the
// answer decides which key it is stored under: a sheet's body is rewritten by
// this app (see rewriteCss), so it is only as good as the revision that
// rewrote it, and a stored sheet from an older revision has to be re-fetched
// rather than served.
function isSheet(mod, url) {
  return /^cs_?$/i.test(String(mod || '')) || /\.css(\?|$)/i.test(String(url || ''));
}

// The key an asset is read and written under. Non-stylesheets keep the plain
// key: their bytes are the Archive's, and no revision of this file changes
// them, so there is nothing to invalidate and no reason to fetch them again.
function cacheKey(mod, ts, url) {
  return keyFor(mod, ts, url) + (isSheet(mod, url) ? '.r' + ASSET_VERSION : '');
}

function typePath(key) { return path.join(DIR, key + '.type'); }
function bodyPath(key) { return path.join(DIR, key); }

// What we ask the Archive for. The modifier the capture used is preserved: im_
// for pictures, cs_ for stylesheets, js_ for scripts, id_ or nothing for the
// documents themselves. Normalized here rather than trusted from the client,
// because the markup writes the modifier with its slash ("im_/") and the
// Archive's URL shape wants it once.
function archiveUrl(mod, ts, url) {
  const clean = String(mod || '').replace(/[^a-z_]/gi, '');
  return `https://web.archive.org/web/${ts}${clean ? clean + '/' : '/'}${url}`;
}

// A URL written inside a stylesheet or a page, made absolute, then made ours.
// The Archive's own prefixes are unwrapped first, so an already-rewritten URL
// keeps the timestamp the Archive picked for it.
//
// The two shapes the Archive writes are both here, and the second is the one
// that matters: a capture's own markup and stylesheets name nearly every asset
// as a root-relative `/web/<timestamp><modifier>/<original>`, which names no
// host at all. Without this branch that URL is resolved against the stylesheet's
// own address and the app asks the Archive for `http://settlement.org/web/2015
// 0212172748im_/http://settlement.org/fonts/…`, the site's own /web/ path,
// which does not exist, so every font and every background image in the sheet
// was fetched, refused, and never tried again.
const ARCHIVE_PREFIX = /^(?:https?:)?(?:\/\/web\.archive\.org)?\/web\/(\d{14})([a-z_]*)\/(.+)$/i;

function toProxy(raw, baseMod, baseTs, baseUrl) {
  let mod = baseMod;
  let ts = baseTs;
  let url = raw;
  // Matched against the URL as it was written before it is resolved, because a
  // root-relative reference stops being recognisable the moment it is made
  // absolute: `new URL('/web/2015…im_/…', 'http://settlement.org/Site.css')` is
  // a path on settlement.org, which is exactly the mistake this avoids.
  const written = ARCHIVE_PREFIX.exec(raw);
  const abs = (() => {
    try { return new URL(raw, baseUrl).toString(); } catch (_) { return null; }
  })();
  const m = written || (abs ? ARCHIVE_PREFIX.exec(abs) : null);
  if (m) { ts = m[1]; mod = m[2] || mod; url = m[3]; }
  else if (abs) { url = abs; }
  else return null;
  return proxyPath(mod, ts, url);
}

// `origin` is what makes the address usable inside an archived page, and it is
// not optional there. A capture's markup carries <base href="https://web.
// archive.org/web/<ts>/<url>">, so every root-relative reference in that
// document - which is how these addresses are written - resolves against the
// Archive, not against us: the pane's own <link rel=stylesheet href="/api/
// asset?..."> asked web.archive.org for /api/asset, got a 404, and the pane
// rendered unstyled ("there is no CSS in here"). An absolute address to this
// app cannot be re-based by anything, which is why the panes get one. Inside a
// stylesheet the relative form is kept: a sheet's own address is the base
// there, so it resolves correctly and stays portable.
function proxyPath(mod, ts, url, origin) {
  return `${origin || ''}/api/asset?m=${encodeURIComponent(mod)}&t=${ts}&u=${encodeURIComponent(url).replace(/'/g, '%27')}&v=${ASSET_VERSION}`;
}

// Stylesheets are the one asset whose contents name other assets, so a sheet
// cached here has to point at this cache too, otherwise every picture it
// mentions is fetched from the Archive by the browser, which is the cost this
// file exists to remove.
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

function rewriteCss(text, mod, ts, url) {
  const fix = (m, quote, raw) => {
    if (/^(data|blob|about):/i.test(raw)) return m;
    const next = toProxy(raw, mod === 'cs_' ? 'im_' : mod, ts, url);
    return next ? `url(${quote}${next}${quote})` : m;
  };
  const fixImport = (m, quote, raw) => {
    const next = toProxy(raw, 'cs_', ts, url);
    return next ? `@import ${quote}${next}${quote}` : m;
  };
  return text.replace(CSS_URL, fix).replace(CSS_IMPORT, fixImport);
}

// One request to the Archive, in one of its replay flavours.
//
// Answers `{ asset, retry }`: the asset (possibly with an empty body, which is
// a *specific* answer - see fetchArchive below), and whether the failure, when
// there was one, is the kind another ask could fix. A 404 or a 410 is the
// Archive saying it does not have this file: final. A 429, a 5xx, a dropped
// connection or a timeout is the Archive having a bad minute, and a picture
// that is missing from a pane because of one of those is precisely the bug the
// whole cache exists to prevent.
async function fetchArchiveOnce(mod, ts, url) {
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(archiveUrl(mod, ts, url), {
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined,
      headers: { 'user-agent': 'palimpsest/1.0 (local history viewer)' },
    });
    if (!res.ok) {
      const retry = res.status === 429 || res.status >= 500;
      return { asset: null, retry };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { asset: null, retry: false };
    const mime = normaliseType(res.headers.get('content-type'), url);
    if (/css/i.test(mime) || /\.css(\?|$)/i.test(url)) {
      return {
        asset: { body: Buffer.from(rewriteCss(buf.toString('utf8'), mod, ts, url), 'utf8'), mime: 'text/css' },
        retry: false,
      };
    }
    return { asset: { body: buf, mime }, retry: false };
  } catch (_) {
    return { asset: null, retry: true };
  } finally {
    clearTimeout(timer);
  }
}

// The retry policy: a fast failure is worth asking again (the Archive's rate
// limiter or a dropped socket answers in milliseconds), a slow one is not -
// waiting out a 20s timeout twice only makes the pane slower, and the browser's
// own repair pass (public/app.js, settleBrokenPictures) re-asks later anyway.
const RETRY_DELAYS_MS = [400, 1200];
const RETRY_FAST_MS = 5000;

// Not unref'd: this timer is a step in an awaited fetch, and a process with
// nothing else to do must still wait it out rather than exit with the retry
// pending (measured with the test runner, which reported exactly that).
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArchiveWithRetry(mod, ts, url) {
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    const result = await fetchArchiveOnce(mod, ts, url);
    const elapsed = Date.now() - started;
    const worthAskingAgain = result.retry && elapsed < RETRY_FAST_MS && attempt < RETRY_DELAYS_MS.length;
    if (!worthAskingAgain) return result;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

// An asset, fetched the way the Archive will actually hand it over.
//
// The first attempt uses the modifier the capture itself wrote - `im_` for a
// picture, `cs_` for a stylesheet - because that is the flavour the Archive
// rewrites links inside, and older captures were replayed with it. But for any
// URL the exact capture timestamp does not hold, `cs_` (and the bare form)
// answers **200 with an empty body** instead of redirecting: measured on
// nytimes.com's 2026 front page, where 21 of 29 stylesheets came back that
// way, so the pane rendered as an unstyled list of links and every reader
// reasonably concluded the app was broken. The same files answer in full
// through `id_`, which redirects to the nearest capture and returns the bytes
// as the server sent them.
//
// So an empty answer gets exactly one more try, as `id_`. Nothing else is
// retried: a 404 - the Archive really does not hold this file - is final, and
// retrying it would triple the requests this cache makes for files nobody has.
async function fetchArchive(mod, ts, url) {
  const first = (await fetchArchiveWithRetry(mod, ts, url)).asset;
  if (first && first.body && first.body.length) return first;
  if (!first) return null; // not held, too large, or the Archive never answered
  if (mod === 'id_') return null;
  const raw = (await fetchArchiveWithRetry('id_', ts, url)).asset;
  if (raw && raw.body && raw.body.length) return raw;
  return null;
}

const TYPES = {
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  css: 'text/css', js: 'application/javascript', json: 'application/json',
  html: 'text/html', htm: 'text/html', txt: 'text/plain',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject', swf: 'application/x-shockwave-flash',
  pdf: 'application/pdf',
};

// A one-pixel transparent GIF, and the type it answers with. It is what a
// picture the Archive does not hold becomes, see asPicture below.
const BLANK_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);
const IMAGE_EXT = /[.](gif|png|jpe?g|webp|svg|ico|bmp)$/i;

function guessType(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  return TYPES[ext] || null;
}

// The Archive answers a lot of requests with application/octet-stream, whatever
// the file actually is, web fonts especially, and a font the browser cannot
// identify is a font it will not use. Where the Archive is vague and the address
// is not, the address wins: it is the file's own name, and it is what the
// document's own <link> or src attribute was written against.
function normaliseType(headerType, url) {
  const said = (headerType || '').split(';')[0].trim();
  if (said && !/^application\/octet-stream$/i.test(said)) return said;
  return guessType(url) || said || 'application/octet-stream';
}

// A picture the Archive does not hold, answered properly.
//
// Ask for an image a given capture never had, and this record is full of them:
// the 2000 captures reference a splash image that only the 1999 one kept, and
// the Archive replies 200 with its own HTML "this capture is not available"
// page, not a 404. The browser is then handed 23KB of HTML as an image, fails to
// decode it, and draws the broken-picture glyph with the markup's alt text beside
// it, in the film and in every downloaded frame. Measured on settlement.org's
// first six captures: two of their images come back this way.
//
// The address is what settles it. An image address can never legitimately answer
// text/html, so a stored type of text/html under one is the Archive saying it
// does not have this file, and the honest rendering of a picture that is not on
// file is not a broken glyph but a blank space where it was.
//
// Applied on the way out of both halves of the cache, cached rows included: the
// .type file already records the answer, so this needs no re-fetch and no version
// marker to reach a machine that stored the HTML earlier.
function asPicture(url, asset) {
  if (!asset || !IMAGE_EXT.test(String(url).split('?')[0])) return asset;
  if (!/^text\/html/i.test(asset.mime || '')) return asset;
  return { body: BLANK_PIXEL, mime: 'image/gif' };
}

async function readCached(key) {
  try {
    const body = await fsp.readFile(bodyPath(key));
    let mime = '';
    try { mime = (await fsp.readFile(typePath(key), 'utf8')).trim(); } catch (_) {}
    return { body, mime: mime || 'application/octet-stream' };
  } catch (_) {
    return null;
  }
}

// One asset: from disk if it is here, otherwise from the Archive, cached for
// every later ask. A miss that fails is not cached as a failure, the Archive
// having a bad minute should not become this cache's permanent opinion.
async function getAsset(mod, ts, url) {
  const key = cacheKey(mod, ts, url);
  const hit = await readCached(key);
  if (hit) return asPicture(url, hit);

  if (inflight.has(key)) return inflight.get(key);
  const job = withSlot(() => fetchArchive(mod, ts, url)).then(async (asset) => {
    inflight.delete(key);
    if (!asset) return null;
    const served = asPicture(url, asset);
    await fsp.mkdir(DIR, { recursive: true });
    // The Archive's bytes are stored as the Archive sent them, and the blank
    // pixel is applied on the way out: what is on disk stays a faithful record
    // of what upstream answered, so the rule can be changed later without the
    // cache having quietly lost the evidence for it.
    await fsp.writeFile(bodyPath(key), asset.body);
    await fsp.writeFile(typePath(key), asset.mime);
    return served;
  });
  inflight.set(key, job);
  return job;
}

// One reference written inside a capture, turned into this app's own asset
// address when that is possible, or null when the reference is not an asset
// this cache could serve (a data: URI, a javascript: URL, an anchor).
//
// This is the function the compare view's panes use, and it is the same rule
// the film follows (see toProxy above): the timestamp and modifier the Archive
// already wrote into the reference are honored - so the picture is the version
// that capture saw - and a reference that carries neither is wrapped in the
// capture's own timestamp, which is what makes a live absolute URL inside an
// archived page resolve to the archived copy rather than to the live site.
function proxyForRaw(raw, fallback = {}) {
  const src = String(raw == null ? '' : raw).trim();
  if (!src || /^(data|blob|about|javascript|mailto|tel|#)/i.test(src)) return null;
  const origin = fallback.origin || '';
  const written = ARCHIVE_PREFIX.exec(src);
  const abs = (() => {
    try { return new URL(src, fallback.base || undefined).toString(); } catch (_) { return null; }
  })();
  const m = written || (abs ? ARCHIVE_PREFIX.exec(abs) : null);
  if (m) return proxyPath(m[2] || fallback.mod || 'im_', m[1], m[3], origin);
  if (!abs || !/^https?:/i.test(abs)) return null;
  if (!fallback.ts) return null;
  const mod = fallback.mod || (isSheet('', abs) ? 'cs_' : 'im_');
  return proxyPath(mod, fallback.ts, abs, origin);
}

module.exports = {
  getAsset, proxyPath, proxyForRaw, keyFor, cacheKey, isSheet, DIR, ASSET_VERSION, asPicture, BLANK_PIXEL,
  // The two fetch steps, exported so the retry policy can be exercised without
  // the Archive (see test/assetRetry.test.js): what counts as worth another
  // ask, and what is final.
  fetchArchiveOnce, fetchArchive,
};
