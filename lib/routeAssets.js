// lib/routeAssets.js
//
// A prepared capture still names its pictures and stylesheets with the
// Archive's own addresses. That is the wrong address for a pane to load them
// from, and it is the single biggest reason the comparison felt broken:
//
//   - every stylesheet was a fresh request to web.archive.org, two to twelve
//     seconds each, several of them refused or timed out, so a page arrived
//     half styled or not styled at all ("there is no CSS in here");
//   - every picture was the same, so a picture-heavy front page took a minute
//     to fill in;
//   - none of it was ever cached, because a capture's markup names its assets
//     with that capture's own timestamp, so the browser's HTTP cache never saw
//     the same URL twice;
//   - and a stylesheet served from another origin cannot be read by the page
//     that includes it, so the reveal engine had to fetch every sheet a second
//     time through /api/css just to learn which rule was hiding something.
//
// /api/asset already solves all four for the film: it fetches each asset once,
// keeps it in data/assets/, serves it from disk at localhost speed with an
// immutable cache header, and rewrites the url() references inside stylesheets
// so their fonts and background images come from there too. This file points
// the compare view's panes at that same cache.
//
// What it rewrites, and what it deliberately leaves alone:
//
//   rewritten   img/source/video/audio (src, srcset, poster), link[href]
//               (stylesheet, icon, preload, prefetch), the url()s inside style
//               attributes, and <style> blocks
//   untouched   every <a href> and <form action>, because following a link is
//               the app's own navigation (it needs the Archive's address, not
//               an asset), and the <base href>, which those links resolve
//               against.
//
// A srcset is rewritten entry by entry, keeping its descriptor ("2x", "640w"):
// dropping them would silently change which picture a browser picks.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { JSDOM } = require('jsdom');
const { proxyForRaw, getAsset, ASSET_VERSION } = require('./assetCache');

// Which revision of this pass produced a document. It rides in the cache key,
// so a correction here reaches every pane without waiting for anything else to
// be re-prepared.
// 2: inline style="...url(...)" references are routed at all. Revision 1
// asked for them with an attribute selector that silently matched nothing, so
// every pane kept its background images on the Archive's address, where the
// document's <base> sent them somewhere that does not exist.
// 3: a routed document carries the diff engine's injected stylesheet inside
// it, and that stylesheet no longer draws the SELECTED badge. The word is the
// comparison's own chrome now, in a layer over the pane's frame (so nothing
// in the page can clip it or paint a menu over it), and a cached document
// still carrying the old badge rules would keep drawing a second word inside
// the snapshot: exactly the element the badges were moved out of.
// 4: a srcset is parsed by the HTML spec (a data: URI is one candidate, not
// two) and a lazy-loading placeholder is never treated as the picture. Apple's
// 2026 tiles ship `<source srcset="data:image/gif;base64,R0lGOD...">` in front
// of the real `<img src>`; the old split ran the base64 payload through the
// asset proxy, the placeholder won the <picture>, and 51 of 53 pictures on the
// page were a one-pixel GIF that painted nothing. Revision 5 carries the fix
// for a real inline picture (a data: URI with thousands of bytes behind it)
// being mistaken for a placeholder and thrown away.
const ROUTE_VERSION = 5;

// srcset entries: "<url> [descriptor], <url> [descriptor], ...".
//
// Parsed the way the HTML spec says, because the naive `split(',')` is wrong
// for the one shape that matters: a data: URI carries a comma of its own. A
// lazy-loading placeholder - `<source srcset="data:image/gif;base64,R0lGOD...">`
// - used to be split into "data:image/gif;base64" and a base64 blob, and the
// blob was then resolved against the page and sent to the asset proxy. The
// result was a <source> that always matched and always painted one transparent
// pixel, which is why a whole Apple front page came up with empty tiles.
function splitSrcset(value) {
  const s = String(value || '');
  const out = [];
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === ',')) i += 1;
    if (i >= s.length) break;
    const start = i;
    if (s.slice(i, i + 5).toLowerCase() === 'data:') {
      // A data: URI ends at the next whitespace; its commas are its own.
      while (i < s.length && !isSpace(s[i])) i += 1;
    } else {
      while (i < s.length && !isSpace(s[i]) && s[i] !== ',') i += 1;
    }
    const url = s.slice(start, i);
    while (i < s.length && isSpace(s[i])) i += 1;
    const descStart = i;
    while (i < s.length && s[i] !== ',') i += 1;
    const descriptor = s.slice(descStart, i).trim();
    if (url) out.push({ url, descriptor });
  }
  return out;
}

