// lib/diffEngine.js
//
// The goal here is to diff two web pages the way a person would look at
// them: by content blocks (paragraphs, headings, list items, images, links),
// not by raw character-for-character HTML text. A one-character change in a
// build hash buried in a <script> tag shouldn't register as "the page
// changed completely," and a reworded headline shouldn't get lost in noise.
//
// The approach:
//   1. Parse both snapshots into DOM trees with jsdom.
//   2. Strip <script> tags immediately (we never want archived JS to run).
//   3. Walk each tree and collect "content leaves": the smallest elements
//      that hold meaningful content (a paragraph, a link, an image, a
//      heading, a list item), in document order.
//   4. Run a sequence diff (the same longest-common-subsequence idea behind
//      `git diff`) over those two ordered lists, matching leaves by a
//      normalized signature of their tag, text, and key attributes.
//   5. Where the diff finds a run of removed leaves immediately followed by
//      a run of added leaves, we treat matching pairs as "changed" rather
//      than "deleted + unrelated new thing," which reads much closer to how
//      a human would describe the edit.
//   6. Mark up both trees with diff-* classes and hand back the annotated
//      HTML for each, plus a plain-language change summary for the notes
//      panel and the AI insight step.

const { JSDOM } = require('jsdom');
const { diffArrays } = require('diff');
const { URL_ATTR_NAMES, targetKey, sameTarget, classifyUrlChange } = require('./urlTarget');

const LEAF_TAGS_WITH_NO_TEXT_OK = new Set(['IMG', 'IFRAME', 'VIDEO', 'AUDIO', 'HR', 'INPUT']);

// A leaf's visible text can be identical before and after while the leaf
// still legitimately counts as "changed", a link whose label stayed the
// same but whose destination moved, an image whose src changed but whose
// alt text didn't. Text alone can't explain that to a person reading the
// changes list, so for these tags we also snapshot the attributes that
// actually carry meaning, and diff those separately.
const DISPLAY_ATTRS_BY_TAG = {
  A: ['href', 'title', 'target'],
  // data-src names the real file on lazy-loaded pictures (src holds the
  // placeholder); width and height are how an icon ends up rendering at a
  // different size with the same file and the same description, which used
  // to read as no change at all. srcset names the responsive candidates;
  // without it a picture can swap resolutions with the same src and read
  // as unchanged.
  IMG: ['src', 'alt', 'title', 'data-src', 'width', 'height', 'srcset'],
  IFRAME: ['src', 'title'],
  VIDEO: ['src', 'poster'],
  AUDIO: ['src'],
  INPUT: ['type', 'placeholder', 'value', 'name'],
};

