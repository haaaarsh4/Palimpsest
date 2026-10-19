// lib/imageBytes.js
//
// Why this file exists: two captures can name the same picture file while
// holding different pictures. A logo redesigned under the same filename,
// a badge re-exported with new pixels but the same address, reads to the
// attribute diff as "nothing changed" because src, alt, width and height
// are all identical. The only thing that tells them apart is the file's
// own bytes, so this compares those bytes and promotes the silent pairs
// the sequence diff left unmarked.
//
// How it is used: server.js runs this after diffSnapshots() on the two
// annotated documents, before responding. Only images the diff considered
// identical are candidates; anything whose address or description already
// moved is already a change and needs no fetch. Each candidate pair is
// fetched through the same asset cache the film uses (lib/assetCache.js),
// hashed, and compared. A pair whose bytes differ becomes a changed entry
// with imageBytesChanged set, marked red where it was and green where it
// is, exactly like any other edit.

const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const { getAsset } = require('./assetCache');
const { resolveTarget, targetKey } = require('./urlTarget');
const { naturalSize, declaredNumber } = require('./imageSize');

function isInline(v) {
  return /^data:/i.test(String(v == null ? '' : v).trim());
}

// The file an <img> really shows. A lazy-loaded picture keeps a tiny inline
// placeholder in src while the real file sits in data-src; comparing src
// bytes there compares two placeholders and always agrees.
function realFileOf(img) {
  const src = img.getAttribute('src') || '';
  const dataSrc = img.getAttribute('data-src') || '';
  if (isInline(src) && dataSrc) return dataSrc;
  return src;
}

