// test/compareLanding.test.js
//
// The compare page's card is centered in the first screen, and that screen is
// "the window minus the head, the footer and the main's padding". That is a
// subtraction the layout can make for itself - the paper frame is already a
// flex column one screen tall, so the hero only has to take what is left.
//
// It has twice been written as a number instead (`calc(100svh - 180px)`), and
// twice that number has been wrong: the head's own type scale moves with the
// window, so the real chrome is 174px at one size and 195px at another. A
// number that is a little too small leaves the first frame 15px taller than
// the window - a scrollbar appears - and then the correction lands, the
// scrollbar goes, and the centered card jumps a few pixels up. What the reader
// sees is the page assembling itself wrong and then fixing itself.
//
// These are the two shapes of that regression: a viewport constant standing in
// for a layout subtraction, and a second script writing the same height again
// from somewhere else.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'compare.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'theme.js'), 'utf8');

// The declarations of one rule, with its comments removed.
function rule(source, selector) {
  const at = source.indexOf('\n' + selector + ' {');
  assert.notEqual(at, -1, `the stylesheet must still carry a \`${selector}\` rule`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

test('the compare hero takes its first-screen height from the layout', () => {
  const decls = rule(css, '.compare-page .page-main .page-hero');
  assert.ok(
    decls.includes('flex: 1 0 auto'),
    'the hero must fill what the flex column has left after the head and footer'
  );
});

test('no guessed viewport height stands in for that subtraction', () => {
  const decls = rule(css, '.compare-page .page-main .page-hero');
  const guess = decls.find((d) => /^(min-)?height:.*(svh|vh|dvh|lvh)/.test(d));
  assert.equal(
    guess,
    undefined,
    `the hero must not hold a viewport constant (found \`${guess}\`): the head, ` +
      'footer and padding heights are not a constant, and a first frame laid out ' +
      'from one is a scrollbar plus a card jump'
  );
});

test('the page does not size the hero a second time before its scripts run', () => {
  // An inline script that writes the height before theme.js runs is a second
  // owner: two places computing the same number is how they drift apart.
  const inline = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const writing = inline.find((s) => /\.style\.minHeight\s*=/.test(s));
  assert.equal(writing, undefined, 'the hero height has one owner, and it is theme.js');
  assert.ok(
    /<link[^>]+theme\.css/.test(html),
    'the compare page must load the stylesheet that places the hero'
  );
});

test('theme.js pins the height the layout produced, not a viewport guess of its own', () => {
  // The freeze has to happen only once the hero's height exists, and it must be
  // the height the column gave it: window height minus what was measured above
  // and below it. Nothing here may introduce a constant of its own.
  assert.ok(
    /window\.innerHeight\s*-\s*chrome/.test(js),
    'the pinned height is the window minus the measured head, footer and padding'
  );
  assert.ok(
    /cmpHero\.style\.flex\s*=\s*'0 0 auto'/.test(js),
    'a pinned hero must not grow into free space below it either'
  );
});