// The change list on its own ("changed <a>") doesn't say *where* on the
// page something lives, which matters a lot when a leaf that structurally
// exists in the HTML isn't actually visible in the rendered pane (a mobile
// nav item tucked inside a hamburger menu at this width, for instance). A
// short ancestor breadcrumb gives a person a fighting chance of placing it
// without having to hunt through the page themselves.
function buildPathContext(el, maxDepth = 3) {
  const parts = [];
  let node = el.parentElement;
  let depth = 0;
  while (node && node.tagName && node.tagName !== 'BODY' && depth < maxDepth) {
    let label = node.tagName.toLowerCase();
    if (node.id) {
      label += `#${node.id}`;
    } else if (node.classList && node.classList.length) {
      label += `.${Array.from(node.classList).slice(0, 2).join('.')}`;
    }
    parts.unshift(label);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

function captureAttrs(el) {
  const keys = DISPLAY_ATTRS_BY_TAG[el.tagName] || [];
  const out = {};
  keys.forEach((k) => {
    const v = el.getAttribute(k);
    if (v !== null && v !== '') out[k] = v;
  });
  return out;
}

// The document's own base, which is where a relative URL's meaning comes from  
// and, here, where the captured site's real origin is written down at all. See
// lib/urlTarget.js for why that matters as much as it does.
function docBaseHref(doc) {
  const base = doc && doc.querySelector ? doc.querySelector('base[href]') : null;
  return base ? base.getAttribute('href') : null;
}

// Compares two attribute snapshots and returns only the ones that differ,
// so a "changed" entry can say exactly which attribute moved and between
// what two values, instead of leaving a person to guess why something
// with identical text got flagged as changed at all.
//
// A URL attribute is the exception, and it is the whole reason this function
// takes bases: it is compared by where it points rather than by how it is
// spelled. Both captures have been through the Wayback Machine, which bakes its
// own timestamp into every absolute URL in the page, so `href` on the same link
// is a different string in every capture of a record, and the raw values are
// still what gets reported, because a person reading the row wants to see what
// the page says, not a normalized key.
function diffAttrs(before = {}, after = {}, bases = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  keys.forEach((name) => {
    const b = before[name] ?? null;
    const a = after[name] ?? null;
    if (b === a) return;
    // srcset holds a list of candidate URLs, each rewritten per capture by
    // the archive, so raw text always differs; only a destination-level
    // comparison can say whether the candidates moved.
    if (name === 'srcset' && b !== null && a !== null) {
      if (srcsetKey(b, bases.old) === srcsetKey(a, bases.new || bases.old)) return;
    }
    if (URL_ATTR_NAMES.has(name) && b !== null && a !== null && sameTarget(b, a, bases)) return;
    out.push({ name, before: b, after: a });
  });
  return out;
}

// Every URL attribute that really did move, with the sentence that explains it.
// Computed here rather than in the browser because it needs both documents' own
// bases, and because this is the part worth testing.
function urlChangesFor(attrChanges, bases) {
  const out = [];
  attrChanges.forEach((change) => {
    if (!URL_ATTR_NAMES.has(change.name)) return;
    // "a different page" is the right noun for a link and the wrong one for an
    // image or a form, which point at a file.
    const classified = classifyUrlChange(change.before, change.after, bases, {
      noun: change.name === 'href' ? 'page' : 'file',
    });
    if (classified) out.push({ name: change.name, ...classified });
  });
  return out;
}

// How much two leaves look like the same thing, edited, rather than one thing
// deleted and another written in its place. Identical text with the same tag is
// the easy case (something about the element changed that is not its words);
// otherwise it is a bigram overlap between the two texts, which is crude but has
// the property that matters here: "Contact" and "Contact us" score high, and
// "News" and "Events" score zero.
function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let hits = 0;
  A.forEach((count, g) => {
    const other = B.get(g);
    if (other) hits += Math.min(count, other);
  });
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

// The file part of a URL, lowercased, without query or fragment:
// "/web/2016.../http://site/img/icon-forum-c.png" -> "icon-forum-c.png".
// Archive prefixes vanish with it, so two captures spell the same file the
// same way however the archive rewrote each address.
function fileBaseOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || /^data:/i.test(s)) return '';
  const noQuery = s.split(/[?#]/)[0];
  const seg = (noQuery.split('/').pop() || '').trim().toLowerCase();
  try { return decodeURIComponent(seg) || seg; } catch (_) { return seg; }
}

const IMG_NAME_NOISE_RE = /^(?:\d+|old|new|final|latest|v\d+)$/;

// Same family test as the tooltip's imageNameFamily in public/app.js: two
// files whose names match once interchangeable parts are dropped
// (15-years/years, -old/-new, -v2/-v3) are the same picture re-saved; two
// names that merely share a prefix are not. Kept in step by test rather
// than by memory.
function imageNameFamilyOf(file) {
  const base = String(file || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  if (!base) return '';
  return base.split(/[-_ ]+/).filter((w) => w && !IMG_NAME_NOISE_RE.test(w)).join('');
}

// Two pictures in the same slot: the file, its versioned re-save, or the
// description says they are the same slot edited (score 1). Two pictures
// sharing nothing still pair positionally, but weakly (0.5, still above
// MATCH_FLOOR): the same slide holding a new picture is an edit, and the
// carousel test pins that. The weakness is the point: when the run also
// holds the real counterpart (same file, same family, same description),
// the dynamic program picks the strong 1.0 pairing and leaves the stranger
// as added.
//
// The exception is two NAMED pictures whose descriptions disagree: an old
// icon with no alt against a new file declaring itself "211Toronto.ca" is
// not the same slot edited, it is one picture deleted and another inserted
// beside it (measured: icon-forum-c.png paired with 211-logo.png while the
// 211 was a pure insertion). Those score 0, below MATCH_FLOOR, so the run
// aligns them as removed + added instead of a false "changed". Pictures
// with no words on either side stay positional: with nothing disagreeing,
// position is all there is.
function imgMatchScore(aAttrs, bAttrs) {
  const srcA = aAttrs.src || aAttrs['data-src'] || '';
  const srcB = bAttrs.src || bAttrs['data-src'] || '';
  const fileA = fileBaseOf(srcA);
  const fileB = fileBaseOf(srcB);
  if (fileA && fileA === fileB) return 1;
  if (fileA || fileB) {
    if (imageNameFamilyOf(fileA) === imageNameFamilyOf(fileB)) return 1;
  }
  const altA = String(aAttrs.alt || '').trim().toLowerCase();
  const altB = String(bAttrs.alt || '').trim().toLowerCase();
  if (altA && altA === altB) return 1;
  const titleA = String(aAttrs.title || '').trim().toLowerCase();
  const titleB = String(bAttrs.title || '').trim().toLowerCase();
  if (titleA && titleA === titleB) return 1;
  if (fileA && fileB && imageNameFamilyOf(fileA) !== imageNameFamilyOf(fileB) &&
      (altA !== altB || titleA !== titleB)) return 0;
  return 0.5;
}

function matchScore(a, b) {
  if (a.el.tagName !== b.el.tagName) return 0;
  // Both carry no text: an image, an input, a rule. For pictures the words
  // cannot decide, so the file and the description do (see imgMatchScore);
  // every other textless element still pairs, its attributes are compared
  // after pairing.
  if (!a.text && !b.text) {
    if (a.el.tagName === 'IMG') return imgMatchScore(a.attrs || {}, b.attrs || {});
    return 1;
  }
  if (a.text === b.text) return 1;
  // One of them gained or lost all of its text. That is not an edit of a leaf,
  // it is a leaf appearing or disappearing.
  if (!a.text || !b.text) return 0;
  return diceCoefficient(a.text.toLowerCase(), b.text.toLowerCase());
}

// Below this, two leaves are not the same leaf edited, they are two different
// leaves that happened to sit next to each other in the change.
const MATCH_FLOOR = 0.4;
// And below *this*, a pair of leftovers is not a move either. Deliberately much
// higher than MATCH_FLOOR: the second pass below has no order constraint to keep
// it honest, so it is only allowed to marry things that are nearly the same leaf.
const MOVE_FLOOR = 0.8;

// Turn a run of removed leaves and a run of added leaves into a set of edits at
// the same positions, plus the leaves that really were only removed or only
// added.
//
// This used to pair the first removed leaf with the first added leaf of the same
// tag, which is right often enough to look right and wrong in ways that are hard
// to see: three removed links against two added ones would report two edits by
// position and lose the deletion entirely, and a deleted paragraph followed by
// an unrelated new heading of the same tag would be reported as "this paragraph
// was rewritten into that heading".
//
// What runs instead is a small dynamic program over a similarity matrix: it
// picks the set of pairings with the highest total score, and, because the
// matrix is walked in document order, it never pairs things across each other,
// so a pairing always keeps the reading order of both sides. Runs of changed
// leaves are a handful of items, so the quadratic cost is nothing.
function alignRuns(removedLeaves, addedLeaves) {
  const n = removedLeaves.length;
  const m = addedLeaves.length;
  const score = (i, j) => matchScore(removedLeaves[i], addedLeaves[j]);

  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      const pair = s >= MATCH_FLOOR ? s + best[i + 1][j + 1] : -1;
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
    }
  }

  const pairs = [];
  const removedOnly = [];
  const addedOnly = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s >= MATCH_FLOOR && best[i][j] === s + best[i + 1][j + 1]) {
      pairs.push([i, j]);
      i++;
      j++;
      continue;
    }
    if (best[i + 1][j] >= best[i][j + 1]) removedOnly.push(i++);
    else addedOnly.push(j++);
  }
  while (i < n) removedOnly.push(i++);
  while (j < m) addedOnly.push(j++);

  // Second pass: what is left over, paired by how alike the two leaves are rather
  // than by position.
  //
  // This is what a *move* looks like, the same paragraph now sitting on the other
  // side of a sibling that was inserted above it, and the pass above cannot see
  // it by definition, since it only ever pairs things in document order. Without
  // this, a paragraph that moved one place would be reported twice, once as
  // deleted and once as brand new, with identical text at both ends.
  const leftover = [];
  removedOnly.forEach((ri) => addedOnly.forEach((ai) => {
    const s = matchScore(removedLeaves[ri], addedLeaves[ai]);
    if (s >= MOVE_FLOOR) leftover.push({ ri, ai, s });
  }));
  leftover.sort((x, y) => y.s - x.s);
  const usedRemoved = new Set();
  const usedAdded = new Set();
  const moved = [];
  leftover.forEach(({ ri, ai }) => {
    if (usedRemoved.has(ri) || usedAdded.has(ai)) return;
    usedRemoved.add(ri);
    usedAdded.add(ai);
    moved.push([ri, ai]);
  });

  return {
    pairs: pairs.concat(moved),
    removedOnly: removedOnly.filter((ri) => !usedRemoved.has(ri)),
    addedOnly: addedOnly.filter((ai) => !usedAdded.has(ai)),
  };
}

