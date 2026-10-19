// test/heroFrame.test.js
//
// The opening screen's two written columns are fenced by four corner brackets,
// and the brackets are drawn on the frame's own edges. On a wide window the
// frame gives the copy its clearance sideways (2.2% of the frame) because the
// film stands in the middle of the row and the two columns are at its ends.
//
// In one column there is no film between them and the four paragraphs are the
// whole of the block, so the clearance has to be all four sides - and it used
// to be sideways only. The first line then began ten pixels under the top edge
// and seven inside the left one, inside the corner mark's own twenty-pixel arm:
// the mark the eye reads as the fence was standing in the type it fences, and
// the block was ten pixels tight at the top and thirty-seven loose at the
// bottom, which is not a centred block however centred its box is.
//
// So: on one column the frame takes a real inset on all four sides, larger than
// the mark's own arm at the top; the two margins that arrange the columns
// around the film are dropped, because there is no film between them here; and
// the four paragraphs are spaced by one gap rather than by two nearly equal
// ones, so the block reads as one run of four and not as a stack with a seam.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.css'), 'utf8');

// Every body written for this selector, joined. A selector list may be broken
// across lines (`.hero-col-left,\n.hero-col-right { ... }`), and the same
// selector can be written twice - a base rule and the one-column override - so
// the source is flattened first and all of its bodies are read.
function rule(source, selector) {
  const flat = source.replace(/,\s*\n\s*/g, ', ');
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  let found;
  let bodies = [];
  while ((found = pattern.exec(flat))) {
    const open = flat.indexOf('{', found.index);
    const close = flat.indexOf('}', open);
    bodies.push(flat.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' '));
  }
  assert.ok(bodies.length, `theme.css must still carry a \`${selector}\` rule`);
  return bodies.join(' ');
}

// Every @media block with this query, joined: the same width is written more
// than once in this stylesheet (the stage's arrival and the stage's single
// column both stop at 900px), and a rule can stand in either.
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

const oneColumn = mediaBlock(css, '(max-width: 900px)');
const frame = rule(oneColumn, '.stage-cols');
const inset = frame.match(/padding:\s*([^;]+);/);
// The mark's own arm: the pair of rules that give the four corners their
// size, taken off the stylesheet rather than restated here.
const mark = css.match(/\.bracketed::before,\s*\.bracketed::after\s*\{[^}]*?height:\s*(\d+(?:\.\d+)?)px/);
assert.ok(mark, 'the corner mark has to still be a square of a known size');
const arm = Number(mark[1]);

test('the corner marks fence the copy instead of standing in it', () => {
  assert.ok(inset, 'the one-column frame has to give the copy an inset of its own');
  const sides = inset[1].split(/\s+(?![^(]*\))/).map((s) => s.trim());
  // Three values, not four: the second is BOTH sides, so the left and right
  // insets are the same measure by construction - which is what makes the
  // block sit centred in the sheet however wide the sheet is.
  assert.equal(sides.length, 3, 'a top, a pair of sides and a bottom: not the wide layout\u2019s sideways-only padding');
  const top = sides[0].match(/clamp\(\s*(\d+(?:\.\d+)?)px/);
  assert.ok(top, 'the top inset is a measure, not a yes');
  assert.ok(
    Number(top[1]) > arm,
    `the first line has to clear the corner mark's own ${arm}px arm, or the mark runs down the side of the sentence`
  );
});

test('the block has one rhythm in one column', () => {
  const rowGap = frame.match(/gap:\s*([^;]+);/);
  const colGap = rule(oneColumn, '.hero-col-left, .hero-col-right').match(/gap:\s*([^;]+);/);
  assert.ok(rowGap && colGap, 'both the frame and the columns inside it have to say the gap');
  assert.equal(
    colGap[1].trim(),
    rowGap[1].trim(),
    'two nearly equal gaps read as a seam in a stack; the four paragraphs are one run of four'
  );
});

test('the margins that arrange the pair around the film are gone in one column', () => {
  assert.match(
    rule(oneColumn, '.stage-cols > .hero-col-left'),
    /margin-top: 0/,
    'the left column stood under the top bracket because the film was beside it'
  );
  assert.match(
    rule(oneColumn, '.stage-cols > .hero-col-right'),
    /margin-bottom: 0/,
    'and the right one stood off the bottom, which left the frame heavier below than above'
  );
});
