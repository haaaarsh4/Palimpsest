// lib/urlTarget.js
//
// What a link points at, as opposed to how it happens to be written down.
//
// Two captures of the same site get compared here more than anything else does,
// and both of them have been through the Wayback Machine, which rewrites absolute
// URLs in the pages it stores so they point back into its own web path. The same
// link to the site's own front page, captured in 2016 and again in 2026, therefore
// arrives as two entirely different strings:
//
//   /web/20160710035916/http://etablissement.org/
//   /web/20261002005041/https://etablissement.org/
//
// A different timestamp, and http in one and https in the other. Compared as text
//, which is what the diff did, and what made it useless for links, that reads
// as "same site, but it now points to a different page", when it points at the
// same page spelled the way the archive happened to spell it on each date.
//
// This is not an edge case. It is the ordinary case for every link a site wrote
// as an absolute URL, and for every image whose src the archive rewrote, so a
// record can fill up with changed entries whose own before and after text is
// identical. So this module answers one question, where does this really point
//, and folds the answers into a single comparable key.
//
// Three deliberate rules, all of them decisions rather than facts:
//
//   1. The archive prefix comes off, and what is left is resolved into a real
//      absolute URL, using the capture's own <base> to recover the site's origin
//      (the base is the only place that origin is written down).
//   2. The scheme is dropped for http and https. A site moving to https is a fact
//      about the site, not about where its links go, and this app already says so
//      in its own words elsewhere: "only the protocol changed ... same destination
//      either way". Two links that differ only in that are the same link.
//   3. A trailing slash is still a difference, "/fees/" and "/fees" are different
//      addresses, whatever a web server usually does with them, but it is
//      reported as what it is: the same page, spelled with or without the slash.

const ARCHIVE_HOST_RE = /(^|\.)archive\.org$/i;
const WAYBACK_PATH_RE = /^\/web\/(\d{14})([a-z_]*)\/(.*)$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEMES = new Set(['http:', 'https:']);

// The attributes that hold a URL. Their values are compared as destinations
// rather than as text, everywhere in the diff, and any of them that does change
// gets a sentence instead of a raw before/after row.
const URL_ATTR_NAMES = new Set([
  'href', 'src', 'poster', 'background', 'action', 'formaction', 'data', 'longdesc', 'cite',
  // Lazy-loaded pictures keep the real file here while src holds a tiny inline
  // placeholder. Compared as a destination like any other URL attribute, so
  // the archive's own prefix never reads as a change.
  'data-src',
]);

function parse(value, base) {
  try {
    return new URL(value, base || undefined);
  } catch (_) {
    return null;
  }
}

// decodeURIComponent that cannot throw on a malformed escape: a URL recovered
// from an archive path is untrusted text, and one bad "%" must not take a diff
// down with it.
function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

// The real URL an archive path was made out of, or null if this is not one.
function archiveInner(url) {
  if (!url || !ARCHIVE_HOST_RE.test(url.hostname || '')) return null;
  const m = WAYBACK_PATH_RE.exec(url.pathname);
  if (!m) return null;
  // The archive keeps the captured URL verbatim after the timestamp, including
  // its own query and fragment, which the outer parse hands back to us as the
  // outer URL's, so reassembling them here is exact rather than approximate.
  return { timestamp: m[1], inner: decodeSafe(m[3]) + (url.search || '') + (url.hash || '') };
}

// The site's own address, as written inside an archive base. `/web/<ts>/<site>` is
// the only place the real origin appears, which is why every relative href in a
// capture can only be resolved once we have the base.
function archivedSiteBase(baseHref) {
  const outer = parse(baseHref);
  if (!outer) return null;
  const inner = archiveInner(outer);
  return inner ? inner.inner : baseHref;
}