// A single leaf's text is capped, generously, purely as a safety net
// against a pathological page dumping an entire article into one
// unstructured leaf and blowing up payload size, not as a "preview"
// length. Anything under this never gets cut, so the changes list and its
// detail view can always show the complete text rather than a fragment.
const MAX_LEAF_TEXT = 2000;

function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function isContentLeaf(el) {
  if (!(el instanceof el.ownerDocument.defaultView.Element)) return false;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
  // A hidden form field is plumbing, not content. Almost every one of them on an
  // archived page holds machine state, ASP.NET's __VIEWSTATE is a base64 blob
  // that differs on every single render, so reading them as content leaves means
  // reporting a change that no person made and no person can see. Measured on one
  // pair of captures of settlement.org: two of the twenty-four "changed" entries
  // were nothing but viewstate.
  if (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
  const hasElementChildren = Array.from(el.children).length > 0;
  if (hasElementChildren) return false;
  if (LEAF_TAGS_WITH_NO_TEXT_OK.has(tag)) return true;
  return normalizeText(el.textContent).length > 0;
}

function collectLeaves(root) {
  const leaves = [];
  let counter = 0;
  // Read once for the whole document: every relative URL in it is resolved
  // against this, and looking it up per leaf would be the same string six
  // hundred times.
  const baseHref = docBaseHref(root.ownerDocument || root);

  function walk(node) {
    if (node.nodeType !== 1) return; // element nodes only
    if (isContentLeaf(node)) {
      const id = `pdiff-${counter++}`;
      node.setAttribute('data-pdiff-id', id);
      const fullText = normalizeText(node.textContent);
      leaves.push({
        id,
        el: node,
        signature: buildSignature(node, baseHref),
        text: fullText.length > MAX_LEAF_TEXT ? fullText.slice(0, MAX_LEAF_TEXT) : fullText,
        textTruncated: fullText.length > MAX_LEAF_TEXT,
        attrs: captureAttrs(node),
        path: buildPathContext(node),
      });
      return; // don't descend into a leaf
    }
    Array.from(node.children).forEach(walk);
  }

  Array.from(root.children).forEach(walk);
  annotateLeaves(root.ownerDocument || root, leaves);
  return leaves;
}

// Two facts about a leaf that its own markup cannot tell the reader, but
// which decide whether a change can be *shown* or only described:
//
//   duplicate  another leaf in this same document carries an identical
//              signature, so this element is one of several the page repeats.
//              "Scroll to the change" then has to pick the copy a person can
//              actually see; measured on one pair of captures of settlement.org
//              (Jun 2016 → Oct 2026), four changed <img> rows were repeats of
//              the same one-slide carousel, and the earlier pane marked a copy
//              that was clipped out of view, so selecting the change scrolled
//              nowhere and nothing lit up.
//
//   carousel   which slide of a revived carousel band the leaf sits in, and how
//              many slides the band has. The band shows one slide and clips the
//              rest, so a marked slide can be perfectly real and off-screen; with
//              the position known, the band can be moved to the slide instead of
//              the reader being told to hunt for it.
function annotateLeaves(root, leaves) {
  const bySignature = new Map();
  leaves.forEach((leaf) => {
    const list = bySignature.get(leaf.signature);
    if (list) list.push(leaf);
    else bySignature.set(leaf.signature, [leaf]);
  });
  bySignature.forEach((list) => {
    if (list.length < 2) return;
    list.forEach((leaf) => { leaf.duplicate = true; });
  });

  const doc = root.ownerDocument || root;
  if (!doc || !doc.querySelectorAll) return;
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  Array.from(doc.querySelectorAll('.pal-track')).forEach((track) => {
    const items = Array.from(track.children).filter((el) => el.classList && el.classList.contains('owl-item'));
    items.forEach((item, index) => {
      Array.from(item.querySelectorAll('[data-pdiff-id]')).forEach((el) => {
        const leaf = byId.get(el.getAttribute('data-pdiff-id'));
        if (leaf) leaf.carousel = { size: items.length, index };
      });
    });
  });
}

// What makes two leaves "the same leaf" in a sequence diff: its tag, its text,
// and every attribute the change list cares about.
//
// The attributes are in here because they decide whether a leaf is reported at
// all. A signature of tag-plus-text alone means two elements with the same words
// match, the diff finds nothing to say about them, and an attribute that changed
//, a link's title, a form field's placeholder, an input's value, an image's alt
// text, is never looked at. Measured on this engine before this was fixed: a
// link whose title changed from "Old" to "New" produced an empty change list.
//
// URL attributes go in as their *destination* rather than as written, because the
// archive rewrites those per capture (see lib/urlTarget.js): comparing them as
// written would make every link and every image in a record look like a different
// element in every capture, and the whole page would read as replaced each time.
function srcsetKey(value, baseHref) {
  // A srcset is a comma-separated list of "url [descriptor]" candidates.
  // Each candidate URL is normalized as a destination like any other URL
  // attribute, so the archive's per-capture timestamp prefix never reads
  // as a change; descriptors ride along verbatim.
  return String(value || '').split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    const space = trimmed.search(/\s/);
    if (space < 0) return targetKey(trimmed, baseHref);
    return targetKey(trimmed.slice(0, space), baseHref) + trimmed.slice(space).replace(/\s+/g, ' ');
  }).join(', ');
}