// A picture-sized lie: the transparent GIF (or empty SVG) a site puts in src
// until its own script swaps in the real image. Archived scripts never run, so
// if the placeholder is what reaches the pane, the picture is gone. These are
// recognised by shape - a data: URI far too small to be a photo - and never by
// a site's name.
function isPlaceholderImage(raw) {
  const v = String(raw || '').trim();
  if (!v) return true;
  if (!/^data:/i.test(v)) return false;
  const comma = v.indexOf(',');
  const head = comma === -1 ? v : v.slice(0, comma);
  const body = comma === -1 ? '' : v.slice(comma + 1);
  const mime = head.replace(/^data:/i, '');
  // A base64 one-pixel gif/png is under 160 characters; a real inline picture
  // is orders of magnitude larger. The canonical blank GIF is matched exactly
  // as well, because some sites pad it with whitespace.
  if (/^image\/svg\+xml/i.test(mime)) return body.replace(/\s+/g, '').length < 600;
  if (!/^image\//i.test(mime)) return true;
  if (/^R0lGODlhAQAB/i.test(body.trim())) return true;
  return body.replace(/\s+/g, '').length <= 160;
}

// The lazy-loading attributes sites use to name the picture the placeholder is
// standing in for. Only consulted when the element's own src is a placeholder.
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-echo', 'data-img', 'data-url'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];

function routeSrcset(value, fallback) {
  return splitSrcset(value)
    .map(({ url, descriptor }) => {
      // The placeholder is dropped, never proxied: it is not a picture, and a
      // candidate that always matches is worse than no candidate at all.
      if (isPlaceholderImage(url)) return '';
      const routed = proxyForRaw(url, fallback);
      const out = routed || url;
      return descriptor ? out + ' ' + descriptor : out;
    })
    .filter(Boolean)
    .join(', ');
}

const STYLE_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function routeCssText(text, fallback) {
  return String(text || '').replace(STYLE_URL, (m, quote, raw) => {
    const routed = proxyForRaw(raw, fallback);
    return routed ? `url(${quote}${routed}${quote})` : m;
  });
}

const ATTRS = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  embed: ['src'],
  input: ['src'],
  track: ['src'],
};

