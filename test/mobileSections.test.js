// test/mobileSections.test.js
//
// The front page's three bands below the opening screen were laid out for a
// window about a thousand pixels wide, and on a phone each of them was the wide
// layout squeezed rather than re-set. Three things broke, and each one has a
// rule here that keeps it from coming back:
//
//  - the three features set their captions a size larger than every other
//    caption on the sheet (clamp(12px, 3.4vw, 22px), 13.4px at 393), so three
//    blocks of small print stood in a page whose small print is 11px;
//  - the record line's specimen is inside the first half of the sentence and
//    is taller than the line it stands on, so it covered the second half. It
//    also sits two reveal wrappers deep, and those wrappers are inline-blocks:
//    a picture measured against an inline-block's own line box hangs outside
//    its paragraph, whatever its margins say;
//  - the film screen's two credits and its link were three absolutely
//    positioned pieces on one foot line. Three things fit on that line at a
//    desktop width and none of them do at a phone's.
//
// What is checked here is the shape of the fix, not the pixels: the caption is
// the sheet's caption, the picture is measured by its paragraph, and the foot
// of the screen is one row that becomes one column.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'theme.css'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function rule(source, selector) {
  const flat = source.replace(/,\s*\n\s*/g, ', ');
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  let found;
  const bodies = [];
  while ((found = pattern.exec(flat))) {
    const open = flat.indexOf('{', found.index);
    const close = flat.indexOf('}', open);
    bodies.push(flat.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' '));
  }
  assert.ok(bodies.length, `theme.css must still carry a \`${selector}\` rule`);
  return bodies.join(' ');
}

// Every block with this exact media query, joined: 900px is written twice.
function mediaBlock(source, query) {
  const marker = '@media ' + query;
  let seen = 0;
  let joined = '';
  let from = 0;
  let at;
  while ((at = source.indexOf(marker, from)) !== -1) {
    seen += 1;
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
    assert.ok(depth === 0, `unclosed \`@media ${query}\` block`);
    joined += source.slice(open + 1, i) + '\n';
    from = i + 1;
  }
  assert.ok(seen, `theme.css must still carry an \`@media ${query}\` block`);
  return joined;
}

const phone = mediaBlock(css, '(max-width: 900px)');
const record = mediaBlock(css, '(max-width: 720px)');

test('the three features wear the sheet\u2019s caption, not a larger one of their own', () => {
  assert.match(
    rule(phone, '.feature .caption'),
    /font-size: var\(--caption-size\)/,
    'small print in a section is the same size as small print anywhere else'
  );
  assert.match(rule(phone, '.feature .caption'), /line-height: var\(--caption-leading\)/, 'and the same leading');
  assert.doesNotMatch(
    rule(phone, '.feature .caption'),
    /clamp\(\s*12px/,
    'a caption set larger than the page\u2019s captions is the thing the reader saw'
  );
  // The heading takes the hierarchy the captions were carrying, so the section
  // still has a top and a bottom rather than three equal-sized blocks.
  assert.match(rule(phone, '.feature-title'), /font-size: clamp\(23px/, 'the heading has to stand above 11px small print');
  assert.match(rule(phone, '.feature-icon'), /margin-bottom/, 'the mark needs its own room under it');
});

test('the record line is two lines, with the picture inside the first one', () => {
  // The picture used to take a line of its own on a phone (it was top-aligned
  // to a line box it did not fit, and the arrival clipped its top). It is a
  // glyph in the sentence now: baseline aligned, sized off the type, and the
  // first line is held on one line so it cannot drop to a line between two.
  const spec = rule(record, '.specimen');
  assert.match(spec, /vertical-align: baseline/, 'the picture sits on the line, not above it');
  assert.match(spec, /width: 0\.94em/, 'its size is the sentence\u2019s, so the line grows with the type');
  assert.doesNotMatch(spec, /clamp\(60px, 15vw/, 'a window-sized thumbnail is what made it taller than the line');
  assert.doesNotMatch(spec, /display: block/, 'that is what hung it outside its own paragraph');
  assert.match(record, /\.record-line-1 \{ white-space: nowrap; \}/, 'the first line is one line by construction');
  assert.match(
    record,
    /font-size: min\(9vw, calc\(\(100vw - 54px\) \/ 10\.5\)\)/,
    'the display size is the one that leaves room for the words and the picture on one line'
  );
  // The reveal wraps every word in an inline-block and clips it to its line
  // box; the picture\u2019s wrappers are inline and unclipped, or its top is cut.
  assert.match(
    record,
    /\.record-line-1 \.rv-w:has\(\.specimen\) \{ clip-path: none; \}/,
    'the picture\u2019s wrapper must not clip a frame taller than the type'
  );
  assert.match(
    record,
    /\.record-line-1 \.rv-w:has\(\.specimen\),\s*\.record-line-1 \.rv-i:has\(\.specimen\) \{ display: inline; \}/,
    'the picture\u2019s reveal wrappers must be inline, or the paragraph cannot contain it'
  );
  // And the small print above the sentence is the sheet's, with a beat under it.
  assert.match(rule(record, '.record-caption'), /font-size: var\(--caption-size\)/);
  assert.match(rule(record, '.record-caption'), /margin-bottom: clamp\(18px/);
});

test('the film screen\u2019s foot is one row, and one column under it', () => {
  // One element with three cells, so the three pieces can be arranged instead
  // of each one being pinned to the same line independently.
  assert.match(html, /<div class="film-foot">/, 'the credits and the link have to be one row');
  const foot = html.slice(html.indexOf('class="film-foot"'), html.indexOf('</section>', html.indexOf('class="film-foot"')));
  assert.equal((foot.match(/class="film-corner film-corner-bl"/g) || []).length, 1, 'one credit at the left');
  assert.equal((foot.match(/class="film-corner film-corner-br"/g) || []).length, 1, 'one credit at the right');
  assert.match(foot, /class="film-cta-row"/, 'and the way out between them');

  const grid = rule(css, '.film-foot');
  assert.match(grid, /position: absolute/, 'on a wide window it is still the frame\u2019s own foot line');
  assert.match(grid, /grid-template-areas: 'left link right'/, 'three cells across, the link in the middle');
  assert.doesNotMatch(
    rule(css, '.film-corner'),
    /position: absolute/,
    'the credits are cells of that row now, not three pieces pinned to the same line'
  );

  const stacked = rule(record, '.film-foot');
  assert.match(stacked, /position: static/, 'on a phone the foot is in the flow, under the word');
  assert.match(
    stacked,
    /grid-template-areas: 'left' 'right' 'link'/,
    'three centred lines, the credits first and the link last'
  );
  assert.match(stacked, /justify-items: center/, 'centred in the frame');
  // Out of the flow, the word takes what is left and the foot sits under it, so
  // the circle and the credits can never meet at any phone height.
  assert.match(rule(record, '.film-word'), /flex: 1 1 auto/, 'the word takes the room the foot leaves');
  assert.match(rule(record, '.film-word'), /justify-content: center/, 'and centres itself in it');
});