function buildSignature(el, baseHref) {
  const tag = el.tagName;
  const parts = [tag];
  (DISPLAY_ATTRS_BY_TAG[tag] || []).forEach((name) => {
    const value = el.getAttribute(name) || '';
    if (name === 'srcset') parts.push(srcsetKey(value, baseHref));
    else parts.push(URL_ATTR_NAMES.has(name) ? targetKey(value, baseHref) : value);
  });
  parts.push(normalizeText(el.textContent));
  return parts.join('::');
}

function stripScripts(doc) {
  doc.querySelectorAll('script, noscript').forEach((n) => n.remove());
}

// Stripping every script means the site's own JavaScript never runs here,
// which is exactly the point (we never want archived JS to run) - but it
// has a real cost: an extremely common pattern (Modernizr and plenty of
// sites roll their own version of it) is a script that adds a "js" class
// to <html> the instant the page loads, and gates enhanced chrome behind
// it in CSS - an icon button's white background, an arrow glyph, anything
// considered "progressive enhancement." Without that class, all of that
// CSS simply never matches, and the button renders as bare text with no
// chrome at all, which looks exactly like a missing style even though
// nothing about the stylesheet itself is broken. This adds the class
// ourselves, directly, with no script involved at all, so that CSS gets
// its chance to apply. It's a no-op on sites that don't use this pattern.
function markAsScriptCapable(doc) {
  const html = doc.documentElement;
  if (!html) return;
  const classes = (html.getAttribute('class') || '')
    .split(/\s+/)
    .filter((c) => c && c !== 'no-js');
  if (!classes.includes('js')) classes.push('js');
  html.setAttribute('class', classes.join(' '));
}

// "if_" mode is meant to come with no toolbar at all, but as a safety net
// (and since this can't be tested against the real archive.org from here),
// we also remove any leftover Wayback banner/toolbar elements by their
// known ids and asset paths, so a stray fragment can't show up in the
// rendered page or throw off the diff.
function stripWaybackChrome(doc) {
  const banner = doc.getElementById('wm-ipp-base') || doc.getElementById('wm-ipp');
  if (banner) banner.remove();
  doc.querySelectorAll('link[href*="archive.org/_static"], script[src*="archive.org/_static"]').forEach((n) => n.remove());
}

// There is deliberately no base-href injection in this file.
//
// It used to have one, and having one here is precisely the bug that made the
// film and the compare view disagree about what a capture looks like. Both
// endpoints are handed documents that lib/fetchHtml.js has already run through
// prepareCapture(), which parses the page and puts exactly one <base> in the
// real <head>. This file then added a second one, at the front of the head,
// pointing at the same place - harmless by luck, because the first base wins
// and both had the same href, and invisible in review because it worked.
//
// The two paths drifted for a different reason entirely and much worse: the
// version that lived here could not see that the page opened with an IE
// conditional comment containing a commented-out <head>, so a regex-driven
// insert planted the base inside a comment the browser never reads. The
// compare view survived it because it went through the parser; the film, which
// came through the other path, did not, and rendered every capture of that
// era unstyled with broken images while still looking like a working page.
//
// So the base is injected in exactly one place, once, by the parser, and this
// file's job is only to diff and to annotate what it is given. If a document
// arrives here without a base, that is lib/fetchHtml.js's bug to fix, not
// something to paper over by writing a second one.

