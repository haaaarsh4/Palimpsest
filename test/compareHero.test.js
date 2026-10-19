// test/compareHero.test.js
//
// The compare page's card is centered in what is left of the first screen once
// the head and the fine print have taken theirs. That is the whole of the
// arithmetic, and it has one rule that is not obvious from the markup: the fine
// print has to be IN THE DOCUMENT before the card is.
//
// It was not, and that was the bug. The foot sat at the end of a document two
// hundred lines long, behind the whole timeline and workspace, so the browser
// painted the first screenful as soon as the card existed - no foot yet - and
// centered the card in a screen with no fine print in it: 39px too low, stepping
// up out of it when the foot finally arrived. It happened on navigation and not
// on every load, because it was a race between the parser and the first paint.
//
// So the foot is written before the page it closes, and the sheet puts it back
// under the page with flex order. These tests are that arrangement, kept.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const sheet = fs.readFileSync(path.join(root, 'compare.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');

function rule(selector) {
  const pattern = new RegExp(
    '(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}'
  );
  const found = css.match(pattern);
  assert.ok(found, `the stylesheet must still carry a \`${selector}\` rule`);
  return found[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
}

test('the fine print is in the document before the page it closes', () => {
  const foot = sheet.indexOf('<footer class="site-footer"');
  const main = sheet.indexOf('<main class="page-main');
  assert.ok(foot !== -1, 'the compare page keeps its fine print');
  assert.ok(main !== -1, 'and its page');
  assert.ok(
    foot < main,
    'the foot must be parsed before the card, or the card is centered in a screen with no foot in it and steps up when it arrives'
  );
  assert.equal(
    sheet.split('class="site-footer"').length - 1,
    1,
    'one foot, not a copy of it kept above the page'
  );
});

test('the sheet puts the fine print back under the page', () => {
  assert.match(rule('.paper-frame > .site-head'), /order: 0/, 'the head is first on screen');
  assert.match(rule('.paper-frame > .page-main'), /order: 1/, 'the page is second');
  assert.match(rule('.paper-frame > .site-footer'), /order: 2/, 'and the fine print is still last');
});

test('the card is centered in what is left, never at a height written down', () => {
  // The one thing that must not come back: a guessed first-screen height in the
  // document. It is a guess before the head and the foot have been measured, so
  // a guess that is off by anything at all is a scrollbar and a card that moves.
  assert.doesNotMatch(
    css,
    /\.compare-page[^{]*\{[^}]*height:\s*calc\(100svh\s*-/,
    'the compare view may not subtract a number from the screen'
  );
  assert.match(
    rule('.compare-page .page-main .page-hero'),
    /flex: 1 0 auto/,
    'the hero takes the rest of the screen, which is the head and the foot subtracted by the layout itself'
  );
});