// Every asset reference in one document, pointed at this app's cache. The
// document is modified in place; the caller serializes it.
function routeDocument(doc, { url, timestamp, origin } = {}) {
  if (!doc || !doc.querySelectorAll || !timestamp) return 0;
  // The capture's own address, used only to resolve a relative reference that
  // somehow survived the Archive's rewriting. Absolute references - which is
  // nearly all of them - carry their own timestamp and ignore this.
  //
  // `origin` is what makes the addresses this writes survive the document's
  // own <base href="https://web.archive.org/...">: a root-relative
  // /api/asset address is re-based onto the Archive and never reaches this
  // app, which is exactly how the panes ended up with no CSS at all.
  const base = {
    ts: timestamp,
    mod: 'im_',
    origin,
    base: `https://web.archive.org/web/${timestamp}/${url || ''}`,
  };
  let routed = 0;

  // A <picture> whose <source> is a lazy-loading placeholder: the source wins
  // over the <img> fallback for every viewport it matches, so keeping it means
  // keeping an empty box. The real picture is the <img> behind it (or its own
  // data-src), which is what the pane should paint.
  doc.querySelectorAll('picture > source').forEach((node) => {
    const candidates = splitSrcset(node.getAttribute('srcset'))
      .map((c) => c.url)
      .filter((u) => u && !isPlaceholderImage(u));
    const single = node.getAttribute('src');
    const hasRealSrc = single && !isPlaceholderImage(single);
    const empty = node.hasAttribute('data-empty');
    if (!candidates.length && !hasRealSrc && (empty || isPlaceholderImage(single || ''))) {
      try { node.parentNode.removeChild(node); } catch (_) { /* keep it: an unchanged pane is not a broken one */ }
    }
  });

  // The same placeholder on the <img> itself, with the real address parked in
  // a data- attribute for the script that never runs: promote it, then route
  // it like any other picture.
  doc.querySelectorAll('img').forEach((node) => {
    const src = node.getAttribute('src') || '';
    if (!isPlaceholderImage(src)) return;
    for (const attr of LAZY_SRC) {
      const value = node.getAttribute(attr);
      if (value && !isPlaceholderImage(value)) { node.setAttribute('src', value); return; }
    }
    for (const attr of LAZY_SRCSET) {
      const value = node.getAttribute(attr);
      if (value && splitSrcset(value).some((c) => !isPlaceholderImage(c.url))) {
        node.setAttribute('srcset', value);
        return;
      }
    }
  });

  Object.keys(ATTRS).forEach((tag) => {
    doc.querySelectorAll(tag).forEach((node) => {
      ATTRS[tag].forEach((attr) => {
        const value = node.getAttribute(attr);
        if (!value) return;
        if (attr === 'srcset') {
          const next = routeSrcset(value, base);
          if (!next) {
            // Every candidate was a placeholder: taking the attribute off is
            // what lets the element's src (or its own data-src) be used.
            node.removeAttribute(attr);
            routed += 1;
            return;
          }
          if (next !== value) {
            node.setAttribute(attr, next);
            routed += 1;
          }
          return;
        }
        const next = proxyForRaw(value, base);
        if (next) {
          node.setAttribute(attr, next);
          routed += 1;
        }
      });
    });
  });

  // Stylesheets and the other linked resources. rel is matched loosely: the
  // Archive writes "stylesheet", "preload", "shortcut icon", "apple-touch-icon
  // precomposed" and every other spelling a site ever used.
  doc.querySelectorAll('link[href]').forEach((node) => {
    const rel = String(node.getAttribute('rel') || '').toLowerCase();
    if (!/(stylesheet|icon|preload|prefetch|apple-touch)/.test(rel)) return;
    const href = node.getAttribute('href');
    // A stylesheet has to be asked for as one, or the Archive hands back the
    // page it was linked from; the cache keys and rewrites the two kinds
    // differently for the same reason.
    const fallback = { ...base, mod: /stylesheet/.test(rel) ? 'cs_' : 'im_' };
    const next = proxyForRaw(href, fallback);
    if (next) {
      node.setAttribute('href', next);
      routed += 1;
    }
  });

  // background-image, list-style-image and friends, written inline.
  //
  // Every element with a style attribute is listed and the url() test is done
  // in JavaScript rather than with the obvious `[style*="url("]` selector:
  // that selector matched nothing, silently, so every inline background in
  // every pane kept its Archive address and resolved against the document's
  // <base> - the same failure the absolute addresses below exist to prevent.
  doc.querySelectorAll('[style]').forEach((node) => {
    const style = node.getAttribute('style');
    if (!style || !/url\(/i.test(style)) return;
    const next = routeCssText(style, base);
    if (next !== style) {
      node.setAttribute('style', next);
      routed += 1;
    }
  });

  // A page's own <style> blocks name fonts and backgrounds the same way.
  doc.querySelectorAll('style').forEach((node) => {
    const text = node.textContent;
    const next = routeCssText(text, base);
    if (next !== text) {
      node.textContent = next;
      routed += 1;
    }
  });

  return routed;
}

// The same pass over a prepared document held as a string, which is how the
// panes receive theirs. Returns the string unchanged rather than throwing when
// the markup cannot be parsed: a pane that renders with Archive addresses is
// slow, and a pane that does not render at all is broken.
function routeHtml(rawHtml, opts = {}) {
  try {
    const dom = new JSDOM(String(rawHtml || ''));
    const count = routeDocument(dom.window.document, opts);
    if (!count) return rawHtml;
    return '<!DOCTYPE html>' + dom.window.document.documentElement.outerHTML;
  } catch (_) {
    return rawHtml;
  }
}

// ---- Caching the routed document ------------------------------------------
//
// Routing parses and re-serializes the whole pane document, which is 200-400ms
// on a page the size of nytimes.com's front page, and the same document is
// routed again every time a reader opens the same comparison. So the result is
// kept: in memory for the pages this process is looking at, and on disk for the
// next run. The key carries both revisions, so a change to either pass reaches
// every document without anything having to be invalidated by hand.
const ROUTED_DIR = path.join(__dirname, '..', 'data', 'routed');
const MEMORY_LIMIT = 8;
const memory = new Map();

function keyForRoute(rawHtml, opts) {
  return crypto.createHash('sha1')
    .update(`v${ROUTE_VERSION}.a${ASSET_VERSION}.${opts.origin || ''}.${opts.url}@${opts.timestamp}.`)
    .update(String(rawHtml || ''))
    .digest('hex');
}

function fileForRoute(key) {
  return path.join(ROUTED_DIR, key + '.html');
}

function remember(key, html) {
  try {
    memory.delete(key);
    memory.set(key, html);
    while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  } catch (_) { /* the disk copy below still stands */ }
}

// The pane's document, with every asset pointed at this app's cache.
//
// Never throws and never returns nothing: a document that cannot be routed is
// returned exactly as it arrived, because a pane that loads slowly is a pane,
// and a pane that does not load is a bug report.
async function routedDocument(rawHtml, opts = {}) {
  if (!rawHtml || !opts.timestamp) return rawHtml;
  const key = keyForRoute(rawHtml, opts);
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const disk = await fsp.readFile(fileForRoute(key), 'utf8');
    if (disk) {
      remember(key, disk);
      return disk;
    }
  } catch (_) { /* not routed before, or the file was swept */ }

  const routed = routeHtml(rawHtml, opts);
  remember(key, routed);
  fsp.mkdir(ROUTED_DIR, { recursive: true })
    .then(() => fsp.writeFile(fileForRoute(key), routed))
    .catch(() => { /* a cache that cannot be written is still a working pane */ });
  return routed;
}

