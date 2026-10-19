// lib/prepareCapture.js
//
// One way of turning a raw archived page into a document a browser can render.
// Both the compare view and the film use this, so a capture looks identical in
// whichever one you are looking at. There is no second, cheaper path, and the
// reason is written below because it was learned the hard way.

const { JSDOM } = require('jsdom');
const { reviveWidgets } = require('./reviveWidgets');

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
//
// 3: revived the widgets a capture needed a script to show - the owl carousel
// that is `display: none` until its plugin runs, and the lazy pictures that sit
// behind a 1x1 placeholder until one copies `data-src` across. Rows cached by
// revision 2 are re-prepared in place, which is what makes the repair reach the
// film without refetching a single page.
//
// 4: the picture half of 3 did nothing in the running app. The record's key is
// scheme-less, a relative `data-src` cannot be resolved against it, and the
// failed resolution was swallowed - so a row repaired by 3 is stamped current
// and still full of 1x1 placeholders. That is exactly the stale document this
// number exists to make visible, and the repaired page is re-repaired from the
// same row: the placeholder and the real address are both still in it.
//
// 5: the carousel half of 3 put the window on the wrong slides. It laid every
// slide out in a row and pulled the row sideways by a negative margin, which
// widens the row - the shift made each slide bigger rather than moving the row -
// so a 1442px frame showed Aug/Sep/Oct where the plugin showed Dec/Jan/Feb.
// The window is now stated as exactly which slides are on screen, which cannot
// go wrong that way. The rows 4 wrote carried that geometry and were stamped
// current, which is why this bump exists: the revival is now rebuilt from the
// page on every pass (lib/reviveWidgets.js, unwrapRevival) rather than skipped
// when a container already looks revived, so 4's rows come out of this one
// correct instead of keeping the bad window forever.
//
// 6: 5's way of stating the window was leaking. It showed the slides in the
// window and hid the rest with `:nth-child(n+A):nth-child(-n+B)`, and a tier's
// rules can only ever add visible slides, a narrower band still inherited the
// widest band's window. Measured on a real frame: at 413px across, `--pal-n`
// correctly read 1 and three slides were on screen. The window is now the track
// pulled sideways with a transform, which a narrower band replaces rather than
// adds to (lib/reviveWidgets.js, buildCss, has both failures written down).
//
// 8: the revived carousel restates the plugin's own positioning contract
// (`position: relative` on each item wrapper, lib/reviveWidgets.js), so
// absolutely-positioned in-slide content keeps its containing block instead
// of resolving against a distant ancestor and landing outside its picture.
// Rows cached by 7 are re-prepared in place, which carries the one-rule fix
// to every frame without refetching a single page.
//
// 9: stylesheets a page injects from its own scripts are materialized as
// real <link> elements (materializeInjectedStylesheets below). The
// settlement.org carousel loads its plugin CSS with the classic loadCSS
// pattern (document.createElement('link') + l.href = '....css', run on
// rAF/load), and nothing here runs a capture's JavaScript, so those links
// were never created: the `.item h3 { position: absolute }` overlay rule
// never applied and every slide caption rendered as static text above its
// picture. Rows cached by 8 are re-prepared in place, which carries the
// missing links to every frame without refetching a single page.
//
// 7: every link that asked for a new tab now stays in the pane. Archived
// pages mark language toggles and outbound links target="_blank", and the
// panes run sandboxed without popups, so those links died silently with no
// feedback. The capture now forces them to _self (and drops a base target
// that would do the same to every link), so following them navigates the
// pane itself like a browser.
const PREPARE_VERSION = 9;
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
// The origin a root-relative asset path belongs to: the page's own scheme
// and host when the address carries them, https over the bare host
// otherwise (the Archive follows the scheme to the capture it has).
function pageOriginFor(url) {
  const raw = String(url || '').trim();
  try {
    return new URL(raw).origin;
  } catch (_) { /* bare host below */ }
  const host = raw.split('/')[0].split('?')[0].split('#')[0];
  return `https://${host}`;
}

