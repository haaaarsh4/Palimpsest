// lib/prepareCapture.js
//
// One way of turning a raw archived page into a document a browser can render.
// Both the compare view and the film use this, so a capture looks identical in
// whichever one you are looking at. There is no second, cheaper path, and the
// reason is written below because it was learned the hard way.

const { JSDOM } = require('jsdom');

// Which revision of this pipeline produced a document.
//
// Bump it whenever the steps below change what comes out, and every document
// prepared by an older revision becomes detectably stale. The browser keeps
// these pages on disk for weeks, and a page that was correct when it was
// stored can stop being correct when this file changes underneath it. Nothing
// in the page itself would say so: a capture whose <base> ended up in the
// wrong place still looks like a complete, plausible, unstyled page. That is
// exactly the failure this stamp exists to make visible, and the client
// refetches anything that does not carry the current one.
//
// It lives in <head>, which diffSnapshots never looks at - it collects leaves
// from <body> only - so stamping a document cannot change a change count.
const PREPARE_VERSION = 2;
const CAPTURE_STAMP_NAME = 'palimpsest-capture';

// The Wayback playback bundle: the banner scripts and stylesheet that "if_"
// mode is supposed to suppress but does not always.
const CHROME_LINK = 'link[href*="archive.org/_static"], script[src*="archive.org/_static"], style[id*="wm-ipp"], div[id^="wm-ipp"]';

// Strips scripts, and the <noscript> fallback that goes with them.
//
// Nothing in this app runs a captured page's JavaScript: these are documents
// from 1999 whose scripts cannot be trusted, cannot run against an iframe with
// no real origin, and in the case of Wombat actively rewrite the page as it
// loads. <noscript> has to go for the same reason - it is the markup a site
// shows when scripting is off, and since nothing here runs scripts, keeping it
// would render the fallback on top of the real page. Several captures of this
// era hide a whole alternate layout inside one.
function stripScripts(doc) {
  doc.querySelectorAll('script, noscript').forEach((n) => n.remove());
}

// The toolbar, as a safety net. "if_" mode already suppresses it; when it slips
// through, it is a fixed banner across the top of every frame.
function stripWaybackChrome(doc) {
  doc.querySelectorAll(CHROME_LINK).forEach((n) => n.remove());
  doc.querySelectorAll('#wm-ipp-base, #wm-ipp').forEach((n) => n.remove());
}

// "js" so that archived pages which ship progressive-enhancement styles — hide a
// menu until JS runs, and so on — still show their JS version rather than
// collapsing to an unstyled block.
function markAsScriptCapable(doc) {
  const html = doc.documentElement;
  if (!html) return;
  const classes = (html.getAttribute('class') || '')
    .split(/\s+/)
    .filter((c) => c && c !== 'no-js');
  if (!classes.includes('js')) classes.push('js');
  html.setAttribute('class', classes.join(' '));
}

// A <base> tag is what makes a raw capture render as itself: archived HTML is
// stored with root-relative URLs ("/images/logo.png"), and without a base they
// resolve against THIS server, 404, and the capture comes out unstyled with
// every image broken.
//
// It has to go in the parsed document rather than into the string, and that is
// not a style preference. Archived pages of this era open with IE conditional
// comments, e.g.
//
//   <!--[if lt IE 9 ]><html class="ie ie6"><head>...<![endif]-->
//
// A regex finds that commented-out <head> first, plants the base inside a
// comment the browser never reads, and the real <head> is left with nothing.
// Parsing sidesteps it entirely: JSDOM builds a tree, so there is exactly one
// head and it is the right one. That bug shipped, and it is why this file
// exists rather than a string replace.
function injectBaseHref(doc, url, timestamp) {
  if (!timestamp || !doc.head) return;

  // Replace rather than add. This matters because prepareCapture is not always
  // the first thing to touch a page: the repair script runs it over rows that
  // an older build already prepared, and applying it twice must not leave two
  // bases behind — the first one silently wins and the page ends up pointing
  // at the wrong capture.
  const existing = doc.querySelectorAll('base');
  if (existing.length) {
    existing.forEach((n) => n.remove());
  }

  const base = doc.createElement('base');
  base.setAttribute('href', `https://web.archive.org/web/${timestamp}/${url}`);
  doc.head.insertBefore(base, doc.head.firstChild);
}

// The stamp described at the top of this file. Appended to <head>, after the
// <base>, so it can never displace it.
function stampCaptureVersion(doc) {
  if (!doc.head) return;
  doc.querySelectorAll(`meta[name="${CAPTURE_STAMP_NAME}"]`).forEach((n) => n.remove());
  const meta = doc.createElement('meta');
  meta.setAttribute('name', CAPTURE_STAMP_NAME);
  meta.setAttribute('content', String(PREPARE_VERSION));
  doc.head.appendChild(meta);
}

/**
 * Turn a raw archived page into the document a browser should render.
 *
 * This is the film's half of the compare view: the same cleanup, in the same
 * order, through the same parser. What it deliberately does NOT do is the
 * compare view's last step — marking up changed nodes and re-serializing them.
 * Outlines belong on a page you are comparing against another page; on every
 * frame of a film they would be showing you the diff rather than the site.
 *
 * Those two things are split across the call site rather than a flag here,
 * because `diffSnapshots` in lib/diffEngine.js already does all of it and the
 * film should not have to ask for the half it does not want.
 */
function prepareCapture(rawHtml, { url, timestamp } = {}) {
  const doc = new JSDOM(rawHtml).window.document;

  stripScripts(doc);
  stripWaybackChrome(doc);
  markAsScriptCapable(doc);
  injectBaseHref(doc, url, timestamp);
  stampCaptureVersion(doc);

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

module.exports = { prepareCapture, PREPARE_VERSION, CAPTURE_STAMP_NAME };