// ---- Warming what the pane is about to ask for -----------------------------
//
// The browser learns about a pane's stylesheets only after it has the document
// and parsed it, which is one round trip behind. Warming them here means the
// sheets are usually already in data/assets/ - or at least already in flight,
// where the cache joins the request rather than starting a second one - by the
// time the browser asks. Stylesheets only: they are what decides whether the
// pane looks like the site at all, they are few, and they are small. Pictures
// are left to the browser, which fetches them in parallel and paints as they
// land.
// How many sheets are asked for at once. The browser's own rack is wider than
// this, and the asset cache caps what actually reaches the Archive regardless
// (lib/assetCache.js WIDTH), so this only decides how much of the list is in
// flight rather than queued behind the warm loop itself.
const WARM_WIDTH = 10;
const warmed = new Set();

// The sheets a capture names, read out of the raw markup instead of a parsed
// document. Warming is started the instant the capture's HTML is in hand, and
// a full parse to find a dozen <link> tags would put 300ms of nothing between
// the fetch finishing and the first sheet being asked for. The addresses come
// out of proxyForRaw - the same call routeDocument makes - so what is warmed
// is exactly what the pane will later ask for.
const LINK_TAG = /<link\b[^>]*>/gi;
const LINK_REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const LINK_HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function warmStylesheetsFromRaw(rawHtml, { url, timestamp } = {}) {
  if (!rawHtml || !timestamp) return;
  const base = { ts: timestamp, mod: 'cs_', base: `https://web.archive.org/web/${timestamp}/${url || ''}` };
  const tags = String(rawHtml).match(LINK_TAG) || [];
  const jobs = [];
  for (const tag of tags) {
    const rel = LINK_REL.exec(tag);
    if (!rel || !/stylesheet/i.test(rel[1] || rel[2] || rel[3] || '')) continue;
    const href = LINK_HREF.exec(tag);
    const raw = href ? (href[1] || href[2] || href[3] || '') : '';
    if (!raw) continue;
    const routed = proxyForRaw(raw, base);
    const m = routed ? /^\/api\/asset\?m=([^&]*)&t=(\d{14})&u=([^&]*)/.exec(routed.replace(/^https?:\/\/[^/]+/, '')) : null;
    if (!m) continue;
    const key = `${m[2]}|${m[3]}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    jobs.push({ mod: decodeURIComponent(m[1]), ts: m[2], url: decodeURIComponent(m[3]) });
  }
  if (warmed.size > 4000) warmed.clear();
  runWarmJobs(jobs);
}

// And the pictures, for the reason the stylesheets are warmed: a front page
// names sixty of them, the browser asks for them the moment it parses the
// pane, and every cold one is two to three seconds of the Archive being asked
// for a file it has to wake up. Asking for them while the diff is running
// means the browser's own requests find them on disk - the same traffic,
// started earlier, and overlapped with the work the pane is already waiting
// for.
//
// Bounded on purpose: the first IMAGE_WARM_MAX pictures in document order per
// capture, no srcset variants, no CSS backgrounds (those come with the sheet
// that names them). A page with hundreds of pictures is a film's problem, not
// a comparison's, and everything past the cap is fetched by the browser the
// ordinary way.
const IMAGE_WARM_MAX = 120;
const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function warmImagesFromRaw(rawHtml, { url, timestamp } = {}) {
  if (!rawHtml || !timestamp) return;
  const text = String(rawHtml);
  const jobs = [];
  const seen = new Set();
  const tags = text.match(IMG_TAG) || [];
  for (const tag of tags) {
    if (jobs.length >= IMAGE_WARM_MAX) break;
    const m = IMG_SRC.exec(tag);
    const raw = m ? (m[1] || m[2] || m[3] || '') : '';
    if (!raw || /^data:/i.test(raw)) continue;
    const routed = proxyForRaw(raw, { ts: timestamp, mod: 'im_', base: `https://web.archive.org/web/${timestamp}/${url || ''}` });
    const parsed = routed ? /^(?:https?:\/\/[^/]+)?\/api\/asset\?m=([^&]*)&t=(\d{14})&u=([^&]*)/.exec(routed) : null;
    if (!parsed) continue;
    const key = `${parsed[2]}|${parsed[3]}`;
    if (seen.has(key) || warmed.has(key)) continue;
    seen.add(key);
    jobs.push({ mod: decodeURIComponent(parsed[1]), ts: parsed[2], url: decodeURIComponent(parsed[3]) });
  }
  if (!jobs.length) return;
  runWarmJobs(jobs, IMAGE_WARM_WIDTH);
}