// An archive path's inner text is either a URL in its own right
// ("http://site/fees.html") or the site's own path ("images/logo.png", which the
// archive stored relative to the captured page). The first resolves as it is; the
// second resolves against the site's address.
function resolveInner(inner, base) {
  if (SCHEME_RE.test(inner) || inner.startsWith('//')) {
    const abs = parse(inner);
    return abs ? abs.href : inner;
  }
  const abs = parse(inner, base || undefined);
  return abs ? abs.href : inner;
}

/**
 * Where a written value really points.
 *
 * null for an empty value, otherwise:
 *   href              what the attribute resolves to as written (may be an
 *                     archive URL, which is what a browser would request)
 *   target            the page or file it actually names
 *   archiveTimestamp  the timestamp in the prefix, when there was one
 *   resolved          false when the value is not a URL at all, "{page}",
 *                     "javascript:void(0)", a template someone never filled in
 */
function resolveTarget(value, baseHref) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const outer = parse(raw, baseHref);
  if (!outer) return { href: raw, target: raw, archiveTimestamp: null, resolved: false };
  const inner = archiveInner(outer);
  if (!inner) return { href: outer.href, target: outer.href, archiveTimestamp: null, resolved: true };
  const site = archivedSiteBase(baseHref);
  return {
    href: outer.href,
    target: resolveInner(inner.inner, site || baseHref),
    archiveTimestamp: inner.timestamp,
    resolved: true,
  };
}

// A query string with its empty segments dropped: "?a=1&&" and "?a=1" are the same
// request. Parameters are deliberately not sorted, order can be meaningful to a
// server, and pretending otherwise would hide a real change.
function normalizeQuery(search) {
  if (!search || search === '?') return '';
  const parts = search.slice(1).split('&').filter((p) => p !== '');
  return parts.length ? '?' + parts.join('&') : '';
}

// A leading "www." is not a different site. Sites add it and drop it, half the
// links on the page this module was written for say www.ocasi.org and the other
// half say ocasi.org, and a person following either one arrives in the same
// place. The comparison key drops it; the sentences still show the address as it
// was written, because that is what the page says.
function hostKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

function stripTrailingSlash(path) {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
}

// Paths and queries as a person would recognise them. The URL parser percent-
// encodes everything it dislikes, a path written /about us, or /{page} in a
// template someone never finished, comes back as /about%20us and /%7Bpage%7D  
// and a change list that says "the page moved from /%7Bpage%7D" is technically
// correct and useless. Comparison keys keep the encoded form, because that is the
// form that is unambiguous; the sentences get the readable one.
function showPath(url) { return decodeSafe(url.pathname || '/'); }
function showQuery(search) { return decodeSafe(search || ''); }
function showHash(hash) { return decodeSafe(hash || ''); }

/**
 * The comparison key. Two values with the same key mean the same destination,
 * however differently they were written.
 */
function targetKey(value, baseHref) {
  const t = resolveTarget(value, baseHref);
  if (!t) return '';
  if (!t.resolved) return t.target;
  const u = parse(t.target);
  if (!u) return t.target;
  if (!HTTP_SCHEMES.has(u.protocol)) return u.href;
  return `${hostKey(u.host)}${u.pathname || '/'}${normalizeQuery(u.search)}${u.hash}`;
}

/**
 * Do two written values point at the same place? This is the question the diff
 * asks before it calls an attribute changed.
 */
function sameTarget(before, after, bases = {}) {
  const a = targetKey(before, bases.old);
  const b = targetKey(after, bases.new || bases.old);
  if (!a && !b) return true;      // both empty
  return a === b;
}

/**
 * The sentence a person reads about a link that moved, and the address worth
 * tracing if they want to follow it. Written against the *destinations*, so a
 * page that moved is named by its own path rather than by the archive's.
 *
 * Returns null when there is nothing to say (an unresolvable value on either
 * side, which the plain attribute row already covers).
 *
 * opts.noun names what the URL points *at*, a page for a link, a file for an
 * image or a form, because "the same site, but a different page" is the right
 * sentence for one and the wrong one for the other.
 */
