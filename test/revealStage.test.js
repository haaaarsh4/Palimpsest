// test/revealStage.test.js
//
// What selecting a change in the comparison is allowed to do, each with the
// symptom a reader sees when it is wrong:
//
//  - a selection shows a hidden change the way the page shows it: the app
//    performs the interaction the page's own rules describe (the hover on
//    SERVICES that opens its dropdown, the click a state class answers to), so
//    the change appears in the page's own menu. What it never does is invent a
//    style for a node no rule of the page ever shows: the 2015 header's hidden
//    ACTIVITY copy stays hidden, and the menu the page does open is what is
//    opened and marked instead;
//  - the one thing a selection may rearrange is how much width each snapshot
//    has, and only to reach the orientation the page itself paints the change
//    in: a change the pair already paints never rearranges anything, and a
//    change no width paints is left exactly as the Archive recorded it with
//    the control that opens it marked;
//  - when the same change is painted elsewhere in the same document (a nav
//    copied into a phone drawer, a footer repeat), that visible copy is what
//    is scrolled to and lit;
//  - the marked node is what gets scrolled to and lit, scrolls are corrected
//    while the archived images arrive, and a click that lands while the pane
//    is still parsing still ends marked.
//
// What is checked is the shape of the fix (which function asks what, and what
// happens to the answer), not the pixels: the browser behaviour is covered by
// scripts/check-compare-clicks.js, which walks a real comparison in a real
// browser and is the check to run when any of this is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// The body of a named function, by brace matching from its opening line.
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

const orient = fn(app, 'orientStageForSelection');
const arrange = fn(app, 'arrangeStage');
const release = fn(app, 'releaseInstant');
const shows = fn(app, 'nodeShowsItself');
const shownIn = fn(app, 'changeShowsInPane');
const applyReveals = fn(app, 'applySelectionReveals');
const verify = fn(app, 'verifySelectionScrolls');
const ready = fn(app, 'wirePaneWhenReady');

const attempt = fn(app, 'selectionAttempt');
const plan = fn(app, 'revealPlanFor');
const howTo = fn(app, 'paintHowToNote');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'compare.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('the pair stays a pair for a change it already paints', () => {
  // The rule the owner asked for, in their words: a change that exists in the
  // layout on screen stays in that layout. The stage is measured from the pair
  // up - not from whatever arrangement the last click left behind - so a change
  // both panes paint (the "Online since 2000" picture) can never fold one of
  // them away, whether the previous row folded or not.
  assert.match(orient, /selectionAttempt\(null, c\)/, 'the baseline arrangement a selection has to move away from is the pair');
  assert.match(orient, /if \(showsAll\(last\.visible\)\) \{/, 'a change the pair paints returns without rearranging anything');
  assert.match(attempt, /visible\[side\] = changeShowsInPane\(iframe, c, side\);\n/,
    'each pane is simply asked whether it paints the change, as it is');
});