// Pictures get a narrower rack than sheets: the sheets are what make the pane
// look like the site at all, so a slow Archive should finish them first.
const IMAGE_WARM_WIDTH = 4;

// One rack, so the two ways of finding sheets (raw markup, routed document)
// share its width instead of each opening their own.
function runWarmJobs(jobs, width = WARM_WIDTH) {
  let running = 0;
  const next = () => {
    const job = jobs.shift();
    if (!job) return;
    running += 1;
    getAsset(job.mod, job.ts, job.url)
      .catch(() => null)
      .then(() => {
        running -= 1;
        if (jobs.length && running < width) next();
      });
  };
  while (running < width && jobs.length) next();
}

function warmStylesheets(rawHtml, opts = {}) {
  try {
    const dom = new JSDOM(String(rawHtml || ''));
    const doc = dom.window.document;
    const jobs = [];
    doc.querySelectorAll('link[href]').forEach((node) => {
      const rel = String(node.getAttribute('rel') || '').toLowerCase();
      if (!/stylesheet/.test(rel)) return;
      const href = String(node.getAttribute('href') || '');
      // Either shape: the panes' own routed documents carry an absolute
      // address to this app (see proxyPath), the film's markup carries a
      // root-relative one.
      const m = /^(?:https?:\/\/[^/]+)?\/api\/asset\?m=([^&]*)&t=(\d{14})&u=([^&]*)/.exec(href);
      if (!m) return;
      const key = `${m[2]}|${m[3]}`;
      if (warmed.has(key)) return;
      warmed.add(key);
      jobs.push({ mod: decodeURIComponent(m[1]), ts: m[2], url: decodeURIComponent(m[3]) });
    });
    if (warmed.size > 4000) warmed.clear();
    runWarmJobs(jobs);
  } catch (_) { /* warming is an optimization, never a requirement */ }
}

