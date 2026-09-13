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

const LEAF_TAGS_WITH_NO_TEXT_OK = new Set(['IMG', 'IFRAME', 'VIDEO', 'AUDIO', 'HR', 'INPUT']);

// A leaf's visible text can be identical before and after while the leaf
// still legitimately counts as "changed" — a link whose label stayed the
// same but whose destination moved, an image whose src changed but whose
// alt text didn't. Text alone can't explain that to a person reading the
// changes list, so for these tags we also snapshot the attributes that
// actually carry meaning, and diff those separately.
const DISPLAY_ATTRS_BY_TAG = {
  A: ['href', 'title', 'target'],
  IMG: ['src', 'alt', 'title'],
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

// Compares two attribute snapshots and returns only the ones that differ,
// so a "changed" entry can say exactly which attribute moved and between
// what two values, instead of leaving a person to guess why something
// with identical text got flagged as changed at all.
function diffAttrs(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  keys.forEach((name) => {
    const b = before[name] ?? null;
    const a = after[name] ?? null;
    if (b !== a) out.push({ name, before: b, after: a });
  });
  return out;
}

// A single leaf's text is capped, generously, purely as a safety net
// against a pathological page dumping an entire article into one
// unstructured leaf and blowing up payload size — not as a "preview"
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
  const hasElementChildren = Array.from(el.children).length > 0;
  if (hasElementChildren) return false;
  if (LEAF_TAGS_WITH_NO_TEXT_OK.has(tag)) return true;
  return normalizeText(el.textContent).length > 0;
}

function collectLeaves(root) {
  const leaves = [];
  let counter = 0;

  function walk(node) {
    if (node.nodeType !== 1) return; // element nodes only
    if (isContentLeaf(node)) {
      const id = `pdiff-${counter++}`;
      node.setAttribute('data-pdiff-id', id);
      const fullText = normalizeText(node.textContent);
      leaves.push({
        id,
        el: node,
        signature: buildSignature(node),
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
  return leaves;
}

function buildSignature(el) {
  const tag = el.tagName;
  if (tag === 'IMG') return `IMG::${el.getAttribute('src') || ''}::${el.getAttribute('alt') || ''}`;
  if (tag === 'A') return `A::${el.getAttribute('href') || ''}::${normalizeText(el.textContent)}`;
  return `${tag}::${normalizeText(el.textContent)}`;
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

// We fetch the "id_" version of a snapshot, which gives us the raw,
// un-rewritten HTML (no Wayback toolbar injected). The tradeoff is that
// relative links inside that HTML, like href="/style.css" or a background
// image url(), have nothing to resolve against once the page is sitting in
// an iframe with no real address of its own. A <base> tag fixes this: it
// tells the browser "resolve every relative URL on this page as if it were
// fetched from here," and we point it at the same timestamped snapshot on
// web.archive.org, which does have those subresources archived under that
// path. That's what makes the page actually look like the original site,
// fonts, images, layout and all, instead of bare unstyled text.
function injectBaseHref(doc, url, timestamp) {
  if (!timestamp) return;
  const base = doc.createElement('base');
  base.setAttribute('href', `https://web.archive.org/web/${timestamp}/${url}`);
  if (doc.head.firstChild) {
    doc.head.insertBefore(base, doc.head.firstChild);
  } else {
    doc.head.appendChild(base);
  }
}

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
  const selector = variant === 'old' ? '[data-pdiff-removed]' : '[data-pdiff-added], [data-pdiff-changed]';
  const ringRgb = variant === 'old' ? '187,69,48' : '63,122,78';

  style.textContent = `
    ${selector} {
      outline: 2px solid ${color} !important;
      outline-offset: 1px;
      scroll-margin-top: 40px;
    }
    @keyframes pdiffPing {
      0% { box-shadow: 0 0 0 0 rgba(${ringRgb}, 0.6); }
      70% { box-shadow: 0 0 0 12px rgba(${ringRgb}, 0); }
      100% { box-shadow: 0 0 0 0 rgba(${ringRgb}, 0); }
    }
    .pdiff-selected {
      outline-width: 3px !important;
      position: relative;
      z-index: 999;
      animation: pdiffPing 1.4s ease-out infinite;
    }
    body { max-width: 100%; }
  `;
  doc.head.appendChild(style);
}

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
      const usedAdded = new Set();

      removedLeaves.forEach((oldLeaf) => {
        const matchIdx = addedLeaves.findIndex(
          (newLeaf, idx) => !usedAdded.has(idx) && newLeaf.el.tagName === oldLeaf.el.tagName
        );
        if (matchIdx === -1) {
          oldLeaf.el.setAttribute('data-pdiff-removed', 'true');
          changes.push({
            type: 'removed',
            tag: oldLeaf.el.tagName.toLowerCase(),
            before: oldLeaf.text,
            beforeTruncated: oldLeaf.textTruncated,
            oldId: oldLeaf.id,
            attrsBefore: oldLeaf.attrs,
            path: oldLeaf.path,
          });
        } else {
          usedAdded.add(matchIdx);
          const newLeaf = addedLeaves[matchIdx];
          newLeaf.el.setAttribute('data-pdiff-changed', 'true');
          oldLeaf.el.setAttribute('data-pdiff-removed', 'true');
          const attrChanges = diffAttrs(oldLeaf.attrs, newLeaf.attrs);
          changes.push({
            type: 'changed',
            tag: newLeaf.el.tagName.toLowerCase(),
            before: oldLeaf.text,
            after: newLeaf.text,
            beforeTruncated: oldLeaf.textTruncated,
            afterTruncated: newLeaf.textTruncated,
            textChanged: oldLeaf.text !== newLeaf.text,
            attrChanges,
            newId: newLeaf.id,
            oldId: oldLeaf.id,
            path: newLeaf.path || oldLeaf.path,
          });
        }
      });

      addedLeaves.forEach((newLeaf, idx) => {
        if (usedAdded.has(idx)) return;
        newLeaf.el.setAttribute('data-pdiff-added', 'true');
        changes.push({
          type: 'added',
          tag: newLeaf.el.tagName.toLowerCase(),
          after: newLeaf.text,
          afterTruncated: newLeaf.textTruncated,
          newId: newLeaf.id,
          attrsAfter: newLeaf.attrs,
          path: newLeaf.path,
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
        });
      });
    }
  }

  injectDiffStyles(oldDoc, 'old');
  injectDiffStyles(newDoc, 'new');
  injectBaseHref(oldDoc, meta.url, meta.tsFrom);
  injectBaseHref(newDoc, meta.url, meta.tsTo);

  // Give every changed node a stable numeric order so the UI can jump to
  // "change #4" and have it mean the same thing in both panes.
  changes.forEach((c, idx) => (c.index = idx));

  return {
    oldHtml: '<!DOCTYPE html>' + oldDoc.documentElement.outerHTML,
    newHtml: '<!DOCTYPE html>' + newDoc.documentElement.outerHTML,
    changes,
    counts: {
      added: changes.filter((c) => c.type === 'added').length,
      removed: changes.filter((c) => c.type === 'removed').length,
      changed: changes.filter((c) => c.type === 'changed').length,
    },
  };
}

module.exports = { diffSnapshots };
