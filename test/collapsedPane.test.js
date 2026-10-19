// test/collapsedPane.test.js
//
// Hiding one snapshot folds that pane into a 40px strip whose only job is to
// bring it back. The strip used to keep the pane's address row: at 40px it
// became a white chip under the top hairline holding nothing but the archive
// button, which read as a stray box (or a bin) rather than as part of a
// snapshot. The rule here keeps the strip to one control: no toolbar, no
// address row, just a circled chevron and the snapshot's own name, centred
// down the full height of the card.
//
// The other half of the fold - expanding the snapshot again when a change
// can only be seen there - is behaviour, checked in the browser: a removed
// row picked while the earlier snapshot is collapsed must reopen it and
// light the item.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function rule(selector, source = css) {
  const flat = source.replace(/,\s*\n\s*/g, ', ');
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'g');
  let found;
  const bodies = [];
  while ((found = pattern.exec(flat))) {
    const open = flat.indexOf('{', found.index);
    const close = flat.indexOf('}', open);
    bodies.push(flat.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' '));
  }
  assert.ok(bodies.length, `styles.css must still carry a \`${selector}\` rule`);
  return bodies.join(' ');
}

test('the collapsed pane keeps nothing of its toolbar but the way back', () => {
  const hidden = rule(
    '.viewer-panes.hide-old .pane:first-child .pane-label, .viewer-panes.hide-old .pane:first-child .pane-addressbar, .viewer-panes.hide-old .pane:first-child .pane-frame-wrap, .viewer-panes.hide-new .pane:last-child .pane-label, .viewer-panes.hide-new .pane:last-child .pane-addressbar, .viewer-panes.hide-new .pane:last-child .pane-frame-wrap'
  );
  assert.match(hidden, /display: none/, 'the strip holds the restore control and nothing else');
  // The address row is the piece that looked wrong: check it on its own, so a
  // rewrite of the combined rule cannot quietly leave it visible again.
  assert.match(
    css,
    /\.viewer-panes\.hide-old \.pane:first-child \.pane-addressbar,/,
    'the earlier strip must not keep its address row'
  );
  assert.match(
    css,
    /\.viewer-panes\.hide-new \.pane:last-child \.pane-addressbar,/,
    'the later strip must not either'
  );
});

test('the strip is one full-height control, centred', () => {
  const strip = rule('.pane-restore-btn');
  assert.match(strip, /height: 100%/, 'the whole card is the button');
  assert.match(strip, /justify-content: center/, 'the chevron and name sit in the middle of the lane');
  assert.match(strip, /background: var\(--panel-sunken\)/, 'the strip is the sunken paper, not a white chip');
  assert.match(strip, /padding: 0/, 'no leftover inset from the old card');

  const icon = rule('.pane-restore-btn svg');
  assert.match(icon, /border-radius: 50%/, 'the chevron wears its own ring');
  assert.match(icon, /border: 1px solid var\(--line-strong\)/, 'drawn, not floated');

  const label = rule('.pane-restore-label');
  assert.match(label, /writing-mode: vertical-rl/, 'the snapshot name still reads down the lane');
});