test('the page\u2019s own interaction is performed where the page opens it', () => {
  // The owner's rule: when the page shows a change by hovering or clicking a
  // control, the app does that itself, so the change appears in the page's own
  // dropdown instead of being described in a card. The page's rules decide
  // (a `:hover` on a named control, a `.open` state class); nothing is
  // hardcoded per site. This pass is only the page's own interaction - a
  // change no rule of the page ever prints stays hidden (see the test below).
  const perform = fn(app, 'performSelectionReveal');
  const openMenus = fn(app, 'openMenusForSelection');
  assert.match(plan, /PdiffReveal\.analyze\(doc, marked/, 'the page names what hides it and what reveals it');
  assert.match(plan, /best\.trigger/, 'including the control a person touches');
  assert.match(plan, /:hover/, 'and the gesture, read off the selector');
  assert.match(plan, /interactive = !!\(best && \(best\.interactive/, 'and whether that is an interaction at all');
  assert.doesNotMatch(plan, /applyReveal|setAttribute|style\./, 'analysis never writes to the page');
  // The interaction itself: only an interactive plan is performed, and only
  // through the page's own rules (applyReveal restages the hover and its
  // companion rules; it never invents a style of its own).
  assert.match(perform, /if \(!plan \|\| !plan\.interactive \|\| plan\.responsive\) return null;/, 'no interaction of this copy\u2019s own is restaged');
  assert.match(perform, /PdiffReveal\.applyReveal\(doc, win, plan\.analysis\)/, 'and the page\u2019s rules are what get applied');
  assert.match(perform, /activeReveals\.push\(receipt\)/, 'the open is owned by the selection, so it can be closed');
  // Both panes, before the stage is measured, so the change counts as painted
  // and the dropdown is open when the panes settle.
  assert.match(openMenus, /performSelectionReveal\(el\('paneOld'\), c, 'old'\)/);
  assert.match(openMenus, /performSelectionReveal\(el\('paneNew'\), c, 'new'\)/);
  assert.match(applyReveals, /openMenusForSelection\(c\);\n  \/\/ Which arrangement paints the change/, 'before the arrangement is measured');
  const clear = fn(app, 'clearSelection');
  assert.match(clear, /closeSelectionReveals\(\)/, 'a deselected row closes what it opened');
  // The control is still what the pane marks when the page names one, and the
  // card now describes the page rather than instructing the reader.
  const target = fn(app, 'scrollTargetFor');
  assert.match(target, /revealPlanFor\(iframe, change, side\)/, 'the click asks for the plan');
  assert.match(target, /plan\.trigger && isDisplayedInPane\(plan\.trigger\)/, 'and marks the painted control');
  assert.match(howTo, /plan\.triggerLabel/, 'the card names the page\u2019s own menu');
  assert.match(howTo, /note\.textContent = action/, 'in plain text, not bold-led HTML');
  assert.doesNotMatch(howTo, /<strong>|How to see it/, 'with no bold lead-in');
  assert.match(html, /id="changeDetailHowTo"/, 'which has a home in the card');
  assert.match(css, /\.change-detail-howto/, 'and a style of its own');
  // The reader's words about the old version: no bold, no dark rule down the
  // side, no em dash. It reads as part of the card, not as a callout.
  assert.doesNotMatch(css, /\.change-detail-howto[^{]*\{[^}]*border-left/, 'no rule down the side');
  assert.doesNotMatch(css, /\.change-detail-howto[^{]*\{[^}]*font-weight:\s*(6|7|8|9)\d\d/, 'and no bold');
  assert.doesNotMatch(howTo, /\\u2014/, 'and no em dash in the sentence');
  // Nothing is hardcoded per site: the plan comes from the page's rules.
  assert.doesNotMatch(plan + howTo, /settlement|nytimes|apple\.com|wikipedia/i, 'no site is named');
  assert.doesNotMatch(app, /expand\w*ByHand|openContainer/, 'and no container is opened by hand');
});

test('a change no visitor ever saw is left hidden, and the card says so', () => {
  // In the owner's words: the 2015 capture carries "Activity" in a second copy
  // of its nav that `.nav-responsive-1, .nav-responsive-2 { display: none }`
  // hides at every width. No visitor to settlement.org ever saw that link, so
  // the snapshot must not paint it either: forcing the chain open showed a
  // page that never existed. The row still selects and its card explains why
  // there is nothing on screen, and clicking it is allowed to do nothing.
  assert.doesNotMatch(app, /forceSelectionReveal/, 'nothing opens a hidden chain to make a change appear');
  assert.doesNotMatch(applyReveals, /PdiffReveal\.forceReveal|forcedNow/, 'the selection pass forces nothing');
  // The plan has to notice the box ABOVE the hiding rule. This copy's submenu
  // has a `:hover` rule, so the engine's nearest-rule answer is optimistic;
  // what makes it unreachable is `.nav-responsive-2` itself being display:none
  // with no width in the rule. Without this walk the card claimed the change
  // opens in the SERVICES menu - a menu that never contained it.
  const p = plan;
  assert.match(p, /analysis\.hiddenNode && analysis\.hiddenNode\.parentElement/, 'the chain above the hiding rule is walked');
  assert.match(p, /PdiffReveal\.hidingRule\(doc, up,/, 'each hidden ancestor\u2019s own rule is read');
  assert.match(p, /if \(!rule \|\| !rule\.mediaText\) \{/, 'an unconditional hiding is unreachable');
  assert.match(p, /if \(blocked\) interactive = false;/, 'and the interaction is dropped');
  assert.match(p, /const neverShows = !interactive && !analysis\.responsive &&/, 'the change is marked as never shown');
  // Nothing is marked either: the header cell the dead copy happens to sit in
  // is not "where it is", and a badge there says the header changed.
  const target = fn(app, 'scrollTargetFor');
  assert.match(target, /if \(plan && plan\.neverShows\) return null;/,
    'a hiding no interaction and no width answers to has nothing to scroll to');
  // The card carries the explanation instead.
  assert.match(howTo, /No rule of the page ever shows it/, 'the card says no rule shows it');
  assert.match(howTo, /at every width/, 'at every width');
  assert.match(howTo, /no visitor to the site ever saw/, 'that no visitor saw it');
  assert.match(howTo, /will not reveal it/, 'and that clicking does not reveal it');
  assert.doesNotMatch(howTo, /opens that exact container in place/, 'the old promise is gone');
  // The stand-in line stays out of the way: naming the header cell as "where
  // it is on screen" reads as if the page drew the change.
  const standIn = fn(app, 'paintStandInNote');
  assert.match(standIn, /if \(plan && plan\.neverShows\) \{/, 'no stand-in is named for a change no rule shows');
  assert.doesNotMatch(fn(app, 'carrierAncestorFor'), /header|nav|footer|main/, 'and a page landmark is never outlined by hand');
});

test('a hiding the viewport answers to is tried at its own width first', () => {
  // A phone drawer hidden under a max-width rule and a desktop bar hidden
  // under min-width get the page's own wide layout before anything is forced:
  // the plan reports the width, the card names it, and the fold gives the
  // snapshot the width the change was designed for. Only when that layout
  // still does not paint the change does the exact in-place open run (see
  // applySelectionReveals), because the reader asked for the change, not for
  // an explanation of why this width hides it.
  assert.match(plan, /responsive: !!analysis\.responsive/, 'a viewport hiding is carried through');
  assert.match(howTo, /plan\.responsive/, 'and the card says it is a width');
  assert.match(howTo, /paneWidth/, 'with the pane\u2019s own width named');
  // A width is not an interaction: the CSS interaction is never performed
  // for one, so the fold below is the first answer.
  assert.match(fn(app, 'performSelectionReveal'), /!plan\.interactive \|\| plan\.responsive\) return null;/, 'the interaction is refused for a viewport hiding');
  assert.ok(applyReveals.indexOf('orientStageForSelection(') !== -1, 'the fold is measured before anything is painted');
  assert.doesNotMatch(applyReveals, /forceReveal/, 'and the wide layout is the whole answer');
});

test('a change only the wide layout paints is reached by folding', () => {
  // The other half of the same rule: when no width the pair has paints the
  // change, and neither does the page open a container for it, the answer is
  // the orientation it IS painted in. The stage is folded to that snapshot,
  // the page lays itself out again at the width it now has, and the opening
  // is tried again there - a drawer that only exists wide, with a submenu
  // inside it, needs both.
  assert.match(orient, /const wide = \{ old: false, new: false \};/, 'each side that carries the change is asked about its wide layout');
  assert.match(orient, /selectionAttempt\(other\(side\), c\)/, 'by giving it the stage to itself and measuring there');
  assert.match(orient, /wide\[side\] = !!last\.visible\[side\];/, 'the answer is measured from the page itself, never assumed');
  assert.match(orient, /const fold = wide\.new \? 'new' : \(wide\.old \? 'old' : null\);/,
    'and a fold only ever happens to a snapshot whose wide layout paints the change');
  assert.match(orient, /selectionAttempt\(wanted, c\)/, 'the stage settles in the arrangement the answer needs');
  assert.doesNotMatch(orient, /if \(!liveSides\(\)/, 'no other reading of the layout can fold it');
  // The pane's width is the only thing the fold changes; every pixel painted
  // is the page's own layout at that width.
  assert.doesNotMatch(arrange, /style\.|contentDocument\.write/,
    'nothing is written into a snapshot to make a change show');
  assert.match(arrange, /setSinglePaneView\(folded === undefined \? null : folded, \{ instant: true \}\)/,
    'the fold is instant, so no half-width layout is ever painted');
  assert.match(arrange, /getBoundingClientRect\(\)/, 'and the frame is made to lay out at its new width before it is read');
  assert.match(release, /requestAnimationFrame/, 'the grid\u2019s animation comes back a frame later');
});

test('an interaction is performed at the width the stage ends up in, not the one it left', () => {
  // The owner's bug: with one snapshot full width, picking NEWS in the list
  // unfolded the pair - and the desktop bar's hover rules, restaged a moment
  // earlier against the wide layout, were left running in a phone-width pane.
  // The page's own phone menu was what belonged there: an absolutely placed
  // column over the hero. Instead the desktop items laid themselves out inline,
  // wrapping across the header and pushing the whole page down. A restaged
  // open belongs to a width, so when the arrangement resizes a pane it is put
  // back and the page's interaction is performed again at the new width.
  const widths = fn(app, 'paneContentWidths');
  assert.match(widths, /contentWindow/, 'each pane\u2019s page is asked for its own width');
  assert.match(applyReveals, /const widthsBefore = paneContentWidths\(\);\n  openMenusForSelection\(c\);/, 'the width is read before the open');
  assert.match(applyReveals, /const widthsAfter = paneContentWidths\(\);/, 'and after the stage has settled');
  assert.match(applyReveals, /if \(resized\) \{/, 'a resize is what makes the earlier open wrong');
  assert.match(applyReveals, /closeSelectionReveals\(\);\n    openMenusForSelection\(c\);/, 'so it is closed and performed again');
  assert.match(applyReveals, /visibleNow\[side\] = changeShowsInPane\(el\(side === 'old' \? 'paneOld' : 'paneNew'\), c, side\);/,
    'and what the pane paints is re-read from that layout');
  assert.doesNotMatch(applyReveals, /forceReveal\(doc/, 'the re-open still goes through the page\u2019s own rules');
});

test('a change nothing can paint is left where the Archive put it', () => {
  // Nothing opens and no fold is made; the click still marks the nearest thing
  // the pane does paint around the change, and no panel of commentary is
  // invented to explain it.
  assert.match(orient, /const fold = wide\.new \? 'new' : \(wide\.old \? 'old' : null\);/, 'no fold worth making means no fold');
  assert.match(orient, /selectionAttempt\(wanted, c\)/, 'the stage returns to the arrangement the reader chose');
  assert.doesNotMatch(app, /paneNoteFor|setPaneNote|clearPaneNotes|does not paint the change/,
    'and no panel of commentary is drawn over the snapshot');
  assert.doesNotMatch(app, /hiddenConditionOf|widthConditionOf|hiddenControlLabel/,
    'the machinery that wrote that commentary is gone with it');
});

test('the reader\u2019s own arrangement is never rearranged by a click', () => {
  // Hiding a snapshot by hand is a decision, not a question: a selection made
  // while the reader has one pane folded is answered in the pane they kept.
  assert.match(orient, /if \(manualPane \|\| !measure\) \{/, 'a hand-made fold is left alone');
  assert.match(orient, /const measure = !\(opts && opts\.measure === false\);/);
  assert.match(applyReveals, /orientStageForSelection\(c, \{ measure: !!scroll \}\)/,
    'and a restage after a resize only re-reads the arrangement it is in');
});

test('every pane on screen answers for the change; a folded pane is not judged', () => {
  // The side that paints the change scrolls to and lights the change; a side
  // the page keeps it shut in scrolls to the nearest thing it does paint (see
  // scrollTargetFor), so a click always moves and always marks something.
  assert.match(applyReveals, /if \(sides\.new && c\.newId\) jobs\.push/, 'the later snapshot answers for the change');
  assert.match(applyReveals, /if \(sides\.old && c\.oldId\) jobs\.push/);
  assert.match(applyReveals, /if \(!sidesNow\.old && !sidesNow\.new\)/, 'two folded panes have nothing to answer for');
  assert.match(applyReveals, /revealedFor = \{\n      change: c,\n      visibleOld/,
    'what the selection was measured against is recorded for the restage');
});

test('no panel of invented commentary is drawn over a snapshot', () => {
  // What the owner never asked for and had to look at twice: a card over the
  // page explaining why the change is not painted at this width. The answer to
  // that question is the fold above; nothing is explained away.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'compare.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(html, /pane-note|paneOldNote|paneNewNote/, 'no note element in the pane');
  assert.doesNotMatch(css, /pane-note/, 'and no styles waiting for one');
});

test('the visible copy of a change is the one marked', () => {
  // A nav is often shipped twice, once for wide screens and once for a phone
  // drawer. The marked copy can be the hidden one while the same link is on
  // screen: that copy is the change as the page ships it.
  assert.match(shownIn, /nodeShowsItself\(findInPane\(iframe, id\)\)/, 'the marked node is asked first');
  assert.match(shownIn, /findVisibleEquivalent\(iframe, change, side\)/, 'then a real copy on screen');
  assert.match(shownIn, /isDisplayedInPane\(twin\)/, 'which has to be painted to count');
});

test('visibility is judged through every ancestor, not just the node', () => {
  // The case this exists for: a link that exists in both snapshots, in a
  // desktop navbar that is `display: none` at a phone width. Its own computed
  // style says nothing; the navbar above it is what hides it.
  assert.match(shows, /getClientRects\(\)/, 'a node with no box at all paints nothing');
  assert.match(shows, /cs\.display === 'none'/, 'an ancestor\u2019s display is checked');
  assert.match(shows, /cs\.visibility === 'hidden'/, 'and its visibility, which still leaves a box');
  assert.match(shows, /Number\(cs\.opacity\) === 0/, 'and opacity, which also still leaves a box');
  assert.match(shows, /depth < 40/, 'the walk is bounded');
});

test('a click during the snapshot\u2019s own parse still ends marked', () => {
  // The marks are placed into whatever document exists at the click; when the
  // pane's document is still arriving (or is replaced by the parse), the
  // selection has to be staged again the moment the pane is really there.
  const restage = fn(app, 'restageSelectionForPaneLoad');
  assert.match(ready, /restageSelectionForPaneLoad\(\)/, 'a pane that becomes ready restages the selection');
  assert.match(restage, /applySelectionReveals\(c, true\)/, 'the same pass a fresh click runs');
  assert.match(restage, /if \(!selectedRowEl \|\| !revealedFor \|\| !revealedFor\.change\) return;/,
    'and nothing happens when no row is selected');
});

test('a scroll only counts when the pane or the element actually moves', () => {
  // Archived pages keep a wrapper that reports a huge scrollHeight and takes
  // no scroll position, and a root turned overflow:hidden ignores the
  // window's scrollTo while <html>.scrollTop still works. In both cases the
  // click looked like it ran and the element stayed where it was.
  const scroll = fn(app, 'scrollInnerCentered');
  assert.match(scroll, /moved = Math\.abs\(r2\.top - r\.top\) > 2/, 'the scroll is judged by where the element ended up');
  assert.match(scroll, /for \(const scroller of \[doc\.documentElement, doc\.body\]\)/, 'the element scrollers are the last resort');
  assert.match(scroll, /scroller\.scrollTop = top;/, 'set in person when the window call changed nothing');
});

test('a whole-box fallback is never a sliver', () => {
  // An empty <a> around a broken archived image keeps a 0x17 box, and a
  // screen-reader-only heading keeps a 1x1 one; lighting either instead of
  // the card that holds it marks nothing a reader can see.
  const target = fn(app, 'scrollTargetFor');
  const usable = fn(app, 'usableBox');
  const readable = fn(app, 'readableBox');
  assert.match(usable, /r\.width >= 12 && r\.height >= 12/, 'the floor is a real, if small, box');
  assert.match(readable, /r\.width >= 4 && r\.height >= 4/, 'and a readable one is a lower bar than a usable container');
  assert.match(target, /isDisplayedInPane\(n\) && usableBox\(n\)/, 'the ancestor walk skips slivers');
  assert.match(target, /if \(anyBox\) return settle\(anyBox\);/, 'and still has something to scroll to when every ancestor is small');
  // A pinned box cannot be scrolled to at all, so it never settles: the
  // overlay holding it is the answer (see the pinned test below).
  assert.match(target, /if \(!pinned && readableBox\(t\) && !isClippedOutOfPane\(t\)\) return t;/, 'the node the reader is shown must be readable');
});

test('a selection that found nothing to light is lit once the pane is there', () => {
  // The click's first pass runs two frames in. When the pane is still being
  // parsed - nytimes.com's 2026 front page took eight seconds to reach the
  // change the row named - there is nothing to scroll to and nothing to
  // light, and the watch loop is the only thing that can put a light on the
  // page afterwards. It used to place one only when an existing light had
  // moved away from the target, so "no light yet" was a permanent state: the
  // pane ended scrolled to the change with the change unmarked, which is the
  // other way a click reads as dead.
  assert.match(verify, /if \(!keepLit\) \{/, 'a light the first pass could not place is placed here');
  assert.match(verify, /try \{ highlightInPane\(s\); \}/, 'on the target the loop is scrolling to');
  assert.match(verify, /unhighlightInPane\(lit\)/, 'and only an existing light is taken off first');
  assert.match(verify, /if \(lit === s\) \{/, 'the same node off screen is a scroll to correct, not a light to re-place');
  // The window has to outlast a slow parse, not just an image landing.
  assert.match(verify, /Date\.now\(\) \+ 30000/, 'the loop keeps looking for thirty seconds');
});

test('a light that still means the change is left exactly where it is', () => {
  // nytimes.com's 2015 ad interstitial drifts a few pixels a second, so the
  // target it resolves to alternates between its button and the box around
  // it. Re-lighting on every difference made the badge jump (and the beacon
  // animate) on each poll. What decides is whether the light is still on
  // screen and still names this change, not whether it is the same node.
  assert.match(verify, /let keepLit = false;/);
  assert.match(verify, /doc\.contains\(lit\)\) && inView\(lit\.getBoundingClientRect\(\), vw, vh\)/,
    'a light out of the document or off screen is not kept');
  assert.match(verify, /lit === s \|\| \(lit\.contains && lit\.contains\(s\)\) \|\| \(s\.contains && s\.contains\(lit\)\)/,
    'the target, the box holding it, and the change inside the box all count as the same place');
});

test('a change pinned outside the pane is shown by its overlay', () => {
  // A position: fixed box cannot be scrolled to, so a button inside one that
  // the page parked past the right edge was corrected for thirty seconds
  // against a page that moved under it, and never came into view. The
  // overlay holding it is on screen and is where the change lives.
  const pinned = fn(app, 'pinnedOffscreen');
  const target = fn(app, 'scrollTargetFor');
  const showable = fn(app, 'showableAncestorFor');
  assert.match(pinned, /position \|\| ''/);
  assert.match(pinned, /pos === 'fixed'/);
  assert.match(pinned, /r\.right > 0 && r\.left < vw && r\.bottom > 0 && r\.top < vh/, 'anything on screen and the ordinary rules apply');
  assert.match(target, /const pinned = pinnedOffscreen\(t\);/, 'the target asks whether it can be reached at all');
  assert.match(target, /showableAncestorFor\(t, pinned\)/, 'and falls back to the overlay that holds it');
  assert.match(showable, /if \(fits && !anySize && paneW && paneH\)/, 'a pane-sized box is only rejected when the change can be shown another way');
});

test('a change the page rewrote away entirely is found again by its path', () => {
  // A page that rebuilds its own cards from scratch (nytimes.com's 2026
  // front page is React) leaves nothing the change says anywhere in the
  // document: no mark, and none of its words. What survives is the ancestor
  // path the diff recorded, so the card that holds the change is found by
  // that path and marked. The alternative is the click that marks nothing at
  // all, which is what the sweep kept catching on that page.
  const rescue = fn(app, 'rescueMarkedTarget');
  const byPath = fn(app, 'rescueByPath');
  assert.match(rescue, /const byPath = rescueByPath\(doc, change\);/, 'the path is the last resort after the words');
  assert.match(rescue, /if \(byPath\) return byPath;/, 'and answers when it finds the container');
  assert.match(rescue, /return rescueByNeighbour\(iframe, change, side\);/, 'a card that was rebuilt outright is answered by its neighbours');
  assert.doesNotMatch(rescue, /if \(!wantText && !wantFile\) return null;/, 'a change with no recorded words must still be findable');
  assert.match(byPath, /String\(change\.path \|\| ''\)\.split\('>'\)/, 'the stored path is the breadcrumb the engine wrote');
  assert.match(byPath, /const deepest = stored\[stored\.length - 1\];/, 'the deepest ancestor is what is looked for');
  assert.ok(byPath.includes('/#([^.\\s#]+)/'), 'its id, when it has one, is the discriminator');
  assert.match(byPath, /tail\.join\(' > '\) !== live\.join\(' > '\)/, 'and its own live ancestors must still answer to the stored path');
  // A nav holds a dozen links with the same shape, so the container that
  // holds the comparison's own marks is the card the change belongs to.
  assert.match(byPath, /node\.querySelector\('\[data-pdiff-id\]'\)/, 'a container holding a marked change is preferred');
  assert.match(byPath, /score > bestScore/, 'by score, not by document order');
  assert.match(byPath, /return best;/, 'and returned as the target');
  // Even the shape can be gone - a React front page drops the cards whose
  // data never arrived, classes and all - and then the change's neighbours
  // are the answer: the diff list is in page order, their marks are still on
  // the page, and the one sharing the most of this change's stored path is
  // the same region of the page.
  const neighbours = fn(app, 'rescueByNeighbour');
  assert.match(neighbours, /changes\.indexOf\(change\)/, 'the change is placed in the diff list\u2019s page order');
  assert.match(neighbours, /const depth = sharedPrefix\(c\.path\);/, 'neighbours are scored by how much of the path they share');
  assert.match(neighbours, /if \(depth > bestDepth\) \{ bestDepth = depth; best = node; \}/, 'the closest one wins');
  assert.match(neighbours, /!isDisplayedInPane\(node\) \|\| !usableBox\(node\)/, 'and only something the reader can be shown is accepted');
  assert.match(neighbours, /if \(bestDepth >= 2\) return best;/, 'the same card answers at once');
});

test('a target that is off screen is corrected on every pass, not only once the page holds still', () => {
  // The corrections used to wait for the pane's scroll position to repeat
  // across two polls before acting, on the theory that a smooth scroll was
  // in flight. Every scroll here is instant, so there was nothing to wait
  // for - and an archived page that moves its own document on every poll
  // (an anchor restored on load, a scroll-linked animation, a rail filling
  // in above the light) never repeated a position, so the correction never
  // ran: a change lit at y9211 in a 697px pane was still there after the
  // whole thirty-second window (measured on apple.com's 2026 footer).
  const afterInView = verify.slice(verify.indexOf('if (inView(r, vw, vh)) return;'));
  assert.doesNotMatch(afterInView, /seen\[/, 'no scroll-position memory gates the correction');
  assert.match(afterInView, /try \{ scrollInnerCentered\(s, \{ instant: true \}\); \}/, 'the correction is made there and then');
  assert.match(verify, /pending = true;/, 'and the loop keeps looking, so a later reflow is corrected too');
});

test('a rail that scrolls sideways is a scroller like any other', () => {
  // The scroller walk only ever looked for boxes taller than their frame, so
  // a card strip wider than its viewport was invisible to it: the page was
  // scrolled to the right row and the change stayed hanging off the side.
  const scroll = fn(app, 'scrollInnerCentered');
  assert.match(scroll, /scrollWidth > n\.clientWidth \+ 1/, 'a horizontal overflow is found too');
  assert.match(scroll, /entry\.canX/, 'and it is scrolled on its own axis');
  assert.match(scroll, /canReach\(box\.scrollWidth, box\.clientWidth, want\)/, 'only when its range reaches the change');
});

test('a box past an edge nothing can scroll toward is out of reach', () => {
  // nytimes.com's 2026 mini nav paints a section link at x -179 in a pane
  // parked at x 0: no ancestor clips it (every overflow is visible) and the
  // pane's only sideways room is to the right, so it is unreachable even
  // though it has a healthy box. Settling on it marked something nobody can
  // see, while the bar that holds it was right there on screen.
  const clipped = fn(app, 'isClippedOutOfPane');
  assert.match(clipped, /if \(end <= 0\) return \{ need: -end \+ near, back: true \};/, 'travel is measured from the near edge');
  assert.match(clipped, /const paneRoom = \(axis, back\) => \{/, 'the room is read in the direction the box lies');
  assert.match(clipped, /scrollerReaches\(axis, need, back\)/, 'an ancestor scroller counts as a way in');
  assert.match(clipped, /r\.left < 0 && r\.right <= 0/, 'a box entirely past the left edge is checked');
  assert.match(clipped, /r\.left >= vw/, 'and one entirely past the right edge');
  assert.match(fn(app, 'scrollTargetFor'), /showableAncestorFor\(t, pinned\)/, 'so the bar holding it becomes the target');
});

test('a light the reader cannot see is never called settled', () => {
  // The watch loop asks the viewport whether the target is on screen. With a
  // forty-pixel tolerance a change twenty-five pixels past the bottom of the
  // pane answered yes, so the loop stopped correcting and left the reader
  // looking at the gap under the light (measured on apple.com's card grid).
  assert.doesNotMatch(verify, /inView\(r, vw, vh, 40\)/, 'reaching into the frame is not being in it');
  assert.match(verify, /seenY >= Math\.min\(least, rect\.height\)/, 'what counts is the sliver actually on screen');
});

test('layout that arrives between two polls re-aims the selection', () => {
  // An image landing is what carries a settled light off screen; waiting for
  // the next one-second poll leaves the reader looking at the gap.
  assert.match(verify, /new win\.ResizeObserver/, 'the pane\u2019s own layout is watched');
  assert.match(verify, /aim\(false\)/, 'a size change re-aims');
  assert.match(verify, /ro\.disconnect\(\)/, 'and the observer lets go when the selection moves on');
});

test('the record can be walked with the keyboard, one change at a time', () => {
  // 349 rows is something a reader crosses, not something they hunt through
  // with a mouse: one keypress moves to the next row and aims it.
  const keys = fn(app, 'wireChangesListKeys');
  const list = fn(app, 'renderChangesList');
  assert.match(keys, /ArrowDown/, 'the arrow keys walk the record');
  assert.match(keys, /jumpToChange\(c\[idx\], next\)/, 'landing on a row picks it, the same way a click does');
  assert.match(keys, /e\.key === 'Escape'/, 'and Escape steps back out of the selection');
  assert.match(keys, /visibleRows\(\)/, 'filtered-out rows are skipped, so the keys promise what is seen');
  assert.match(list, /setAttribute\('tabindex', '0'\)/, 'the rows can take focus at all');
});
