// test/navMenu.test.js
//
// The four sections and the wordmark hold one row down to about 660px. Below
// that they used to wrap onto a second line - and at 320px they did not even do
// that, because four labels are wider than the row - so on a narrow window the
// bar is the name and a button, and the same four links are a panel under it.
//
// Two things about that are easy to lose and are what these tests are for:
//
//  - the panel is the row. Not a copy of it, not a second list built beside it:
//    the same four anchors, so the page a reader is on and the address the
//    script carries into each link (theme.js) are written once.
//  - the button only exists on a page that has the script to open it, and the
//    page does not paint the four labels first and replace them a frame later.
//    That is the inline class in the head, and it is why the no-script page is
//    still the page it always was.
//
// The breakpoint is one number in two places - a media query in the stylesheet
// and a wider-than query in the script that shuts the panel again - so the last
// test is the one that keeps them from drifting apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const PAGES = ['index.html', 'compare.html', 'claims.html', 'settlement.html', 'sustainability.html'];
const SECTIONS = ['/compare', '/claims', '/settlement', '/sustainability'];

const css = fs.readFileSync(path.join(pub, 'theme.css'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'theme.js'), 'utf8');

// A rule's body, whitespace flattened, with comments removed. The last match
// wins, so a base rule and a media-query override of the same selector both
// read the way the browser resolves them in source order.
function rule(source, selector) {
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  let found;
  let body = null;
  while ((found = pattern.exec(source))) {
    const open = source.indexOf('{', found.index);
    const close = source.indexOf('}', open);
    body = source.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  }
  assert.ok(body !== null, `theme.css must still carry a \`${selector}\` rule`);
  return body;
}

// The inside of one @media block, by brace matching, so an assertion can be
// about the narrow window's rules rather than about the file.
function mediaBlock(source, query) {
  const at = source.indexOf('@media ' + query);
  assert.ok(at !== -1, `theme.css must still carry an \`@media ${query}\` block`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed \`@media ${query}\` block`);
}

const narrow = mediaBlock(css, '(max-width: 760px)');

for (const file of PAGES) {
  const html = fs.readFileSync(path.join(pub, file), 'utf8');
  const buttons = html.match(/<button class="nav-toggle"[^>]*>/g) || [];
  const rows = html.match(/<div class="nav-links"[^>]*>/g) || [];

  test(`${file}: one button, and it opens the row of four`, () => {
    assert.equal(buttons.length, 1, 'a page has one head, so it has one button');
    const button = buttons[0];
    assert.match(button, /type="button"/, 'a button, not a link and not a control that submits the hero form');
    assert.match(button, /aria-expanded="false"/, 'it starts shut, and it says so before it is pressed');
    const controls = button.match(/aria-controls="([^"]+)"/);
    assert.ok(controls, 'the button has to name the thing it opens');
    assert.equal(rows.length, 1, 'one row of sections, not a row and a menu beside it');
    const id = rows[0].match(/id="([^"]+)"/);
    assert.ok(id, 'the row needs an id for the button to name');
    assert.equal(id[1], controls[1], 'aria-controls must point at the row itself');
  });

  test(`${file}: the panel is the same four sections, in the same order`, () => {
    const from = html.indexOf(rows[0]);
    const body = html.slice(from, html.indexOf('</div>', from));
    const links = body.match(/<a class="nav-link[^"]*" href="([^"]+)"/g) || [];
    assert.equal(links.length, 4, 'four destinations, the wordmark being the way home');
    assert.deepEqual(
      links.map((a) => a.match(/href="([^"]+)"/)[1]),
      SECTIONS,
      'the narrow panel must reach the same four pages, in the same order'
    );
    assert.ok(
      html.indexOf('class="nav-toggle"') < html.indexOf(rows[0]),
      'the keyboard must meet the button before the four things it opens'
    );
  });

  test(`${file}: the bar is collapsed before the first paint, never after it`, () => {
    const flag = html.indexOf("classList.add('nav-js')");
    const sheet = html.indexOf('href="/theme.css');
    assert.ok(flag !== -1, 'the page has to say the menu can open');
    assert.ok(sheet !== -1 && flag < sheet, 'and say it in the head, before the stylesheet the browser paints with');
  });
}

