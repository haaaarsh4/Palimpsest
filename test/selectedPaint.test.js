// test/selectedPaint.test.js
//
// The two things a pick paints, and where each of them lives:
//
//  - the frame, written on the element itself as an inline outline, because a
//    page is free to style its own ::after and box-shadow on the same element
//    and archived sites do exactly that (settlement.org's carousel caption
//    arrow is a `content: url(...)` on `h3 a::after`, which outranked the
//    stylesheet badge). An inline rule cannot be outranked;
//  - the word "SELECTED", drawn in a layer the comparison owns, over the
//    pane's frame, and never inside the snapshot. Every earlier version lived
//    in the page - a ::after, then a wrapper span around replaced elements,
//    then a fixed overlay on the snapshot's root - and each was at the mercy
//    of a stylesheet nobody here wrote ("I cannot even see the selected
//    text", with a menu opened on top of the word) while two of them added an
//    element to a document the Archive recorded.
//
// What is checked is the shape of that split, not the pixels: the browser
// behaviour is covered by scripts/check-compare-clicks.js, which walks a real
// comparison in a real browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'diffEngine.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'compare.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const selection = fs.readFileSync(path.join(__dirname, '..', 'public', 'selection.js'), 'utf8');

// The body of a named function, by brace matching from its opening line.
function fn(source, name) {
  const at = source.indexOf('function ' + name + '(');
  assert.ok(at !== -1, `public/app.js must still define ${name}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `unclosed ${name}`);
  return source.slice(open + 1, i);
}

const paint = fn(app, 'paintSelected');
const unpaint = fn(app, 'unpaintSelected');
const highlight = fn(app, 'highlightInPane');
const unhighlight = fn(app, 'unhighlightInPane');
const layer = fn(app, 'paneBadgeLayer');
const place = fn(app, 'placeSelectedBadges');

test('a selection inserts nothing into the snapshot', () => {
  // The owner's rule, in their words: nothing may be added to a snapshot that
  // was not in the capture. The badge used to be a ::after on the element and
  // a wrapper span around replaced elements; both are gone, and no path from
  // a click puts an element into the pane's document.
  assert.doesNotMatch(app, /wrapForBadge|unwrapBadge|needsBadgeWrap/, 'the wrapper is gone from the host');
  assert.doesNotMatch(selection, /wrapForBadge|unwrapBadge|needsBadgeWrap/, 'and from the helpers');
  assert.doesNotMatch(paint, /\.appendChild\((word|doc\.documentElement|target)\)/, 'nothing is appended inside the page');
  assert.doesNotMatch(paint, /createElement[\s\S]{0,120}(doc|target)\.appendChild/, 'and nothing is inserted into the document');
  assert.doesNotMatch(engine, /\.pdiff-selected::after/, 'the stylesheet badge is gone');
  assert.doesNotMatch(engine, /\.pdiff-selected-badge/, 'and so is the CSS the wrapper needed');
  assert.doesNotMatch(engine, /colonbefore|pdiffBadgePop/, 'no badge animation is left behind in the snapshot either');
});

test('the word is drawn in the comparison\u2019s own layer, over the frame', () => {
  assert.match(paint, /paneBadgeLayer\(iframe\)/, 'the layer is the pane\u2019s, not the page\u2019s');
  assert.match(layer, /iframe\.parentElement/, 'a sibling of the iframe, in the host document');
  assert.match(layer, /className = 'pane-badges'/, 'with one layer per pane');
  assert.match(paint, /badge\.className = 'pane-badge'/, 'the word wears the comparison\u2019s own class');
  assert.match(paint, /textContent = '\\u25cf  SELECTED'/, 'and says what it is for');
  assert.match(paint, /layer\.appendChild\(badge\)/, 'appended to the layer, so the snapshot is untouched');
  // The layer has to exist in the host page for either pane, and for the
  // full-screen frame, and it may never take a click.
  assert.equal((html.match(/class="pane-badges"/g) || []).length, 3, 'a layer over each frame, including full screen');
  assert.match(css, /\.pane-badges \{[\s\S]*?position: absolute/);
  assert.match(css, /\.pane-badges \{[\s\S]*?pointer-events: none/);
  assert.match(css, /\.pane-badges \{[\s\S]*?overflow: hidden/, 'clipped at the frame\u2019s own edges');
  assert.match(css, /\.pane-badge \{[\s\S]*?background: var\(--pdiff-badge/, 'in the pane\u2019s own colour');
  // A page may have hoisted anything it likes; the badge is above the iframe
  // by order and by layer, so no site rule can reach it at all.
  assert.doesNotMatch(paint, /pdiff-selected-word/, 'the old in-document word is gone');
});

test('the word sits above the box, at the pane\u2019s own coordinates', () => {
  // Inside the frame the two are different coordinate systems, so the element's
  // box is translated through the frame's offset; a badge placed at the raw
  // rect would sit a pane\u2019s width to the left of its element.
  assert.match(paint, /fr\.left - lr\.left/, 'the frame\u2019s offset inside the layer is read');
  assert.match(paint, /fr\.top - lr\.top/);
  assert.match(paint, /const paneTop = dy \+ r\.top;/, 'and the box measured against the frame');
  assert.match(paint, /if \(paneTop < 18\)/, 'with the word going just inside the top edge when there is no room above');
  assert.match(paint, /badge\.style\.transform = 'translateY\(-100%\)'/, 'otherwise above the box, overlapping its top edge');
});

test('the word follows the element it names', () => {
  assert.match(paint, /win\.addEventListener\('scroll', place/, 'the pane scrolling moves the element, so the word is re-placed');
  assert.match(paint, /win\.addEventListener\('resize', place/, 'and so does a pane resize');
  assert.match(place, /paint\.place\(\)/, 'the watch loop re-places it as the page\u2019s own layout settles');
  assert.match(fn(app, 'verifySelectionScrolls'), /placeSelectedBadges\(\)/, 'the aim pass calls it on every poll');
  assert.match(unpaint, /removeEventListener\('scroll', paint\.place/, 'and a deselect takes the listeners off');
});

test('the frame is inline, and put back exactly as it was', () => {
  assert.match(paint, /setProperty\('outline', '2px solid '/, 'an inline frame no page rule can outrank');
  assert.match(paint, /setProperty\('outline-offset', '-2px'/);
  const saved = paint.slice(paint.indexOf('const saved'), paint.indexOf('let badge'));
  assert.match(saved, /getPropertyValue\('outline'\)/, 'what the element had before is remembered');
  assert.match(saved, /hasAttribute\('style'\)/, 'including whether it had a style attribute at all');
  assert.doesNotMatch(paint, /setProperty\('position'/, 'the frame needs no positioning of its own');
  assert.match(unpaint, /removeChild\(paint\.badge\)/, 'the word comes off on deselect');
  assert.match(unpaint, /removeProperty\('outline'\)/, 'and the frame is restored');
  assert.match(unpaint, /removeProperty\('outline-offset'\)/);
  assert.match(unpaint, /removeAttribute\('style'\)/, 'with no empty style="" left behind on an element that had none');
});

test('selecting paints, deselecting unpaints, and a new document gets no stale word', () => {
  assert.match(highlight, /paintSelected\(target\)/, 'the pick is painted');
  assert.match(unhighlight, /unpaintSelected\(target\)/, 'and taken back off');
  assert.match(highlight, /pdiff-beacon/, 'the one-shot flash still runs');
  assert.match(unhighlight, /classList\.remove\('pdiff-selected'\)/, 'the class frame comes off too');
  // A pane that navigates paints a new document: the badge of the pick that
  // was made before the navigation belongs to the page that went away.
  assert.match(fn(app, 'clearPaneBadges'), /layer\.textContent = ''/, 'the layer is emptied');
  assert.match(app, /clearPaneBadges\(el\('paneOld'\)\)/, 'on a pane navigation');
  assert.match(app, /clearPaneBadges\(el\('paneNew'\)\)/);
  assert.match(app, /clearPaneBadges\(el\('modalFrame'\)\)/, 'and on the full-screen frame');
});

test('a picked slide is slid into the band, and the picture itself is what is lit', () => {
  // The owner's bug: picking settlement.org's "How do I get married?" picture
  // put the SELECTED frame around the whole Daily Life carousel - a dozen
  // slides as one unit - with the picked picture still parked off the band.
  // A change on a slide is brought into the carousel's window first, so the
  // target is the image that changed; the move is owned and undone like every
  // other reveal.
  const pick = fn(app, 'revealCarouselSlide');
  assert.match(pick, /node\.closest\('\.pal-track'\)/, 'only a change that lives on a slide is moved');
  assert.match(pick, /isDisplayedInPane\(node\)\) return null/, 'a slide already in the window stays where the reader found it');
  assert.match(pick, /PdiffSelection\.moveCarouselToNode\(node, \{ instant: true \}\)/,
    'the page\u2019s own band arithmetic moves the slide, instantly so its box is final');
  assert.match(pick, /activeReveals\.push\(receipt\)/, 'the move is owned by the selection, so deselecting restores the band');
  const openMenus = fn(app, 'openMenusForSelection');
  assert.match(openMenus, /revealCarouselSlide\(el\('paneOld'\), c, 'old'\)/);
  assert.match(openMenus, /revealCarouselSlide\(el\('paneNew'\), c, 'new'\)/);
  assert.match(fn(app, 'selectInPane'), /revealCarouselSlide\(iframe, change, side\)/,
    'and a pick made inside a pane moves the band too');
  // The marked node is the target once the band has moved: no ancestor
  // container is ever lit in place of it.
  const target = fn(app, 'scrollTargetFor');
  assert.match(target, /if \(direct && isDisplayedInPane\(direct\)\) return settle\(direct\);/, 'the image itself is the target');
  // Instant moves are the measurement contract; the month strip keeps its glide.
  assert.match(app, /moveCarouselToNode\(node, \{ instant: true \}\)/);
});