// ---- Preparing the whole page before the pane is given it ------------------
//
// Warming one kind of asset at a time was still a race: the pane arrived, its
// reader watched pictures fill in one by one, and a tile whose picture the
// Archive answered slowly was a white box for seconds. So every asset a routed
// document names is collected here - pictures (including every srcset
// candidate we kept), stylesheets, fonts and backgrounds inside the sheets
// themselves, inline styles - and fetched into data/assets/ before the
// document is handed over.
//
// Bounded twice: by a deadline (a comparison never waits forever for a picture
// the Archive may not have) and by a rack width, because asking for two
// hundred assets at once is how the Archive starts answering 429. Anything
// that does not make the deadline is still fetched by the browser, in
// parallel, from the same cache.
// An asset address as it appears in a serialized document: `&` is written
// `&amp;` inside attributes and plain inside <style>, so both are accepted.
const ASSET_REF = /\/api\/asset\?m=([^&"'\s]+)&(?:amp;)?t=(\d{14})&(?:amp;)?u=([^&"'\s)]+)/g;

function collectAssetRefs(html, origin) {
  const text = String(html || '');
  const seen = new Set();
  const out = [];
  let m = null;
  while ((m = ASSET_REF.exec(text)) !== null) {
    let mod = m[1] || '';
    const ts = m[2];
    let url = m[3];
    try { mod = decodeURIComponent(mod); } catch (_) { /* keep it raw */ }
    try { url = decodeURIComponent(url); } catch (_) { /* keep it raw */ }
    const key = `${ts}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mod, ts, url });
  }
  // A CSS file's own url() references are only known after the sheet is in
  // hand, and the cache rewrites them when it serves it, so the sheet ref is
  // enough to have the fonts and backgrounds ready too: getAsset() pulls them
  // through the same cache on the way out.
  return out;
}

async function prepareAssets(html, { deadlineMs = 12000, width = 6 } = {}) {
  const refs = collectAssetRefs(html);
  if (!refs.length) return { asked: 0, done: 0, timedOut: false, missing: [] };
  const started = Date.now();
  let done = 0;
  let timedOut = false;

  // One rack over one list of references; failures are collected rather than
  // dropped, because a picture that failed once is exactly the one that should
  // be asked for again before the pane is shown.
  const sweep = async (list, failures) => {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        if (Date.now() - started > deadlineMs) { timedOut = true; return; }
        if (cursor >= list.length) return;
        const at = cursor;
        cursor += 1;
        const ref = list[at];
        try {
          const asset = await getAsset(ref.mod, ref.ts, ref.url);
          if (asset && asset.body && asset.body.length) done += 1;
          else failures.push(ref);
        } catch (_) {
          // One missing asset is not a failed page, but it is a reference the
          // browser will ask for and not get, so it is remembered.
          failures.push(ref);
        }
      }
    };
    const rack = Math.max(1, Math.min(width, list.length));
    await Promise.all(Array.from({ length: rack }, () => worker()));
    return failures;
  };

  let failures = await sweep(refs, []);
  // A second pass over what failed, still inside the same deadline. Almost
  // every one of these is the Archive being slow with one cold file; asking
  // once more is the difference between a finished pane and a hole in it.
  if (failures.length && Date.now() - started < deadlineMs) {
    const again = failures;
    failures = await sweep(again, []);
  }
  // Bounded: the caller only logs these, and a page can name hundreds.
  return {
    asked: refs.length,
    done,
    timedOut,
    missing: failures.slice(0, 40).map((r) => r.url),
  };
}

module.exports = {
  routeHtml, routeDocument, routeCssText, routedDocument, warmStylesheets, warmStylesheetsFromRaw,
  warmImagesFromRaw, collectAssetRefs, prepareAssets, splitSrcset, isPlaceholderImage,
  ROUTE_VERSION, ASSET_VERSION,
};
