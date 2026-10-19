// test/paneInteractions.test.js
//
// Two things the reader does inside a snapshot, and what each one depends on:
//
//  - full screen. The frame is the same archived page as the pane, and a
//    capture's first paint is a second or two of white. Without the veil the
//    panes wear, that white reads as "full screen is broken", so the modal
//    has the same spinner over the same box, shown while the document is
//    being fetched and drawn and taken down on its load event;
//  - hovering an outlined change in the page itself. The sidebar has a card
//    that explains a change in plain words; the page should answer the same
//    question the same way, with the same card, because it is the same
//    builder. The only new work is turning a box inside the frame into a box
//    in the host page, since the card lives in the host.
//
// Also pinned: the pane's click and hover wiring runs when the document is
// parseable, not only on its load event. One archived picture that never
// finishes holds that event for a minute, and until it fired there was no
// click handling and no hover card at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'compare.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');

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

test('the full-screen frame wears the same veil as the panes', () => {
  assert.match(html, /id="modalFrameLoading"/, 'the modal has a loading veil of its own');
  assert.equal((html.match(/id="modalFrameLoading"/g) || []).length, 1, 'exactly one');
  // The veil is a sibling of the frame in one positioned box, so it covers
  // the page area and not the toolbar.
  assert.match(html, /<div class="pane-modal-stage">/);
  const stage = html.slice(html.indexOf('pane-modal-stage'), html.indexOf('modalFrameLoading'));
  assert.match(stage, /<iframe id="modalFrame"/, 'the frame and its veil live in that box');
  assert.match(css, /\.pane-modal-stage \{[^}]*position: relative/, 'the veil is positioned against it');
  // render() in app.js already shows and hides `${iframeId}Loading`; the load
  // handler asks the shared "is it painted" gate to take it down for the modal.
  assert.match(
    app,
    /el\('modalFrame'\)\.addEventListener\('load', \(\) => \{ revealPaneWhenPainted\(el\('modalFrame'\)\);/,
    'the veil comes down when the frame has been painted'
  );
});

test('opening full screen re-renders instead of re-assigning the same document', () => {
  // Assigning an identical srcdoc is a no-op: no load event, so a veil shown
  // for the render would never come down. Close-and-reopen is exactly that case.
  const setHome = app.slice(app.indexOf('setHome(html, url)'), app.indexOf('navigate(url)'));
  assert.match(setHome, /render\(stack\.reset\(\), true\)/, 'forced, so every open is a real load');
});

test('hovering an outlined change shows the sidebar card', () => {
  const hover = fn(app, 'paneHoverOver');
  assert.match(hover, /data-pdiff-added/, 'the outline is what is hovered');
  assert.match(hover, /PdiffSelection\.paneChangeIndex/, 'the change is the row the sidebar would light');
  assert.match(hover, /showChangeTooltip\(c, paneAnchor\(iframe, marked\)\)/, 'and it is the same card builder');
  assert.match(hover, /setTimeout\(/, 'a short wait, so sweeping the pointer does not strobe cards');
  // Wiring: the pane documents get it, on hover, in the same place clicks are
  // wired, and leaving the frame or scrolling takes the card away.
  assert.match(app, /doc\.addEventListener\('mouseover', \(e\) => \{ try \{ paneHoverOver\(iframe, e\.target\); \}/);
  assert.match(app, /doc\.addEventListener\('mouseleave', \(\) => \{/);
  assert.match(app, /doc\.addEventListener\('scroll', \(\) => scheduleTooltipHide\(\), true\)/);
});

test('the card is placed in the host page, not the frame it was found in', () => {
  const anchor = fn(app, 'paneAnchor');
  assert.match(anchor, /iframe\.getBoundingClientRect\(\)/, 'the frame offset is the translation');
  assert.match(anchor, /frame\.left \+ r\.left/, 'x is added through');
  assert.match(anchor, /frame\.top \+ r\.top/, 'so is y');
  assert.match(anchor, /getBoundingClientRect\(\) \{/, 'and the card asks it for a box like any anchor');
});

test('a snapshot the click folded away is judged as a folded outcome', () => {
  // A React front page drops the cards whose data never arrived, markup,
  // words and all, and a nav can live only in one of the page's own layouts.
  // Neither is a click that did nothing: the stage folds to the snapshot
  // whose layout paints the change, and the check that walks real comparisons
  // reads the stage's own classes rather than guessing from a light.
  assert.doesNotMatch(html, /pane-note/, 'no panel of commentary sits over a snapshot');
  assert.doesNotMatch(css, /pane-note/, 'and none is styled');
  assert.match(app, /function orientStageForSelection\(c, opts\)/, 'the arrangement is chosen by the selection');

  const verify = fn(app, 'verifySelectionScrolls');
  assert.doesNotMatch(verify, /setPaneNote|paneNoteFor/, 'the watch loop explains nothing');
  assert.match(verify, /const folded = collapsedPanes\(\);/, 'it simply skips a pane that is folded away');

  const check = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-compare-clicks.js'), 'utf8');
  assert.match(check, /stage\.classList\.contains\('hide-old'\)/, 'the click check reads the arrangement the click made');
  assert.match(check, /if \(s\.folded\) \{ explain\.push\(side \+ ': folded away for this change'\); continue; \}/,
    'and reports a folded side as the outcome it is, not a miss');
  assert.match(check, /const settledSide = \(s\) => !!\(s\.folded \|\| s\.neverShows\);/, 'a folded side is settled, so it is not polled for thirty seconds');
  // A change no rule of the page ever shows is settled too: the snapshot is
  // left as the Archive recorded it, so there is nothing to light and nothing
  // to wait for.
  assert.match(check, /neverShows = !!\(p && p\.neverShows\)/, 'and so is a change the page never paints');
  assert.match(check, /if \(!s\.lit && s\.neverShows\) \{/, 'which is reported as its own outcome, not a miss');
  // A light is still required on every pane that is on screen, and a mark the
  // page paints but the click missed is still a failure.
  assert.match(check, /const painted = \(n\) => \{/, 'a painted box is judged through the page\u2019s own styles');
  assert.match(check, /markPainted: painted\(marked\)/);
  assert.match(check, /cs\.visibility === 'hidden'/, 'an ancestor the page hides counts as not painted');
});

test('the card is a hover\u2019s answer, never a click\u2019s', () => {
  // Tried twice the other way and rejected both times: a click that opens a
  // board of text is not what the list is for. Hover shows the card, leaving
  // the row takes it away, and a click only lights the row and takes the panes
  // to the change.
  const jump = fn(app, 'jumpToChange');
  assert.match(jump, /rowEl\.classList\.add\('selected'\)/, 'it selects the row');
  assert.match(jump, /applySelectionReveals\(c, true\)/, 'and hands the question to the panes');
  // The one card a click may put back is the one the pointer is already
  // showing: selecting first clears the last selection's card, and a pointer
  // that never left its row gets its hover card straight back.
  assert.match(jump, /rowEl\.matches\(':hover'\)/, 'the card comes back only while the pointer is on the row');
  const restore = jump.slice(jump.indexOf("matches(':hover')"));
  assert.doesNotMatch(restore, /else/, 'and never otherwise: no card is invented by a click');
  // Nothing is pinned, docked, or kept open by a click anywhere: no card
  // element is ever moved out of the floating layer or into a row.
  assert.doesNotMatch(app, /pinChangeTooltip|unpinChangeTooltip|pinnedTooltipRow/, 'no pinning machinery is left');
  assert.doesNotMatch(app, /classList\.add\('pinned'\)/);
  assert.doesNotMatch(app, /classList\.add\('docked'\)/);
  assert.doesNotMatch(css, /\.change-tooltip\.docked/);
  assert.match(app, /<li[^>]*>|renderChangesList/, 'the list still exists to hover');
  // Hover is the one path that shows it, and the pointer leaving the row (or
  // the list scrolling under it) takes it away again.
  assert.match(app, /li\.addEventListener\('mouseenter', \(\) => \{ cancelTooltipHide\(\); showChangeTooltip\(c, li\); \}\)/);
  assert.match(app, /li\.addEventListener\('mouseleave', scheduleTooltipHide\)/);
  assert.match(fn(app, 'scheduleTooltipHide'), /setTimeout\(hideChangeTooltip, 150\)/);
  assert.match(app, /el\('panelChanges'\)\.addEventListener\('scroll', \(\) => hideChangeTooltip\(\)/, 'a scroll under the pointer takes it away');
});

test('the veil comes down on a finished page, not on a parsed one', () => {
  // Three things used to take the veil off too early, each measured on a real
  // comparison: the frame's about:blank placeholder firing its own load event
  // (veil gone at 1.1s, the capture written afterwards), pictures that were
  // still arriving, and CSS background images - which is how the older half of
  // the archive paints its hero - being waited for by nobody.
  const usable = fn(app, 'paneDocumentUsable');
  assert.match(usable, /doc\.readyState === 'loading'/, 'a document still parsing is not painted');
  assert.match(usable, /doc\.body && doc\.body\.children\.length/,
    'and neither is the empty placeholder the frame starts life as');

  const painted = fn(app, 'panePainted');
  assert.match(painted, /paneDocumentUsable\(doc\)/, 'the gate asks that question first');
  assert.match(painted, /if \(!img\.complete\) drawn = false;/, 'every picture, not only the ones in view');
  assert.match(painted, /settleBrokenPictures\(doc, win\)/, 'and a broken one is handled before the pane is shown');
  assert.match(painted, /preloadPaneBackgrounds\(doc, win, budget\)/, 'CSS backgrounds are part of the answer');

  // A picture that cannot be drawn is silenced rather than printed: the broken
  // glyph and its alt text ended up across the section title behind it.
  const hide = fn(app, 'hideUndrawablePicture');
  assert.match(hide, /data-pdiff-unavailable/, 'the picture is marked');
  assert.match(hide, /'visibility', 'hidden', 'important'/, 'and hidden, keeping the box the layout gave it');
  const retry = fn(app, 'retryPictureUrl');
  assert.match(retry, /palimpsest-retry=1/, 'one more ask before giving up, on a fresh address so the browser cannot serve the failure');
  assert.doesNotMatch(retry, /\^data:[^/]/, 'an inline picture is never re-asked');
  const settle = fn(app, 'settleBrokenPictures');
  assert.match(settle, /PANE_REPAIR_MS/, 'and the whole repair has a budget of its own');
  assert.match(settle, /addEventListener\('load', settle/, 'a picture that arrives on the second ask is kept');

  const backgrounds = fn(app, 'paneBackgroundUrls');
  assert.match(backgrounds, /backgroundImage/, 'the urls come from the page\u2019s own computed style');
  assert.match(backgrounds, /paneInViewport\(node, win\)/, 'only what is on screen is waited for');
  assert.match(backgrounds, /slice\(0, 60\)/, 'and the list is bounded');
});

test('the card floats over the page, positioned from the row it describes', () => {
  const place = fn(app, 'positionTooltip');
  assert.match(place, /anchorRect\.left - width - margin/, 'to the left of the row, as it always was');
  assert.match(place, /tooltip\.style\.left = /);
  assert.doesNotMatch(place, /docked/, 'and with no docked special case left in it');
  assert.match(css, /\.change-tooltip \{[\s\S]*?position: fixed/, 'it is a floating layer');
  const render = app.slice(app.indexOf('function renderChangesList'), app.indexOf('function visibleRows'));
  assert.doesNotMatch(render, /appendChild\(tooltip\)/, 'nothing moves the card into a row');
});

test('the card says what was removed, and where it shows on screen', () => {
  const card = fn(app, 'showChangeTooltip');
  assert.match(card, /'Removed text'/, 'a removal labels its box as the removed text, not \u201cBefore\u201d');
  assert.match(card, /'Added text'/, 'and an addition as the added text');
  assert.match(card, /paintStandInNote\(c\)/, 'the visible stand-in is named on the card');
  assert.match(card, /setTimeout\(\(\) => paintStandInNote\(c\), 450\)/, 'and asked again once the snapshot has settled');

  const note = fn(app, 'paintStandInNote');
  assert.match(note, /changeIsDrawnInPane\(c, side\)/, 'a change the page draws needs no explanation');
  assert.match(note, /visibleStandInFor\(c, side\)/, 'a hidden one names the element the page does draw');
  assert.match(note, /On screen: /, 'in those words');
  assert.match(note, /Nothing on screen shows this/, 'and says plainly when there is nothing to point at');
  assert.match(fn(app, 'visibleStandInFor'), /standInLabelFor\(up, node, win\)/);
  assert.match(fn(app, 'standInLabelFor'), /node\.contains\(host\)/,
    'the link the label lives in wins over the bar that holds several of them');
  const painted = fn(app, 'paneNodeIsPainted');
  assert.match(painted, /r\.width < 2 \|\| r\.height < 2/, 'a 1\u00d71 screen-reader box is not painted');
  assert.doesNotMatch(painted, /opacity/, 'but an opacity-0 label over an icon still counts');
  assert.match(html, /id="changeDetailStandIn"/, 'the line has a home in the card');
  assert.match(css, /\.change-detail-standin/, 'and a style of its own');
});

test('the pane is wired as it parses, not only when every image has finished', () => {
  const wire = fn(app, 'wirePaneWhenReady');
  assert.match(wire, /readyState !== 'loading'/, 'interactive is enough');
  assert.match(wire, /wirePaneReverseClick\(iframe\)/, 'which is the same wiring as on load');
  // The veil comes down when the page is actually painted, through the same
  // gate the load event uses - one definition of ready, and it is the one the
  // reader sees.
  assert.match(wire, /revealPaneWhenPainted\(iframe\);/, 'the veil answers to the painted gate for this frame');
  const painted = fn(app, 'panePainted');
  assert.match(painted, /link\.sheet/, 'a stylesheet that has not applied yet is not painted');
  assert.match(painted, /img\.complete/, 'nor is a picture still arriving');
  assert.match(painted, /doc\.fonts\.status === 'loading'/, 'nor one whose fonts are still swapping in');
  assert.match(painted, /Date\.now\(\) - started > PANE_SETTLE_MS/, 'and the budget ends the wait whatever is missing');
  assert.match(fn(app, 'revealPaneWhenPainted'), /hidePaneLoading\(`\$\{iframe\.id\}Loading`\)/, 'which is what takes the veil down');
  const render = app.slice(app.indexOf('function render(entry, force)'), app.indexOf('// Followed pages render through the capture pipeline'));
  assert.match(render, /wirePaneWhenReady\(iframe\);/, 'every render arms it');
  assert.match(fn(app, 'openPaneModal'), /wirePaneWhenReady\(el\('modalFrame'\)\)/, 'and so does the full-screen frame');
});