test('the button is not in the bar until a narrow stylesheet asks for it', () => {
  assert.match(rule(css, '.nav-toggle'), /display: none/, 'a wide window has no button, and nothing to tab to');
  assert.match(narrow, /html\.nav-js \.nav-toggle \{ display: inline-flex; \}/, 'only a page with the script, and only under 760px');
  assert.doesNotMatch(
    narrow,
    /(?:^|\n)[ \t]*\.nav-toggle \{ display: inline-flex/,
    'the button may not be shown to a page that cannot open it'
  );
});

test('the panel hangs under the bar, and opening it moves nothing', () => {
  const panel = rule(narrow, 'html.nav-js .nav-links');
  assert.match(panel, /position: absolute/, 'in the flow, opening the menu would make the head taller and push the page down');
  assert.match(panel, /top: 100%/, 'directly under the bar, whatever its height');
  assert.match(panel, /display: none/, 'shut by default');
  assert.match(rule(narrow, 'html.nav-js .nav-links.is-open'), /display: flex/, 'and open when the button says so');
  assert.match(panel, /background-color: var\(--paper\)/, 'the panel is the sheet, so it can be read over any page');
});

test('the panel\u2019s labels are ink, because the panel is paper wherever it opens', () => {
  assert.match(
    rule(narrow, 'html.nav-js .nav-links .nav-text'),
    /color: var\(--ink\)/,
    'the head\u2019s light pair is for the bar standing on the film, and the panel never does'
  );
  assert.doesNotMatch(
    narrow,
    /html\.nav-js \.nav-links \.nav-text \{[^}]*--head-label/,
    'a label handed to the light pair over a paper panel is a label nobody can read'
  );
  // There is room in a column, so the long label comes back: the short one
  // existed only to keep four labels in one row on a phone.
  assert.match(narrow, /html\.nav-js \.nav-full \{ display: inline; \}/);
  assert.match(narrow, /html\.nav-js \.nav-short \{ display: none; \}/);
});

test('on a tablet the menu is a card under the button, not a full-width row', () => {
  // Four short labels across a 700px window is a letterbox with half the paper
  // empty. Between the phone and the bar there is one more shape, and it is the
  // one a menu on this width is expected to have.
  const card = mediaBlock(css, '(min-width: 561px) and (max-width: 760px)');
  const panel = rule(card, 'html.nav-js .nav-links');
  assert.match(panel, /left: auto/, 'the card is hung off the right edge, not stretched from the left');
  assert.match(panel, /right: var\(--pad-x\)/, 'and lines up with the page\u2019s own right edge, where the button is');
  assert.match(panel, /width: 288px/, 'sized to the words, not to the window');
  assert.match(panel, /border: 1px solid/, 'a card has four edges, where the phone\u2019s panel has only the rule under the bar');
});

test('theme.js opens the row it was given, and every way out closes it', () => {
  assert.match(js, /getElementById\('navToggle'\)/, 'the button is found, not built');
  assert.match(js, /getElementById\('navMenu'\)/, 'and so is the row');
  assert.match(js, /setAttribute\('aria-expanded'/, 'the button has to say which state it is in');
  assert.match(js, /'Escape'/, 'Escape is the way out of a panel over the page');
  assert.match(js, /toggle\.focus\(\)/, 'and it gives the reader back to the button that opened it');
  assert.match(js, /pointerdown/, 'a press anywhere else closes it, on a phone as well as a mouse');
  assert.match(js, /pageshow/, 'a page restored from the cache arrives shut, not with the last reader\u2019s panel open');
  assert.match(js, /classList\.toggle\('is-open'/, 'one class, and the stylesheet does the rest');
});

test('the stylesheet and the script meet at the same width', () => {
  // The row reappears at 761 and the button is gone there, so an open panel
  // has to shut at exactly that width - otherwise a window widened in one
  // gesture springs it open again when it narrows.
  assert.match(js, /min-width: 761px/, 'the script must ask about the width the stylesheet stops using the button at');
  assert.ok(narrow.length > 0, 'and the stylesheet must still end the menu at 760px');
});