function classifyUrlChange(before, after, bases = {}, opts = {}) {
  const noun = opts.noun === 'file' ? 'file' : 'page';
  const a = resolveTarget(before, bases.old || bases.new);
  const b = resolveTarget(after, bases.new || bases.old);
  if (!a || !b || !a.resolved || !b.resolved) return null;

  const ua = parse(a.target);
  const ub = parse(b.target);
  if (!ua || !ub) {
    return { kind: 'text', text: `The address changed: ${a.target} → ${b.target}.`, traceUrl: b.target };
  }

  // A lazy-loading swap: one end holds a tiny inline placeholder picture
  // (data:) while the other names a file. Without this branch the host
  // comparison below would call it "a different domain entirely", which is
  // technically where data: lives and no use to anybody.
  const aInline = ua.protocol === 'data:';
  const bInline = ub.protocol === 'data:';
  if (aInline || bInline) {
    const fileNameOf = (u) => {
      const seg = String(u.pathname || '').split('/').filter(Boolean).pop() || '';
      return seg ? decodeSafe(seg) : showPath(u.pathname || '/');
    };
    if (aInline && bInline) {
      return {
        kind: 'inline',
        text: 'Both snapshots hold tiny inline placeholder pictures instead of files. They read as different because the placeholders differ.',
        traceUrl: b.target,
      };
    }
    if (bInline) {
      return {
        kind: 'inline',
        text: `The later snapshot holds a tiny inline placeholder picture instead of loading ${fileNameOf(ua)}. The real picture usually lives in the element's data-src address.`,
        traceUrl: a.target,
      };
    }
    return {
      kind: 'inline',
      text: `The earlier snapshot held a tiny inline placeholder picture. The later one loads the file ${fileNameOf(ub)} instead.`,
      traceUrl: b.target,
    };
  }

  if (hostKey(ua.host) !== hostKey(ub.host)) {
    return {
      kind: 'domain',
      text: `This now points to a different domain entirely: ${ua.host} → ${ub.host}.`,
      traceUrl: b.target,
    };
  }
  if (ua.pathname !== ub.pathname) {
    if (stripTrailingSlash(ua.pathname) === stripTrailingSlash(ub.pathname)) {
      return {
        kind: 'slash',
        text: `Same page, written ${ub.pathname.endsWith('/') ? 'with' : 'without'} a trailing slash now: ` +
          `${showPath(ua)} → ${showPath(ub)}.`,
        traceUrl: b.target,
      };
    }
    return {
      kind: 'page',
      text: `Same site, but it now points to a different ${noun}: ${showPath(ua)} → ${showPath(ub)}.`,
      traceUrl: b.target,
    };
  }
  if (normalizeQuery(ua.search) !== normalizeQuery(ub.search)) {
    return {
      kind: 'params',
      text: `Same page, just different URL parameters attached: ` +
        `${showQuery(ua.search) || '(none)'} → ${showQuery(ub.search) || '(none)'}.`,
      traceUrl: b.target,
    };
  }
  if (ua.hash !== ub.hash) {
    return {
      kind: 'fragment',
      text: `Same page, it just jumps to a different section of it now: ` +
        `${showHash(ua.hash) || '(top of page)'} → ${showHash(ub.hash) || '(top of page)'}.`,
      traceUrl: b.target,
    };
  }
  if (ua.protocol !== ub.protocol) {
    // Unreachable for http and https by design, those are the same destination
    // and never reach the change list at all. This is for the exotic pair: a
    // link that moved from ftp: or mailto: to something else entirely.
    return {
      kind: 'protocol',
      text: `Only the protocol changed (${ua.protocol} → ${ub.protocol}). Same destination either way.`,
      traceUrl: b.target,
    };
  }
  return {
    kind: 'text',
    text: `The address is written differently now (${a.target} → ${b.target}) but it resolves to the same place.`,
    traceUrl: b.target,
  };
}

module.exports = {
  URL_ATTR_NAMES,
  resolveTarget,
  targetKey,
  sameTarget,
  classifyUrlChange,
};
