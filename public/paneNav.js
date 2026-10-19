/* The pane's own back/forward/refresh/reset, as a pure history stack.
   ---------------------------------------------------------------------------
   Each snapshot pane is a tiny browser, and it needs browser history that
   actually works. It used to drive the iframe's own history directly
   (`contentWindow.history.back()`), which reads well and fails silently:
   reading `.history` off a cross-origin window throws a SecurityError, and
   the pane is cross-origin exactly when the toolbar matters, after
   following a link out to a real archive page. So every toolbar click died
   in a swallowed exception, and the buttons only ever worked while there
   was nowhere to go back to.

   Instead the parent keeps the stack: entries are either the diffed
   comparison itself ({ home: true }, rendered from saved srcdoc HTML) or an
   archive URL the reader followed ({ url }). Back, forward and refresh only
   ever *write* to the iframe (srcdoc/src attributes), which no origin check
   forbids, and never read from it, which is what used to throw.

   This file holds the stack mechanics and nothing else, no DOM, no
   iframe, so it runs identically in the browser and under test. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PdiffNav = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createStack() {
    var entries = [{ home: true }];
    var index = 0;
    return {
      // Following a link: drop any forward entries, then append. Navigating
      // to the address already showing is a no-op rather than a duplicate
      // entry, so double-clicking a link doesn't pollute the stack.
      pushUrl: function (url) {
        if (!url) return false;
        var cur = entries[index];
        if (cur && cur.url === url) return false;
        entries = entries.slice(0, index + 1);
        entries.push({ url: url });
        index = entries.length - 1;
        return true;
      },
      back: function () {
        if (index <= 0) return null;
        index--;
        return entries[index];
      },
      forward: function () {
        if (index >= entries.length - 1) return null;
        index++;
        return entries[index];
      },
      // Reset ("return to comparison") starts history over at the
      // comparison itself, the same as re-landing on it.
      reset: function () {
        entries = [{ home: true }];
        index = 0;
        return entries[0];
      },
      current: function () {
        return entries[index] || null;
      },
      canBack: function () {
        return index > 0;
      },
      canForward: function () {
        return index < entries.length - 1;
      },
      // For tests and debugging only: the shape of the stack.
      snapshot: function () {
        return { entries: entries.slice(), index: index };
      },
    };
  }

  // Only http(s) addresses ever enter the stack. The pane renders them with
  // an iframe src assignment, so anything else (mailto:, javascript:, data:)
  // must keep its native behavior instead of being swallowed here.
  function isNavigableUrl(href) {
    return typeof href === 'string' && /^https?:\/\//i.test(href.trim());
  }

  // What the address bar shows. The stack keeps the full archived address
  // (that is what the iframe actually loads), but a person reads the
  // page's own address: web.archive.org's /web/<timestamp>.../ prefix is
  // how the copy was fetched, not where the page lives. Non-archive
  // addresses (a followed live link, a typed address) pass through
  // untouched, as does anything unparseable.
  function displayUrl(url) {
    if (typeof url !== 'string') return url;
    var m = /^https?:\/\/web\.archive\.org\/web\/\d+[a-z]*_?\/(.*)$/i.exec(url.trim());
    if (!m) return url;
    var inner = (m[1] || '').trim();
    if (!inner) return url;
    return inner;
  }

  // The page an address names, ignoring which copy of it: the archive's
  // /web/<timestamp>/ prefix, the http/https scheme, a www. prefix, the
  // query string and the fragment all say which capture or which variant,
  // never which page. Two addresses with the same key are the same page
  // (a language toggle out and back lands here), however differently the
  // archive happened to spell each capture.
  function innerPageKey(url) {
    var raw = String(url == null ? '' : url).trim();
    if (!raw) return '';
    var m = /^https?:\/\/web\.archive\.org\/web\/\d+[a-z]*_?\/(.*)$/i.exec(raw);
    var inner = m ? (m[1] || '').trim() : raw;
    if (!inner) return '';
    // Scheme-less but host-like: the app stores addresses bare (host plus
    // path, no scheme), so a home built from one reads as a relative path
    // without this and can never equal the absolute address of a followed
    // link to the same page. That mismatch is exactly how a language
    // toggle out and back stopped restoring the comparison: every return
    // home compared 'rel:/settlement.org' against 'settlement.org/'.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(inner) && inner.charAt(0) !== '/' &&
        /^[^\s/?#]+\.[^\s/?#]+/.test(inner)) {
      inner = 'http://' + inner;
    }
    var parsed = null;
    try {
      parsed = new URL(inner, 'http://placeholder.invalid');
    } catch (_) {
      return inner.toLowerCase();
    }
    // Relative inner (the archive stored the capture relative to the page):
    // no host to normalize, the path is the whole identity.
    if (parsed.hostname === 'placeholder.invalid') {
      return 'rel:' + parsed.pathname.replace(/\/+$/, '').toLowerCase();
    }
    var host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    var path = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    return host + path;
  }

  // A link that names a spot on the page it sits in, not another page.
  //
  // It has to be read off the raw attribute, not the resolved href. The
  // panes render from srcdoc, whose document address is `about:srcdoc`,
  // while a relative `#Sep` resolves against the capture's base into the
  // archive's full address. Comparing those two said "different page", so
  // every month strip, tab and in-page menu inside a snapshot was followed
  // out to web.archive.org and the pane reloaded a whole new capture - the
  // page vanished, a spinner took its place, and what was one band sliding
  // left read as a new website opening.
  function isSamePageFragment(rawHref) {
    return typeof rawHref === 'string' && /^\s*#/.test(rawHref);
  }

  // The name after the '#', or '' for a bare '#'.
  function fragmentName(rawHref) {
    if (!isSamePageFragment(rawHref)) return '';
    return rawHref.trim().replace(/^#/, '');
  }

  // Same page, any capture: what makes a followed link a return home
  // rather than a new page (see navigate() in public/app.js).
  function sameArchivePage(a, b) {
    var ka = innerPageKey(a);
    var kb = innerPageKey(b);
    return !!(ka && kb && ka === kb);
  }

  return {
    createStack: createStack,
    isNavigableUrl: isNavigableUrl,
    isSamePageFragment: isSamePageFragment,
    fragmentName: fragmentName,
    displayUrl: displayUrl,
    innerPageKey: innerPageKey,
    sameArchivePage: sameArchivePage,
  };
}));