// Where a stylesheet address points once the page renders: absolute live
// addresses and bare paths are wrapped in the capture they came from (the
// `cs_` modifier asks the Archive for the stylesheet variant), while
// addresses already naming an archived copy pass through untouched.
function toArchivedCssUrl(href, { url, timestamp }) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\/web\.archive\.org\/web\//i.test(h)) return h;
  if (/^\/web\//i.test(h)) return `https://web.archive.org${h}`;
  if (/^https?:\/\//i.test(h)) return `https://web.archive.org/web/${timestamp}cs_/${h}`;
  if (h.startsWith('/')) return `https://web.archive.org/web/${timestamp}cs_/${pageOriginFor(url)}${h}`;
  if (h.startsWith('//')) return `https:${h}`;
  return `https://web.archive.org/web/${timestamp}cs_/${pageOriginFor(url)}/${h}`;
}

// Stylesheets a page's own scripts would have injected at runtime.
//
// The loadCSS pattern (document.createElement('link') with l.href =
// '....css', run on requestAnimationFrame or window load) is how several
// captures ship their widget CSS, and nothing in this app runs a captured
// page's JavaScript: those links are never created, their rules never
// apply, and the page renders genuinely wrong (a carousel's overlay
// caption as static text above its picture, a widget's hide-until-ready
// rules missing). So the loader scripts are read once, before they are
// stripped, and every stylesheet address they assign to a built link
// element becomes a real <link> in <head>.
//
// Only scripts that actually build link elements are read, and
// commented-out lines are skipped (an older path usually survives in
// there, commented). Anything already linked is not linked twice. The new
// links go right after the <base>, ahead of every stylesheet the page
// already had, which is where the loader put them (before <head>).
function materializeInjectedStylesheets(doc, { url, timestamp } = {}) {
  if (!doc || !doc.head || !timestamp) return;
  const seen = new Set(
    Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))
      .map((l) => (l.getAttribute('href') || '').trim())
      .filter(Boolean)
  );
  const found = [];
  doc.querySelectorAll('script').forEach((s) => {
    const text = String(s.textContent || '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    if (!/createElement\s*\(\s*['"]link['"]\s*\)/i.test(text)) return;
    const re = /\.href\s*=\s*['"]([^'"]+?\.css(?:\?[^'"]*)?)['"]/gi;
    let m;
    while ((m = re.exec(text))) {
      const href = m[1].trim();
      if (href && !seen.has(href)) {
        seen.add(href);
        found.push(href);
      }
    }
  });
  if (!found.length) return;
  // Each link lands after the previous one, so the loader's own order (the
  // plugin before its theme before the site's overrides) survives.
  let anchor = doc.querySelector('base');
  const headFirst = anchor ? null : doc.head.firstChild;
  found.forEach((href) => {
    const archived = toArchivedCssUrl(href, { url, timestamp });
    if (!archived) return;
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', archived);
    if (anchor) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
      anchor = link;
    } else {
      doc.head.insertBefore(link, headFirst);
      anchor = link;
    }
  });
}

function stripScripts(doc) {
  doc.querySelectorAll('script, noscript').forEach((n) => n.remove());
}

// The toolbar, as a safety net. "if_" mode already suppresses it; when it slips
// through, it is a fixed banner across the top of every frame.
function stripWaybackChrome(doc) {
  doc.querySelectorAll(CHROME_LINK).forEach((n) => n.remove());
  doc.querySelectorAll('#wm-ipp-base, #wm-ipp').forEach((n) => n.remove());
}

// A new-tab link inside a sandboxed pane without popups goes nowhere: the
// browser blocks the popup and the pane stays put with no feedback. The
// panes navigate themselves instead (see public/app.js), so every element
// that could ask for a new browsing context is forced back to the pane
// itself. Runs here so it reaches every snapshot at rest, not just the
// ones a click handler happens to intercept.
function forceSameTabTargets(doc) {
  if (!doc || !doc.querySelectorAll) return;
  doc.querySelectorAll('base[target]').forEach((base) => {
    base.removeAttribute('target');
  });
  doc.querySelectorAll('a[target], area[target], form[target]').forEach((node) => {
    const current = (node.getAttribute('target') || '').trim().toLowerCase();
    // _self is already the pane itself; anything else (_blank, _new, a
    // named window, _top/_parent which would escape the pane) becomes it.
    if (current && current !== '_self') node.setAttribute('target', '_self');
  });
}

// "js" so that archived pages which ship progressive-enhancement styles, hide a
// menu until JS runs, and so on, still show their JS version rather than
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
  // bases behind, the first one silently wins and the page ends up pointing
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
 * compare view's last step, marking up changed nodes and re-serializing them.
 * Outlines belong on a page you are comparing against another page; on every
 * frame of a film they would be showing you the diff rather than the site.
 *
 * Those two things are split across the call site rather than a flag here,
 * because `diffSnapshots` in lib/diffEngine.js already does all of it and the
 * film should not have to ask for the half it does not want.
 *
 * The revival pass is here rather than in either view for the same reason the
 * rest is: a capture that only one of them repaired would be two different
 * pages, and the film and the compare view would disagree about what a moment
 * looked like. See lib/reviveWidgets.js.
 */
function prepareCapture(rawHtml, { url, timestamp } = {}) {
  const doc = new JSDOM(rawHtml).window.document;

  // Read the widgets before the scripts are stripped: what a carousel showed is
  // written in its configuration, and that is in a script.
  reviveWidgets(doc, { rawHtml, url, timestamp });

  // Read the loader scripts before they are stripped for the same reason:
  // the stylesheet links they would have injected have to exist first.
  materializeInjectedStylesheets(doc, { url, timestamp });

  stripScripts(doc);
  stripWaybackChrome(doc);
  markAsScriptCapable(doc);
  injectBaseHref(doc, url, timestamp);
  forceSameTabTargets(doc);
  stampCaptureVersion(doc);

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

module.exports = { prepareCapture, PREPARE_VERSION, CAPTURE_STAMP_NAME };