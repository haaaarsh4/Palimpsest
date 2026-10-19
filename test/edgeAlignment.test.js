// test/edgeAlignment.test.js
//
// Two edges the reader named, both of which are layout rather than behaviour,
// so what is checked here is the rule that holds them:
//
//  - the record line's sentence is set from the sheet's left margin, with the
//    second half stepped in under the first and the arrow answering from the
//    lower right. It was tried flush right, then centred, and both were worse:
//    the two lines of a two-line sentence have to hold their step, or the
//    block stops reading as one sentence and starts reading as two lines that
//    happen to be near each other;
//  - the changes list's scrollbar stands in its own lane instead of on the
//    cards. It was flush against the rounded corner of every row, and the
//    platform's thin bar brought a square end and an arrow button with it,
//    which is what made the column look broken.
//
// The bar is drawn by the pseudo-elements, so the list must not also ask for
// the platform bar (`scrollbar-width: thin`), which would suppress them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const theme = fs.readFileSync(path.join(pub, 'theme.css'), 'utf8');
const styles = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');

function rules(source, selector) {
  const flat = source.replace(/,\s*\n\s*/g, ', ');
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  let found;
  const bodies = [];
  while ((found = pattern.exec(flat))) {
    const open = flat.indexOf('{', found.index);
    const close = flat.indexOf('}', open);
    bodies.push(flat.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' '));
  }
  assert.ok(bodies.length, `the stylesheet must still carry a \`${selector}\` rule`);
  return bodies;
}

// Every body, joined: the shorthand assertions read across the stylesheet.
function rule(source, selector) {
  return rules(source, selector).join(' ');
}

// The base rule only. Later blocks (a media query, the Firefox fallback) are
// additions on top of it, and a negation has to be read against the first one.
function baseRule(source, selector) {
  return rules(source, selector)[0];
}

test('the record line is set from the left margin, stepped into the second line', () => {
  assert.match(rule(theme, '.record-line'), /text-align: left/, 'the caption and the sentence share the sheet\u2019s left margin');
  assert.doesNotMatch(rule(theme, '.record-line'), /text-align: right|text-align: center/, 'and not a right or centred one');
  // The step is what says the two halves are one sentence.
  assert.match(rule(theme, '.record-line-2'), /margin-left: 19vw/, 'the second line steps in under the first');
  // The arrow answers from the lower right, inset from the margin by its own
  // measure rather than pinned to either corner.
  assert.match(rule(theme, '.record-arrow'), /margin: 2\.6vw 22vw 0 auto/, 'the mark answers from the lower right');
});

test('the changes list keeps its scrollbar off the cards', () => {
  const list = baseRule(styles, '.changes-list');
  assert.match(list, /padding: 0 12px 0 0/, 'the content is inset by a clear lane for the bar');
  assert.match(list, /scrollbar-gutter: stable/, 'the lane is reserved, so filtering rows does not shift the cards');
  assert.doesNotMatch(list, /scrollbar-width: thin|scrollbar-color: var/, 'the platform bar would overrule the drawn one');
  assert.match(list, /scrollbar-width: auto/, 'and it has to be handed back to the pseudo-elements');

  assert.match(rule(styles, '.changes-list::-webkit-scrollbar'), /width: 9px/, 'the lane is the bar\u2019s own width');
  assert.match(rule(styles, '.changes-list::-webkit-scrollbar-button'), /display: none/, 'no arrow ends');
  assert.match(
    rule(styles, '.changes-list::-webkit-scrollbar-thumb'),
    /border: 2px solid transparent/,
    'the inset border is what pulls the ink off the lane\u2019s edges'
  );
  assert.match(rule(styles, '.changes-list::-webkit-scrollbar-thumb'), /border-radius: 100px/, 'a rounded thumb, matching the rows');
  assert.match(rule(styles, '.changes-list::-webkit-scrollbar-thumb'), /background-clip: content-box/);
  assert.match(
    styles,
    /@supports not selector\(::-webkit-scrollbar\) \{\s*\.changes-list \{ scrollbar-width: thin;/,
    'engines without the pseudo-elements keep the sheet\u2019s quiet thin bar'
  );
});

test('the phone keeps the step, measured against the line rather than the window', () => {
  // The step comes in on a narrower sheet (10vw, 6vw on the smallest phones)
  // so the second half does not run past the first, and the arrow answers
  // flush to the sheet's right margin instead of 22vw in from it.
  assert.match(
    theme,
    /@media \(max-width: 720px\)[\s\S]*?\.record-line-2 \{ margin-left: 10vw; \}/,
    'the step narrows with the sheet'
  );
  assert.match(
    theme,
    /@media \(max-width: 720px\)[\s\S]*?\.record-arrow \{[^}]*margin: clamp\(22px, 6vw, 30px\) 0 0 auto;/,
    'the arrow answers from the right margin on a phone'
  );
  assert.match(theme, /@media \(max-width: 380px\)[\s\S]*?\.record-line-2 \{ margin-left: 6vw; \}/);
});