function injectDiffStyles(doc, variant) {
  const style = doc.createElement('style');
  style.setAttribute('data-pdiff-styles', 'true');
  // One color per pane rather than three separate semantic colors: red for
  // anything that was here before and isn't anymore (or was edited), green
  // for anything here now that's new or edited. Which pane you're looking
  // at already tells you whether that means "removed" or "added," so a
  // second color axis on top of that was just noise.
  //
  // This is drawn with `outline`, not `border`/`background`/`padding`.
  // Outline sits outside the element's box and never participates in
  // layout, so it can't overwrite the site's real background (which was
  // the actual bug: setting `background` wipes out any background-image
  // too, which is exactly how a button's arrow icon or a nav pill's tint
  // is usually drawn), and it can't resize or reshape the element the way
  // forcing `padding`/`margin` did. It only ever adds a frame on top of
  // whatever was already there, untouched.
  // Same red and green used everywhere else in the app (the sidebar's
  // changed/removed text, its badges, the legend dots) - not a separate
  // hand-picked pair just for this outline. Two different reds for the
  // same concept in different corners of the same app is exactly the
  // inconsistency this is meant to avoid.
  const color = variant === 'old' ? '#BB4530' : '#3F7A4E';
  // Pictures are excluded from the lifted frame below (see the img rule):
  // position+z-index on a marked <img> hoists it above the page's own
  // absolutely-positioned overlays, which is exactly how a slide's caption
  // bar ended up buried under its own picture.
  const selector = variant === 'old'
    ? '[data-pdiff-removed]:not(img)'
    : '[data-pdiff-added]:not(img), [data-pdiff-changed]:not(img)';
  const ringRgb = variant === 'old' ? '187,69,48' : '63,122,78';

  // Replaced elements paint their content over an inset box-shadow, so on
  // an <img> the ring survives only where the content isn't: the few
  // pixels of baseline gap under an inline image, which is exactly the
  // "outline only at the bottom" failure. Those elements get a real
  // outline with a negative offset instead, an inner ring by another
  // name: it lives inside the box (nothing outside to clip) and paints
  // above the content rather than under it.
  const imgSelector = variant === 'old'
    ? 'img[data-pdiff-removed]'
    : 'img[data-pdiff-added], img[data-pdiff-changed]';

  style.textContent = `
    ${selector} {
      scroll-margin-top: 40px;
      cursor: pointer;
      /* The frame is an INNER ring, not an outline: anything drawn outside
         the border box can be cut in half, an overflow:hidden tab strip
         clips whichever sides touch it and a later-painting neighbour
         covers the rest, which is how a mark ends up with two sides. An
         inner ring lives inside the box, so no ancestor can clip it and
         every side always draws. Lifted above plain content for the same
         reason, and cloned per fragment for wrapped inlines. Relative with
         no offsets lays out exactly as before. */
      box-shadow: inset 0 0 0 2px ${color} !important;
      position: relative;
      z-index: 1;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    ${imgSelector} {
      scroll-margin-top: 40px;
      cursor: pointer;
      box-shadow: none !important;
      outline: 2px solid ${color} !important;
      outline-offset: -2px !important;
      /* Deliberately no position/z-index lift here (unlike the frame
         above): the outline paints above the picture's own content on its
         own, and any lift would hoist the picture above overlays the page
         itself positioned over it, burying e.g. a carousel caption bar. */
    }
    @keyframes pdiffPing {
      0% { box-shadow: inset 0 0 0 2px ${color}, 0 0 0 3px ${color}, 0 0 0 0 rgba(${ringRgb}, 0.65); }
      70% { box-shadow: inset 0 0 0 2px ${color}, 0 0 0 3px ${color}, 0 0 0 14px rgba(${ringRgb}, 0); }
      100% { box-shadow: inset 0 0 0 2px ${color}, 0 0 0 3px ${color}, 0 0 0 0 rgba(${ringRgb}, 0); }
    }
    /* The picked change among many outlines: a thicker outer frame that no
       sibling outline can match, and a perpetual ping ring for motion. The
       SELECTED word that names it is the comparison's own chrome, drawn
       over the pane's frame rather than inside the page. Replaced elements
       (img, input) keep the frame, the ping, and the one-shot beacon. */
    .pdiff-selected {
      --pdiff-badge: ${color};
      position: relative;
      z-index: 999;
      box-shadow: inset 0 0 0 2px ${color}, 0 0 0 3px ${color} !important;
      animation: pdiffPing 1.4s ease-out infinite;
    }
    /* The selected frame on a picture: same inner outline as above (the
       inset half of the selected box-shadow is content-covered like any
       other), with the outer glow kept, which paints outside the box and
       shows on every element kind. */
    img.pdiff-selected {
      box-shadow: 0 0 0 3px ${color} !important;
      outline: 2px solid ${color} !important;
      outline-offset: -2px !important;
      /* Same no-lift rule as marked pictures: selecting a picture must not
         bury the page's own overlays above it. */
      z-index: auto !important;
    }
    /* The SELECTED word is NOT drawn here. It used to be a ::after on this
       element, then a wrapper span around replaced elements: both lived
       inside the snapshot, where the page's own ::after wins on
       specificity (settlement.org's carousel caption arrow), an ancestor's
       overflow or transform clips them, and a menu opened on top paints
       straight over them. The word is now the comparison's own chrome, in a
       layer over the pane's frame (see paneBadgeLayer in public/app.js), so
       the snapshot's DOM is never touched and nothing in it can hide the
       badge. Only the frame below is still drawn on the element itself. */
    /* One-shot beacon, added by the host on selection and removed after it
       plays: a bright flash that blooms outward once, so the picked change
       announces itself even when it was already in view. Runs on every
       element kind, including ones without ::after. */
    .pdiff-beacon {
      animation: pdiffPing 1.4s ease-out infinite, pdiffBeacon 1.15s ease-out 1 !important;
    }
    @keyframes pdiffBeacon {
      0% { filter: brightness(1.9) saturate(1.6); }
      100% { filter: brightness(1) saturate(1); }
    }
    body { max-width: 100%; }
  `;
  doc.head.appendChild(style);
}

