// test/headFill.test.js
//
// The bar at the top of the page is the page: the sheet, the grain on it, the
// room's veil over both, a panel of ink where a panel is, and a hole where the
// film is. theme.js writes WHERE each of those crosses the bar - --head-a and
// --head-b, as fractions of the bar's own height, and --head-layer, the ink for
// a panel or nothing at all for the film - and the stylesheet paints the
// surfaces at those stops.
//
// It has been wrong twice, in the same way: it was a state (paper, then ink, at
// a threshold), and then an average (how much of the bar was dark, mixed into
// one flat colour). A state is right at both ends and wrong for the whole
// crossing. An average is right on a bar the page darkens all at once and wrong
// wherever an edge crosses it: a section's edge arriving was painted as a grey
// bar lying on a black section for the fifty pixels of scroll the edge took to
// pass, and the film was hidden behind that average and then handed back in one
// go. Neither of those numbers exists here any more.
//
// These tests are what says so: a fill made of the page's surfaces, stopped at
// the page's own edges, and a film the bar gets out of the way of.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'theme.js'), 'utf8');

// A rule may stand at the top level or inside an @supports/@media block, so the
// selector is looked for after any run of whitespace at the start of a line -
// and a selector can appear twice (the head's fill is written once as a
// fallback and once inside @supports), so `holding` picks the one that matters.
function rule(source, selector, holding) {
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  const bodies = [];
  let found;
  while ((found = pattern.exec(source))) {
    // These rules hold no nested braces, so the first close brace ends them.
    const open = source.indexOf('{', found.index);
    const close = source.indexOf('}', open);
    bodies.push(source.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' '));
  }
  assert.ok(bodies.length, `the stylesheet must still carry a \`${selector}\` rule`);
  if (holding) {
    const want = bodies.filter((b) => b.includes(holding));
    assert.ok(want.length, `\`${selector}\` must still hold \`${holding}\``);
    return want[0];
  }
  return bodies[bodies.length - 1];
}

test('the bar is painted the page, at the page\'s own edges', () => {
  const nav = rule(css, '.site-nav', 'linear-gradient');
  assert.match(
    nav,
    /linear-gradient\(to bottom,\s*transparent 0 calc\(var\(--head-a, 1\) \* 100%\),\s*var\(--head-layer, transparent\)/,
    'the panel or the picture must be a band between --head-a and --head-b, and nothing outside it'
  );
  const before = rule(css, '.site-nav::before');
  assert.match(before, /background-color: var\(--paper\)/, 'the sheet itself has to be under everything');
  assert.match(
    before,
    /color-mix\(in srgb, var\(--ink\) calc\(var\(--head-ramp, 0\) \* 100%\), transparent\)/,
    "the room's veil is the page's own ramp, not a number of the bar's"
  );
  assert.match(before, /mask-image:/, 'the hole in the sheet is a mask, because an empty layer cannot open one');
  // A class may not set the bar: one threshold is the bug this replaced, twice.
  assert.doesNotMatch(
    css,
    /\.site-head\.(on-dark|film-under)\s+\.[a-z-]+\s*\{[^}]*background/,
    'a class may not set the bar'
  );
});

test('theme.js reads where the page is, and never how much of the bar is dark', () => {
  assert.match(js, /getPropertyValue\('--dark'\)/, "the room's own ramp is read, not restated");
  assert.match(js, /--head-a'/, 'where a boundary crosses the bar has to reach the stylesheet');
  assert.match(js, /--head-b'/, 'and where it ends again');
  assert.match(js, /--head-layer'/, 'and what it is made of');
  // The two ways of getting this wrong, both gone: an amount mixed into one
  // colour, and an opacity that hands the film back over the last of its cover.
  assert.doesNotMatch(js, /--head-ink'/, 'the amount of dark is not what is painted any more');
  assert.doesNotMatch(js, /--head-solid'/, 'nor is there a fade for the film to come back through');
  assert.doesNotMatch(
    js,
    /Math\.max\(\s*ink\s*,\s*over \/ tall\s*\)/,
    'the fill may not be an average of what is behind the bar'
  );
  // The film is a hole and a panel is ink, and there is no third answer.
  assert.match(js, /var\(--ink\)' : 'transparent'/, 'a panel paints ink and the picture paints nothing');
});

test('every dark surface the bar can stand on is the ink it is painted', () => {
  const band = rule(css, '.film-band', 'background');
  assert.match(
    band,
    /background: var\(--ink\)/,
    'the film band must be the same ink as the fill, or the bar seams along its top'
  );
  assert.doesNotMatch(
    band,
    /background: #[0-9a-f]{3,8}/i,
    'a dark surface may not carry its own black: #1b1714 next to #17120e is that seam'
  );
  assert.match(
    rule(css, '.stage-pin::after'),
    /background: var\(--ink\)/,
    "the room's veil and the bar's dark end are one colour"
  );
});

test('the sheet the bar lays down is the sheet the page has', () => {
  // The page's sheet is paper AND grain, and the head wears both: the paper as
  // its sheet layer, the grain as its own element at the same 3.5% the
  // paper-frame lays over the page. A bar painted the paper alone is ten levels
  // lighter than the page under it.
  assert.match(
    rule(css, '.paper-frame::after'),
    /background-image: var\(--sheet-grain\)/,
    'the page lays the grain as a background layer'
  );
  const after = rule(css, '.site-nav::after');
  assert.match(after, /background-image: var\(--sheet-grain\)/, 'and so does the bar');
  assert.match(after, /opacity: 0\.035/, 'at the same strength, because an opacity is what sets it');
  assert.match(after, /mask-image:/, 'and absent wherever the bar is not the sheet');
});

test('the labels hand over once, and never sit on the bar they are on', () => {
  const navText = rule(css, '.nav-text');
  assert.match(navText, /var\(--head-grey, 0\)/, 'the label grey follows the bar down');
  assert.match(navText, /var\(--head-label, 0\)/, 'and hands over to the light pair at the crossing');
  assert.match(js, /--head-label'/);
  assert.match(js, /--head-grey'/);
  // The one thing the labels may not be is a mix of the fill's own number: a
  // colour on its way from paper to ink passes through the bar it stands on.
  assert.doesNotMatch(
    navText,
    /color: color-mix\(in srgb, var\(--paper\)[^;]*var\(--head-(a|ramp|layer)/,
    "the labels must not be mixed by the fill's own numbers"
  );
  // And they answer to the row they stand in, not to the bar: a panel passing
  // under the head colours them when it reaches THEM.
  assert.match(js, /rowDark/, 'what is behind the label row is what colours the labels');
});