// The (timestamp, original URL) pair behind one image address: the archive
// prefix's timestamp when the markup carries one, otherwise the capture's
// own timestamp, which is what a relative address resolved against the
// capture's base means.
function assetTarget(raw, baseHref, fallbackTs) {
  if (!raw || isInline(raw)) return null;
  const t = resolveTarget(raw, baseHref);
  if (!t || !t.resolved) return null;
  let parsed = null;
  try { parsed = new URL(t.target); } catch (_) { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const ts = t.archiveTimestamp || fallbackTs;
  if (!/^\d{14}$/.test(String(ts || ''))) return null;
  return { ts: String(ts), url: t.target };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The file's bytes, via the asset cache, or via the injected fetcher under
// test (which returns a Buffer or null for the same triple). A failed fetch
// is null, never an error: the Archive having a bad minute is not evidence.
async function fetchImageBytes(raw, baseHref, fallbackTs, fetchForTest) {
  if (typeof fetchForTest === 'function') {
    try {
      const buf = await fetchForTest(raw, baseHref, fallbackTs);
      return buf && buf.length ? buf : null;
    } catch (_) {
      return null;
    }
  }
  const target = assetTarget(raw, baseHref, fallbackTs);
  if (!target) return null;
  const asset = await getAsset('im_', target.ts, target.url);
  if (!asset || !asset.body || !asset.body.length) return null;
  return asset.body;
}

async function hashImage(raw, baseHref, fallbackTs) {
  const buf = await fetchImageBytes(raw, baseHref, fallbackTs);
  return buf ? sha256(buf) : null;
}

// The key that decides which old and new pictures are "the same element".
// Deliberately the same ingredients the sequence diff matched on (address
// as destination, description, declared size), so a pair this groups is a
// pair the diff called identical and left unmarked.
function pairKey(img, baseHref) {
  const src = img.getAttribute('src') || '';
  const dataSrc = img.getAttribute('data-src') || '';
  const alt = img.getAttribute('alt') || '';
  const title = img.getAttribute('title') || '';
  const width = img.getAttribute('width') || '';
  const height = img.getAttribute('height') || '';
  return [
    targetKey(src, baseHref),
    targetKey(dataSrc, baseHref),
    alt, title, width, height,
  ].join('::');
}

function baseOf(doc) {
  const base = doc.querySelector ? doc.querySelector('base[href]') : null;
  return base ? base.getAttribute('href') : null;
}

function captureAttrsOf(img) {
  const out = {};
  ['src', 'alt', 'title', 'data-src', 'width', 'height', 'srcset'].forEach((k) => {
    const v = img.getAttribute(k);
    if (v !== null && v !== '') out[k] = v;
  });
  return out;
}

// At most this many silent pairs are byte-compared per diff. A page can
// carry dozens of identical chrome icons; each uncached fetch costs the
// Archive seconds, and one changed logo must not wait behind forty
// unchanged spacers. The cap keeps the interactive diff bounded; the rest
// stay unmarked rather than slow.
const MAX_PAIRS = 25;

// ...and the bytes pass does not get to hold the comparison hostage.
//
// This is the pass that made opening a comparison feel broken: a picture pair
// is two requests to the Archive, the Archive answers a cold request in
// seconds, and the whole diff waited for every pair before the panes were
// given anything at all. Measured on nytimes.com: 12.3s of a 15s response.
//
// So the pass has a wall-clock budget instead of a promise it must see through.
// A pair whose bytes are already in the asset cache (the second look at a
// comparison, and every visit after the first) resolves immediately and is
// always compared; a pair that would need the Archive is compared only if it
// answers in time. Skipping is safe in one direction only, and that is the
// right direction: a skipped pair stays unmarked, exactly as it was before
// this file existed - no change is ever invented, some silent ones are simply
// reported later, on the comparison after the bytes have landed. The fetches
// themselves are not cancelled: they fill the asset cache, so a picture that
// was skipped is answered by the very next diff.
const INTERACTIVE_BUDGET_MS = 2500;

// resolve(null) when the budget runs out before the promise settles.
function within(promise, expiresAt) {
  const left = expiresAt - Date.now();
  if (left <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), left);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

async function promoteSilentImageChanges(result, { tsFrom, tsTo, budgetMs = INTERACTIVE_BUDGET_MS } = {}, hashForTest) {
  const hashOne = typeof hashForTest === 'function'
    ? (raw, base, ts) => hashForTest(raw, base, ts)
    : (raw, base, ts) => hashImage(raw, base, ts);
  if (!result || !result.oldHtml || !result.newHtml) return result;
  let oldDoc;
  let newDoc;
  try {
    oldDoc = new JSDOM(result.oldHtml).window.document;
    newDoc = new JSDOM(result.newHtml).window.document;
  } catch (_) {
    return result;
  }
  const oldBase = baseOf(oldDoc);
  const newBase = baseOf(newDoc);

  const collect = (doc, base) => {
    const out = new Map();
    doc.querySelectorAll('img').forEach((img) => {
      // Anything the diff already marked is already a change.
      if (img.hasAttribute('data-pdiff-removed') || img.hasAttribute('data-pdiff-added') || img.hasAttribute('data-pdiff-changed')) return;
      if (!img.hasAttribute('data-pdiff-id')) return;
      const key = pairKey(img, base);
      const list = out.get(key) || [];
      list.push(img);
      out.set(key, list);
    });
    return out;
  };

  const oldByKey = collect(oldDoc, oldBase);
  const newByKey = collect(newDoc, newBase);

  // Pairs, in document order within each signature group: the k-th old copy
  // of an address against the k-th new copy of it. The key normalizes each
  // side's addresses against its own base, so equal keys name the same file
  // however the archive spelled it per capture.
  const pairs = [];
  oldByKey.forEach((oldList, key) => {
    const newList = newByKey.get(key);
    if (!newList) return;
    const n = Math.min(oldList.length, newList.length);
    for (let i = 0; i < n && pairs.length < MAX_PAIRS; i++) {
      pairs.push([oldList[i], newList[i]]);
    }
  });
  if (!pairs.length) return result;
  const expiresAt = Date.now() + budgetMs;

  const jobs = pairs.map(async ([oldImg, newImg]) => {
    const rawOld = realFileOf(oldImg);
    const rawNew = realFileOf(newImg);
    if (!rawOld || !rawNew) return null;
    const [hOld, hNew] = await Promise.all([
      hashOne(rawOld, oldBase, tsFrom),
      hashOne(rawNew, newBase, tsTo),
    ]);
    // A fetch that failed is not evidence: the Archive having a bad minute
    // must not become a change entry.
    if (!hOld || !hNew || hOld === hNew) return null;
    return { oldImg, newImg };
  });

  const settled = await Promise.all(jobs.map((p) => within(p.catch(() => null), expiresAt)));
  const promoted = settled.filter(Boolean);
  if (!promoted.length) return result;

  const changes = result.changes || [];
  promoted.forEach(({ oldImg, newImg }) => {
    oldImg.setAttribute('data-pdiff-removed', 'true');
    newImg.setAttribute('data-pdiff-changed', 'true');
    const oldId = oldImg.getAttribute('data-pdiff-id');
    const newId = newImg.getAttribute('data-pdiff-id');
    const attrsBefore = captureAttrsOf(oldImg);
    const attrsAfter = captureAttrsOf(newImg);
    changes.push({
      type: 'changed',
      tag: 'img',
      before: '',
      after: '',
      beforeTruncated: false,
      afterTruncated: false,
      textChanged: false,
      attrChanges: [],
      urlChanges: [],
      imageBytesChanged: true,
      attrsBefore,
      attrsAfter,
      newId,
      oldId,
      path: '',
      index: changes.length,
    });
  });
  changes.forEach((c, idx) => { c.index = idx; });
  result.changes = changes;
  result.counts = {
    added: changes.filter((c) => c.type === 'added').length,
    removed: changes.filter((c) => c.type === 'removed').length,
    changed: changes.filter((c) => c.type === 'changed').length,
  };
  result.oldHtml = '<!DOCTYPE html>' + oldDoc.documentElement.outerHTML;
  result.newHtml = '<!DOCTYPE html>' + newDoc.documentElement.outerHTML;
  return result;
}

// The reverse of the promotion above, in two halves:
//
// 1. ANNOTATE: every changed <img> whose record involves width/height gets
//    its measured sizes attached (sizeBefore/sizeAfter, each side declared
//    or the file's natural size where undeclared, each measured from its
//    OWN file's bytes). Without this the panel reads "width (none) → 50"
//    and hides what the picture actually rendered at before.
// 2. DEMOTE: the subset whose ONLY differences are width/height, same file
//    and description both sides, equal bytes, equal effective sizes, is a
//    proven no-op and is removed, marks and all. Anything else stays
//    flagged: only a proven no-op is demoted, never a suspected one.
const SIZE_ONLY_ATTRS = new Set(['width', 'height']);

function sameFile(a, b, baseA, baseB) {
  const sa = a || '';
  const sb = b || '';
  if (!sa && !sb) return true;
  if (!sa || !sb) return false;
  return targetKey(sa, baseA) === targetKey(sb, baseB);
}

async function demoteNoopImageResizes(result, { tsFrom, tsTo, budgetMs = INTERACTIVE_BUDGET_MS } = {}, fetchForTest) {
  if (!result || !result.oldHtml || !result.newHtml || !Array.isArray(result.changes)) return result;
  const involvesSize = (c) =>
    c && c.type === 'changed' && (c.tag === 'img') && !c.imageBytesChanged &&
    Array.isArray(c.attrChanges) && c.attrChanges.some((a) => SIZE_ONLY_ATTRS.has(a.name));
  const candidates = result.changes.filter(involvesSize);
  if (!candidates.length) return result;

  let oldDoc;
  let newDoc;
  try {
    oldDoc = new JSDOM(result.oldHtml).window.document;
    newDoc = new JSDOM(result.newHtml).window.document;
  } catch (_) {
    return result;
  }
  const oldBase = baseOf(oldDoc);
  const newBase = baseOf(newDoc);

  const byId = (doc, id) => {
    try { return id ? doc.querySelector(`[data-pdiff-id="${id}"]`) : null; } catch (_) { return null; }
  };

  // An effective size from a declared attribute, or the file's own natural
  // size where undeclared. Null unless both dimensions are known: a half
  // size names nothing.
  const effective = (attrs, natural) => {
    const w = declaredNumber(attrs.width) ?? (natural ? natural.width : null);
    const h = declaredNumber(attrs.height) ?? (natural ? natural.height : null);
    return (w != null && h != null) ? { w, h } : null;
  };

  let demoted = 0;
  let annotated = 0;
  const capped = candidates.slice(0, MAX_PAIRS);
  // Same budget as the pass above, and the same reason: an undeclared size is
  // answered by the file's own bytes, which is an Archive request, and the
  // comparison does not wait for the Archive to be in the mood. Candidates
  // past the budget keep whatever the attribute diff already said about them.
  const expiresAt = Date.now() + budgetMs;
  for (const c of capped) {
    if (Date.now() > expiresAt) break;
    try {
      const before = c.attrsBefore || {};
      const after = c.attrsAfter || {};
      const oldNode = byId(oldDoc, c.oldId);
      const newNode = byId(newDoc, c.newId);
      if (!oldNode || !newNode) continue;
      const [bufOld, bufNew] = await Promise.all([
        within(fetchImageBytes(realFileOf(oldNode), oldBase, tsFrom, fetchForTest), expiresAt),
        within(fetchImageBytes(realFileOf(newNode), newBase, tsTo, fetchForTest), expiresAt),
      ]);
      // Each side measured from its OWN file: a swapped picture has two
      // natural sizes, and the before number comes from the before file.
      const natOld = bufOld ? naturalSize(bufOld, realFileOf(oldNode)) : null;
      const natNew = bufNew ? naturalSize(bufNew, realFileOf(newNode)) : null;
      const effOld = effective(before, natOld);
      const effNew = effective(after, natNew);
      if (effOld && !c.sizeBefore) { c.sizeBefore = effOld; annotated++; }
      if (effNew && !c.sizeAfter) { c.sizeAfter = effNew; annotated++; }
      if (natNew && !c.naturalSize) c.naturalSize = { ...natNew };
      // Demotion needs the whole no-op proof: size-only record, same file
      // and description, equal bytes, equal effective renders.
      const sizeOnly = (c.attrChanges || []).length > 0 &&
        (c.attrChanges || []).every((a) => SIZE_ONLY_ATTRS.has(a.name));
      if (!sizeOnly) continue;
      if (!sameFile(before.src, after.src, oldBase, newBase)) continue;
      if (!sameFile(before['data-src'], after['data-src'], oldBase, newBase)) continue;
      if ((before.alt || '') !== (after.alt || '')) continue;
      if ((before.title || '') !== (after.title || '')) continue;
      if (!bufOld || !bufNew) continue;
      if (!bufOld.equals(bufNew)) continue;
      if (!effOld || !effNew) continue;
      if (effOld.w !== effNew.w || effOld.h !== effNew.h) continue;
      oldNode.removeAttribute('data-pdiff-removed');
      newNode.removeAttribute('data-pdiff-changed');
      const at = result.changes.indexOf(c);
      if (at >= 0) result.changes.splice(at, 1);
      demoted++;
    } catch (_) {
      // One unjudgeable pair must never block the rest.
    }
  }
  if (!demoted && !annotated) return result;
  result.changes.forEach((c, idx) => { c.index = idx; });
  result.counts = {
    added: result.changes.filter((c) => c.type === 'added').length,
    removed: result.changes.filter((c) => c.type === 'removed').length,
    changed: result.changes.filter((c) => c.type === 'changed').length,
  };
  result.oldHtml = '<!DOCTYPE html>' + oldDoc.documentElement.outerHTML;
  result.newHtml = '<!DOCTYPE html>' + newDoc.documentElement.outerHTML;
  return result;
}

module.exports = { promoteSilentImageChanges, demoteNoopImageResizes, assetTarget, hashImage };