// `meta.annotate` decides what this function is FOR. Left on (the default, and
// what /api/diff wants), it returns two rewritten documents for the compare
// view to put side by side: every changed node outlined in red or green, and
// the whole thing re-serialized out of the DOM.
//
// The documents arriving here have already been through prepareCapture(), so
// they are rendered-ready: scripts and Wayback chrome removed, marked
// script-capable, stamped with the pipeline version, and carrying exactly one
// <base>. What comes out is those documents plus diff markup and nothing
// else, which is what makes a capture look the same here as it does in the
// timelapse.
//
// Turned OFF, it returns only the numbers - counts and the per-tag breakdown -
// and skips all of that. That matters because of what it saves: re-serializing
// two archived documents is the most expensive thing this function does, and
// the record walk (server.js's /api/record-step) needs seven numbers per pair
// across hundreds of pairs. Paying for markup that is then discarded would
// more than double the cost of reading a site's whole history.
function diffSnapshots(oldHtml, newHtml, meta = {}) {
  const oldDom = new JSDOM(oldHtml);
  const newDom = new JSDOM(newHtml);
  const oldDoc = oldDom.window.document;
  const newDoc = newDom.window.document;

  stripScripts(oldDoc);
  stripScripts(newDoc);
  stripWaybackChrome(oldDoc);
  stripWaybackChrome(newDoc);
  markAsScriptCapable(oldDoc);
  markAsScriptCapable(newDoc);

  const oldLeaves = collectLeaves(oldDoc.body || oldDoc.documentElement);
  const newLeaves = collectLeaves(newDoc.body || newDoc.documentElement);
  // Each snapshot's URLs are resolved against its *own* base: the old link went
  // where the 2016 capture's base says it went, and the new one where the 2026
  // capture's says. One base for both would silently reinterpret the old page.
  const bases = { old: docBaseHref(oldDoc), new: docBaseHref(newDoc) };

  const segments = diffArrays(oldLeaves, newLeaves, {
    comparator: (a, b) => a.signature === b.signature,
  });

  const changes = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.added && !seg.removed) continue; // unchanged block, nothing to mark

    if (seg.removed && segments[i + 1] && segments[i + 1].added) {
      // A block of removed content immediately followed by added content:
      // treat matching-tag pairs as an edit ("changed") rather than an
      // unrelated deletion plus an unrelated insertion. We only pair
      // elements that share a tag name (a removed <img> should never be
      // treated as "changed into" an added <li> just because they landed
      // next to each other in the sequence diff).
      const removedLeaves = seg.value.slice();
      const addedLeaves = segments[i + 1].value.slice();
      const { pairs, removedOnly, addedOnly } = alignRuns(removedLeaves, addedLeaves);
      const pairedWith = new Map(pairs.map(([ri, ai]) => [ri, ai]));

      // Walked in the order of the earlier snapshot, so the change list reads
      // down the page rather than in whatever order the pairing produced.
      removedLeaves.forEach((oldLeaf, ri) => {
        const matchIdx = pairedWith.get(ri);
        if (matchIdx === undefined) {
          oldLeaf.el.setAttribute('data-pdiff-removed', 'true');
          changes.push({
            type: 'removed',
            tag: oldLeaf.el.tagName.toLowerCase(),
            before: oldLeaf.text,
            beforeTruncated: oldLeaf.textTruncated,
            oldId: oldLeaf.id,
            attrsBefore: oldLeaf.attrs,
            path: oldLeaf.path,
            // Working fields, for pairMoves at the end of this function. Removed
            // before anything is sent: one of them is a DOM node, which is not
            // JSON and must never reach a response.
            signature: oldLeaf.signature,
            node: oldLeaf.el,
          });
        } else {
          const newLeaf = addedLeaves[matchIdx];
          newLeaf.el.setAttribute('data-pdiff-changed', 'true');
          oldLeaf.el.setAttribute('data-pdiff-removed', 'true');
          const attrChanges = diffAttrs(oldLeaf.attrs, newLeaf.attrs, bases);
          changes.push({
            type: 'changed',
            tag: newLeaf.el.tagName.toLowerCase(),
            before: oldLeaf.text,
            after: newLeaf.text,
            beforeTruncated: oldLeaf.textTruncated,
            afterTruncated: newLeaf.textTruncated,
            textChanged: oldLeaf.text !== newLeaf.text,
            attrChanges,
            urlChanges: urlChangesFor(attrChanges, bases),
            // The full attribute snapshots, not only the differing ones. A
            // changed <img> whose file moved and whose alt text did not has an
            // empty attrChanges list, so the panel had nothing to say about it
            // but "changed <img>" and a bare arrow, the change a reader is
            // most likely to be looking at, described as nothing at all. The
            // unchanged alt text is what makes that row read as a picture; it
            // is here for the same reason the leaf's text is.
            attrsBefore: oldLeaf.attrs,
            attrsAfter: newLeaf.attrs,
            newId: newLeaf.id,
            oldId: oldLeaf.id,
            path: newLeaf.path || oldLeaf.path,
          });
        }
      });

      addedOnly.forEach((idx) => {
        const newLeaf = addedLeaves[idx];
        newLeaf.el.setAttribute('data-pdiff-added', 'true');
        changes.push({
          type: 'added',
          tag: newLeaf.el.tagName.toLowerCase(),
          after: newLeaf.text,
          afterTruncated: newLeaf.textTruncated,
          newId: newLeaf.id,
          attrsAfter: newLeaf.attrs,
          path: newLeaf.path,
          signature: newLeaf.signature,
          node: newLeaf.el,
        });
      });

      i++; // consume the paired "added" segment
      continue;
    }

    if (seg.removed) {
      seg.value.forEach((leaf) => {
        leaf.el.setAttribute('data-pdiff-removed', 'true');
        changes.push({
          type: 'removed',
          tag: leaf.el.tagName.toLowerCase(),
          before: leaf.text,
          beforeTruncated: leaf.textTruncated,
          oldId: leaf.id,
          attrsBefore: leaf.attrs,
          path: leaf.path,
          signature: leaf.signature,
          node: leaf.el,
        });
      });
    } else if (seg.added) {
      seg.value.forEach((leaf) => {
        leaf.el.setAttribute('data-pdiff-added', 'true');
        changes.push({
          type: 'added',
          tag: leaf.el.tagName.toLowerCase(),
          after: leaf.text,
          afterTruncated: leaf.textTruncated,
          newId: leaf.id,
          attrsAfter: leaf.attrs,
          path: leaf.path,
          signature: leaf.signature,
          node: leaf.el,
        });
      });
    }
  }  mergeFragmentRuns(changes);
  pairMoves(changes);

  // What each change's node knows about being *shown*: whether the page repeats
  // it, and which clipped slide of a carousel band it sits in. Read here from
  // the leaf notes rather than at each push site, so every kind of change  
  // paired, added, removed, moved, carries them without four copies of the
  // same three lines. Kept in the response (the reader needs them); see
  // annotateLeaves for why they exist.
  // Two maps, not one: leaf ids are numbered per document, so "pdiff-2" means
  // an element in each snapshot and a single map would silently answer with
  // whichever document was read last. (Measured: that turned a duplicated old
  // image into "not duplicated", which is the exact flag the fix is for.)
  const hintFor = (leaves) => {
    const map = new Map();
    leaves.forEach((leaf) => {
      if (!leaf.duplicate && !leaf.carousel) return;
      map.set(leaf.id, { duplicate: !!leaf.duplicate, carousel: leaf.carousel || null });
    });
    return map;
  };
  const hintsOld = hintFor(oldLeaves);
  const hintsNew = hintFor(newLeaves);

  // The working fields have done their job. A DOM node left in here would come
  // back to bite at JSON serialization, loudly and far from here.
  changes.forEach((c) => {
    const before = c.oldId ? hintsOld.get(c.oldId) : null;
    const after = c.newId ? hintsNew.get(c.newId) : null;
    c.duplicate = !!(before && before.duplicate) || !!(after && after.duplicate);
    const carousel = (after && after.carousel) || (before && before.carousel) || null;
    if (carousel) c.carousel = carousel;
    delete c.signature;
    delete c.node;
  });

  // Give every changed node a stable numeric order so the UI can jump to
  // "change #4" and have it mean the same thing in both panes.
  changes.forEach((c, idx) => (c.index = idx));

  const counts = {
    added: changes.filter((c) => c.type === 'added').length,
    removed: changes.filter((c) => c.type === 'removed').length,
    changed: changes.filter((c) => c.type === 'changed').length,
  };

  // The record walk never draws the change list, it only groups it: the tag
  // breakdown is what the dashboard's element chart is made of, and counting
  // here costs one pass over an array we already built.
  if (meta.annotate === false) {
    const tagCounts = {};
    changes.forEach((c) => { tagCounts[c.tag] = (tagCounts[c.tag] || 0) + 1; });
    return { counts, tagCounts };
  }

  injectDiffStyles(oldDoc, 'old');
  injectDiffStyles(newDoc, 'new');

  return {
    oldHtml: '<!DOCTYPE html>' + oldDoc.documentElement.outerHTML,
    newHtml: '<!DOCTYPE html>' + newDoc.documentElement.outerHTML,
    changes,
    counts,
  };
}

