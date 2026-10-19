// test/panePaint.test.js
//
// The white screen a cold comparison used to show: the pane's veil came down
// while /api/diff was still fetching, because a paint check started on the
// initial about:blank frame ran out its timeout and hid the veil over two empty
// frames. The captures arrived seconds later under a spinner that was already
// gone. These tests pin the two halves of the fix:
//
//  - a paint check belongs to the render it started for, and a new comparison
//    disarms every pending check before showing its veils;
//  - a check that never found a usable document may not lift the veil, while a
//    usable (if incomplete) document still does, so a broken picture cannot
//    leave the spinner up forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function fn(source, name) {
  const at = source.indexOf('function ' + name + '(');
  assert.ok(at !== -1, `the source must still define ${name}`);
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

const reveal = fn(app, 'revealPaneWhenPainted');
const painted = fn(app, 'panePainted');
const render = fn(app, 'render');
const invalidate = fn(app, 'invalidatePaneReveals');
const paint = fn(app, 'panePainted');

test('a paint check from an older document never lifts the veil', () => {
  assert.match(reveal, /const seq = paneRevealSeq\(iframe\);/, 'the check records which render it belongs to');
  assert.match(reveal, /if \(iframe\.__pdiffVeilArmed === false\) return;/, 'and is refused while a comparison is still fetching');
  assert.match(reveal, /if \(paneRevealSeq\(iframe\) !== seq\) return;/, 'and refused once a newer render owns the veil');
  assert.match(reveal, /paneRevealSeq\(iframe\) === seq/, 'the hide itself re-checks, not only the promise');
});

test('the veil comes down after the capture has had a frame to paint', () => {
  assert.match(reveal, /requestAnimationFrame\(\(\) => requestAnimationFrame\(once\)\)/,
    'two frames separate hiding the veil from painting the page');
  assert.match(reveal, /setTimeout\(once, 350\)/, 'a background tab still releases it');
});

test('a new comparison disarms every pending paint check', () => {
  assert.match(invalidate, /bumpPaneReveal\(iframe\)/, 'a fresh generation');
  assert.match(invalidate, /iframe\.__pdiffVeilArmed = false;/, 'and no pending check may hide the new veil');
  // Both entry points (the timeline comparison and COMPARE OPEN PAGES) put
  // the invalidation immediately before their veils. Matched on the source as
  // a whole because their signatures carry a defaulted options object, which
  // the brace walker above would mistake for the body.
  const ordered = app.match(/invalidatePaneReveals\(\);\s*showPaneLoading\('paneOldLoading'\)/g) || [];
  assert.ok(ordered.length >= 2, 'both comparison entry points invalidate before showing their veils');
});

test('a render arms its own veil and its own timeout', () => {
  assert.match(render, /const mySeq = bumpPaneReveal\(iframe\);/, 'the render owns a new generation');
  assert.match(render, /armPaneReveal\(iframe\);/, 'and arms it for the paint check');
  assert.match(render, /if \(paneRevealSeq\(iframe\) !== mySeq\) return;/, 'an old 60s backstop cannot hide a newer veil');
});

test('no document keeps the veil; a usable one may show incomplete', () => {
  assert.match(painted, /if \(!paneDocumentUsable\(doc\)\) \{[\s\S]*?return resolve\(false\);/, 'a frame with no document has nothing to reveal');
  assert.doesNotMatch(painted, /if \(!styled \|\| !drawn \|\| !fonts\) \{\n\s+if \(expired\(\)\) return resolve\(false\);/,
    'a usable document does not stay hidden forever behind a slow picture');
  assert.match(painted, /if \(expired\(\)\) return resolve\(true\);/,
    'it is shown, and the repair pass keeps working on what is missing');
  assert.match(paint, /settleBrokenPictures\(doc, win\)/, 'broken pictures are still repaired after the decision');
  assert.match(paint, /Promise\.resolve\(\)\s*\.then\(\(\) => settleBrokenPictures/, 'but the repair never gates the first paint');
  assert.match(app, /PANE_FIRST_PAINT_MS = 2500/, 'a slow picture or font gets a short grace, not the whole settle budget');
});