// A leaf that is still on the page, in a different place.
//
// The sequence diff matches leaves in document order, so anything that crossed a
// sibling falls out of it as two unrelated events, removed here, added there  
// with identical text at both ends. A nav item moved above its neighbour, a
// paragraph swapped with the one below it: the change list reports that the page
// lost a paragraph and gained a new one, which is the opposite of what happened.
//
// So the leftovers are paired by their signature, which is exactly the question
// "is this the same leaf": the same tag, the same text, the same destination. A
// pair becomes one entry that says the element is still there and has moved,
// marked on both panes, red where it was, green where it is, and counted once
// rather than twice.
function pairMoves(changes) {
  const addedBySignature = new Map();
  changes.forEach((c, i) => {
    if (c.type !== 'added' || !c.signature) return;
    const list = addedBySignature.get(c.signature) || [];
    list.push(i);
    addedBySignature.set(c.signature, list);
  });
  if (!addedBySignature.size) return;

  const consumed = new Set();
  changes.forEach((c, i) => {
    if (c.type !== 'removed' || !c.signature) return;
    const list = addedBySignature.get(c.signature);
    if (!list || !list.length) return;
    const ai = list.shift();
    const added = changes[ai];
    consumed.add(ai);
    consumed.add(i);
    // The node in the later snapshot is where the element is *now*: it gets the
    // changed outline, not the added one, because nothing was added.
    const newEl = added.node;
    if (newEl) {
      newEl.removeAttribute('data-pdiff-added');
      newEl.setAttribute('data-pdiff-changed', 'true');
    }
    changes[ai] = {
      type: 'changed',
      moved: true,
      tag: added.tag,
      before: c.before,
      after: added.after,
      beforeTruncated: c.beforeTruncated,
      afterTruncated: added.afterTruncated,
      textChanged: false,
      attrChanges: [],
      urlChanges: [],
      newId: added.newId,
      oldId: c.oldId,
      path: added.path,
      pathBefore: c.path,
    };
  });
  if (!consumed.size) return;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (i in changes && changes[i].type === 'removed' && consumed.has(i)) changes.splice(i, 1);
  }
}

// Inline formatting wrappers from the rainbow-text era: a heading whose every
// letter sits in its own <font> (or <b>, <i>, <span>…) reads to the leaf walk
// as twenty separate one-letter elements, so a removed heading comes back as
// twenty "removed <font>" rows with one letter each, and the pane outlines
// every letter on its own. A person would say the heading was removed, once.
// Runs of adjacent same-tag fragments are merged into the single change they
// are: one row, the joined words, and one outline around their shared parent.
const FRAGMENT_TAGS = new Set([
  'FONT', 'B', 'I', 'U', 'EM', 'STRONG', 'SPAN', 'SMALL', 'BIG',
  'SUB', 'SUP', 'S', 'STRIKE', 'TT',
  // Linked letters: an alphabet strip, a row of single-letter pagination
  // links, reads to the leaf walk as twenty-six one-letter elements, so a
  // removed line comes back as twenty-six "removed <a>" rows instead of the
  // one line a person would say went away. Merged like any other fragments.
  // Only removed/added runs merge, never changed pairs: one letter whose
  // destination genuinely moved is still exactly one change, and merging it
  // with its unchanged neighbours would hide which letter moved.
  'A',
]);
// Ids for parents promoted by mergeFragmentRuns below. Leaves already carry
// pdiff-N ids from collectLeaves; a promoted parent is not a leaf, so it
// gets its own series that can never collide with theirs.
let mergedParentCounter = 0;
const MAX_FRAGMENT_TEXT = 10;

function fragmentRunKey(change) {
  if (!change || !change.node || (change.type !== 'removed' && change.type !== 'added')) return null;
  const tag = (change.node.tagName || '').toUpperCase();
  if (!FRAGMENT_TAGS.has(tag)) return null;
  const text = change.type === 'removed' ? change.before : change.after;
  if ((text || '').length > MAX_FRAGMENT_TEXT) return null;
  return `${change.type}::${tag}`;
}

// The whitespace sitting between two fragment elements in the DOM, or null
// when something else (real text, a meaningful element) stands between them.
// Whitespace-only elements (a <font> holding nothing but the space between
// two words, which the leaf walk skips) count as spacing, not as content.
function gapBetween(prevNode, nextNode) {
  let gap = '';
  let node = prevNode.nextSibling;
  while (node && node !== nextNode) {
    if (node.nodeType === 3) {
      gap += node.nodeValue || '';
    } else if (node.nodeType === 1 && !normalizeText(node.textContent)) {
      gap += node.textContent || '';
    } else {
      return null;
    }
    node = node.nextSibling;
  }
  if (node !== nextNode) return null;
  if (/[^\s]/.test(gap)) return null;
  return gap.length ? ' ' : '';
}

function isBlankElement(node) {
  return node && node.nodeType === 1 && !normalizeText(node.textContent);
}

function mergeFragmentRuns(changes) {
  for (let i = 0; i < changes.length; i++) {
    const key = fragmentRunKey(changes[i]);
    if (!key) continue;
    const run = [i];
    let j = i + 1;
    while (j < changes.length && fragmentRunKey(changes[j]) === key) {
      const gap = gapBetween(changes[j - 1].node, changes[j].node);
      if (gap === null) break;
      changes[j].__gap = gap;
      run.push(j);
      j++;
    }
    if (run.length < 2) continue;
    // Every fragment must live under the same parent, and the parent must
    // hold nothing else: outlining it would otherwise swallow live content
    // into the removed box. Never the page itself.
    const parent = changes[i].node.parentElement;
    if (!parent || /^(BODY|HTML|HEAD)$/.test(parent.tagName)) {
      run.forEach((k) => delete changes[k].__gap);
      continue;
    }
    const inRun = new Set(run.map((k) => changes[k].node));
    const parentKids = Array.from(parent.children);
    if (!parentKids.length || !parentKids.every((kid) => inRun.has(kid) || isBlankElement(kid))) {
      run.forEach((k) => delete changes[k].__gap);
      continue;
    }
    const type = changes[i].type;
    const attr = type === 'removed' ? 'data-pdiff-removed' : 'data-pdiff-added';
    let text = '';
    let truncated = false;
    run.forEach((k, n) => {
      const c = changes[k];
      if (n > 0) text += c.__gap || '';
      text += type === 'removed' ? c.before : c.after;
      truncated = truncated || (type === 'removed' ? c.beforeTruncated : c.afterTruncated);
      c.node.removeAttribute(attr);
      delete c.__gap;
    });
    if (text.length > MAX_LEAF_TEXT) { text = text.slice(0, MAX_LEAF_TEXT); truncated = true; }
    parent.setAttribute(attr, 'true');
    // The outline now sits on the parent, so the parent is what both click
    // directions must resolve to: it gets its own id, and the merged change
    // points at it. The fragments' ids are left dangling on purpose, their
    // marks were removed above, so nothing looks them up. (Before this, the
    // merged change kept the first fragment's id: sidebar jumps landed on a
    // markless node, and clicking the parent outline resolved to nothing.)
    const mergedId = `pdiff-merged-${mergedParentCounter++}`;
    parent.setAttribute('data-pdiff-id', mergedId);
    const merged = {
      type,
      tag: parent.tagName.toLowerCase(),
      path: buildPathContext(parent),
      signature: null,
      node: parent,
    };
    if (type === 'removed') merged.oldId = mergedId;
    else merged.newId = mergedId;
    if (type === 'removed') {
      merged.before = text;
      merged.beforeTruncated = truncated;
      merged.attrsBefore = {};
    } else {
      merged.after = text;
      merged.afterTruncated = truncated;
      merged.attrsAfter = {};
    }
    changes.splice(i, run.length, merged);
  }
}

module.exports = { diffSnapshots };
