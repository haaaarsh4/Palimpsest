const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Reveal = require('../public/reveal.js');

function docFrom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${html}</body></html">`.replace('</html">', '</html>'));
  return { doc: dom.window.document, win: dom.window };
}

const DROPDOWN = `
<style>
  ul#sub-nav { display: none; }
  li.top:hover > ul#sub-nav { display: block; }
</style>
<ul><li class="top"><a href="/services">Services</a>
<ul id="sub-nav"><li class="item-primary"><a href="/search">Search</a></li></ul>
</li></ul>`;

describe('reveal engine', () => {
  it('finds the exact hiding rule for a dropdown item', () => {
    const { doc, win } = docFrom(DROPDOWN);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    assert.equal(a.visible, false);
    assert.equal(a.hiddenDesc, 'ul#sub-nav');
    assert.equal(a.hidingRule.selectorText, 'ul#sub-nav');
    assert.equal(a.hidingRule.declaration, 'display: none');
  });

  it('finds the exact reveal rule and names the trigger', () => {
    const { doc, win } = docFrom(DROPDOWN);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    assert.ok(a.best, 'expected a reveal candidate');
    assert.match(a.best.selectorText, /hover/);
    assert.ok(a.best.declarations.some((d) => /^display:\s*block/.test(d)));
    assert.equal(a.best.trigger.label, 'Services');
  });

  it('applying the reveal changes exactly the computed display', async () => {
    const { doc, win } = docFrom(DROPDOWN);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    const before = win.getComputedStyle(doc.querySelector('ul#sub-nav')).display;
    assert.equal(before, 'none');
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt);
    assert.equal(receipt.generic, false, 'must use the rule declarations, not a generic override');
    assert.ok(receipt.changed.some((c) => c === 'display: none → block'), `got ${JSON.stringify(receipt.changed)}`);
    await receipt.undo();
    assert.equal(win.getComputedStyle(doc.querySelector('ul#sub-nav')).display, 'none');
  });

  it('handles the .open state-class pattern', async () => {
    const { doc, win } = docFrom(`
      <style>.modal { display: none; } .modal.open { display: block; }</style>
      <div class="modal"><p>Hello</p></div>`);
    const a = Reveal.analyze(doc, doc.querySelector('.modal p'), [], win);
    assert.equal(a.visible, false);
    assert.ok(a.best);
    assert.match(a.best.selectorText, /\.modal\.open/);
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt.changed.some((c) => c === 'display: none → block'));
    await receipt.undo();
  });

  it('reports the media condition on a responsive hiding rule', () => {
    const { doc, win } = docFrom(`
      <style>@media (max-width: 700px) { .drawer { display: none; } }</style>
      <div class="drawer"><p>Menu</p></div>`);
    // jsdom evaluates the media query against its default viewport; force the
    // hiding the way a narrow browser would, then check the rule is reported
    // with its condition attached.
    const found = Reveal.hidingRule(doc, doc.querySelector('.drawer'), []);
    assert.ok(found);
    assert.match(found.mediaText, /max-width/);
  });

  it('says plainly when no rule reveals it (JS-driven)', () => {
    const { doc, win } = docFrom(`
      <style>.tip { display: none; }</style>
      <div class="tip"><p>Secret</p></div>`);
    const a = Reveal.analyze(doc, doc.querySelector('.tip p'), [], win);
    assert.equal(a.visible, false);
    assert.equal(a.best, null);
    assert.match(Reveal.sentence(a, ''), /no stylesheet rule reveals it/);
  });

  it('climbs inherited visibility to the ancestor that sets it', async () => {
    const { doc, win } = docFrom(`
      <style>.sub { visibility: hidden; } .menu li:hover .sub { visibility: visible; }</style>
      <ul class="menu"><li class="top"><a href="/s">Services</a>
      <ul class="sub"><li><a href="/q">Search</a></li></ul></li></ul>`);
    const a = Reveal.analyze(doc, doc.querySelector('.sub a'), [], win);
    assert.equal(a.visible, false);
    // Not the link: the ul carries the hiding rule.
    assert.equal(a.hiddenDesc, 'ul.sub');
    assert.equal(a.hidingRule.selectorText, '.sub');
    assert.ok(a.best, 'expected the :hover counterpart');
    assert.equal(a.best.trigger.label, 'Services');
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt.changed.some((c) => c === 'visibility: hidden → visible'));
    await receipt.undo();
  });

  it('names the display:none ancestor when the target computes visible', () => {
    const { doc, win } = docFrom(`
      <style>.drawer { display: none; } .drawer.open { display: block; }</style>
      <div class="drawer"><p>Menu item</p></div>`);
    const a = Reveal.analyze(doc, doc.querySelector('.drawer p'), [], win);
    assert.equal(a.visible, false);
    assert.equal(a.hiddenDesc, 'div.drawer');
    assert.ok(a.best);
    assert.match(a.best.selectorText, /\.drawer\.open/);
  });

  it('calls a visible element visible', () => {
    const { doc, win } = docFrom('<p>Just text</p>');
    assert.equal(Reveal.analyze(doc, doc.querySelector('p'), [], win).visible, true);
  });

  it('restages the hover so the revealed subtree looks hovered, not unstyled', async () => {
    // The settlement.org shape: the opener only flips visibility, while the
    // green wash and the item text live in sibling rules under the same
    // :hover. Showing visibility alone is the ghost-white dropdown.
    const { doc, win } = docFrom(`
      <style>
        .sub { position: absolute; visibility: hidden; }
        .submenu li:hover .sub { visibility: visible; background-color: #060; color: #fff; }
        .submenu li:hover .sub li a { color: #fff; }
      </style>
      <ul class="submenu"><li class="top"><a href="/s">Services</a>
      <ul class="sub"><li><a href="/q">Search</a></li></ul></li></ul>`);
    const target = doc.querySelector('.sub a');
    const a = Reveal.analyze(doc, target, [], win);
    assert.equal(a.visible, false);
    assert.ok(a.best && a.best.interactive, 'expected the :hover opener');
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt);
    assert.equal(receipt.simulated, true, 'hover must be restaged, not just unhidden');
    const sub = doc.querySelector('ul.sub');
    assert.equal(win.getComputedStyle(sub).visibility, 'visible');
    assert.equal(win.getComputedStyle(sub).backgroundColor, 'rgb(0, 102, 0)');
    assert.equal(win.getComputedStyle(target).color, 'rgb(255, 255, 255)');
    // The hovered ancestor wears the marker; nothing else on the page does.
    const marked = doc.querySelectorAll('.pdiff-sim-hover');
    assert.equal(marked.length, 1);
    assert.equal(marked[0].tagName, 'LI');
    const simStyle = doc.querySelector('style[data-pdiff-reveal="sim-hover"]');
    assert.ok(simStyle, 'cloned hover rules must be injected');
    assert.match(simStyle.textContent, /li\.pdiff-sim-hover/);
    assert.doesNotMatch(simStyle.textContent, /:hover/);
    await receipt.undo();
    assert.equal(win.getComputedStyle(sub).visibility, 'hidden');
    assert.equal(doc.querySelectorAll('.pdiff-sim-hover').length, 0);
    assert.equal(doc.querySelector('style[data-pdiff-reveal="sim-hover"]'), null);
  });

  it('adds the state class for a state-class reveal and removes it on undo', async () => {
    const { doc, win } = docFrom(`
      <style>.modal { display: none; } .modal.open { display: block; }</style>
      <div class="modal"><p>Hello</p></div>`);
    const a = Reveal.analyze(doc, doc.querySelector('.modal p'), [], win);
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt.simulated, 'state class must be staged');
    assert.ok(doc.querySelector('.modal').classList.contains('open'));
    await receipt.undo();
    assert.ok(!doc.querySelector('.modal').classList.contains('open'));
    assert.equal(win.getComputedStyle(doc.querySelector('.modal')).display, 'none');
  });

  it('clones carry absolute background addresses from the origin sheet', () => {
    const css = Reveal.cloneCssForSim([{
      selectorText: '.submenu li:hover .sub',
      cssText: '.submenu li:hover .sub { visibility: visible; background-image: url("../images/bg-dropdownmenu.png"); }',
      mediaText: '',
      href: 'https://web.archive.org/web/2026/https://settlement.org/content/site.css',
    }]);
    assert.match(css, /\.pdiff-sim-hover/);
    assert.doesNotMatch(css, /:hover/);
    assert.match(css, /url\("https:\/\/web\.archive\.org\/web\/2026\/https:\/\/settlement\.org\/images\/bg-dropdownmenu\.png"\)/);
  });

  it('a clone never turns a plain sibling selector into a global rule', () => {
    // settlement.org's 2015 stylesheet has `a:link, a:hover { ... }`. The
    // clone named only the hover, but the untouched `a:link` sibling came
    // with it and, injected last, outranked `.btn-cta`: the hero's two CTAs
    // lost their white background, their arrow sprite and their
    // text-decoration the moment a nav row was selected. Only selectors that
    // actually name an interaction may be restaged, and only with the marker.
    const css = Reveal.cloneCssForSim([{
      selectorText: 'a:link, a:hover',
      cssText: 'a:link, a:hover { background: transparent; color: #333; text-decoration: underline; }',
      mediaText: '',
    }]);
    assert.equal(css.trim(),
      'a.pdiff-sim-hover { background: transparent; color: #333; text-decoration: underline; }');
    assert.doesNotMatch(css, /a:link/, 'the non-hover sibling is not cloned');
    assert.doesNotMatch(css, /(^|[\s,}])a\s*\{/, 'and no bare element selector survives');
    // The same for a mixed list where the plain selector is the useful bit
    // for another state: it still has no business being restaged.
    const mixed = Reveal.cloneCssForSim([{
      selectorText: '.menu li:hover .sub, .btn',
      cssText: '.menu li:hover .sub, .btn { display: block; }',
      mediaText: '',
    }]);
    assert.equal(mixed.trim(), '.menu li.pdiff-sim-hover .sub { display: block; }');
  });

  it('clones leave absolute and data addresses alone, and keep @media', () => {
    const css = Reveal.cloneCssForSim([{
      selectorText: '.m li:hover .sub',
      cssText: '.m li:hover .sub { background-image: url("https://cdn/x/bg.png"); list-style-image: url("data:image/gif;base64,AA"); }',
      mediaText: '(max-width: 700px)',
      href: 'https://web.archive.org/web/2026/https://example.org/s.css',
    }]);
    assert.match(css, /@media \(max-width: 700px\)/);
    assert.match(css, /url\("https:\/\/cdn\/x\/bg\.png"\)/);
    assert.match(css, /data:image\/gif/);
  });

  it('collects hover background addresses for early warming', () => {
    const { doc } = docFrom(`
      <style>
        .sub { visibility: hidden; }
        .submenu li:hover .sub { visibility: visible; background-image: url("https://cdn/x/bg.png"); }
        .plain { background-image: url("https://cdn/x/other.png"); }
      </style>
      <ul class="submenu"><li><a>Services</a><ul class="sub"><li><a>Search</a></li></ul></li></ul>`);
    const urls = Reveal.collectBackgroundUrls(doc, []);
    assert.ok(urls.includes('https://cdn/x/bg.png'), `got ${JSON.stringify(urls)}`);
    assert.ok(!urls.includes('https://cdn/x/other.png'), 'non hover rules stay out');
  });

  it('resolves hydrated relative addresses against the proxied sheet', () => {
    const { doc } = docFrom('<div></div>');
    const urls = Reveal.collectBackgroundUrls(doc, [{
      list: [{
        selectorText: '.submenu li:hover .sub',
        style: {},
        cssText: '.submenu li:hover .sub { background-image: url("../images/bg.png"); }',
      }],
      href: 'https://web.archive.org/web/2026/https://settlement.org/content/site.css',
    }]);
    assert.ok(urls.includes('https://web.archive.org/web/2026/https://settlement.org/images/bg.png'), `got ${JSON.stringify(urls)}`);
  });

  it('refuses a viewport-gated hiding instead of forcing it open', async () => {
    const { doc, win } = docFrom(`
      <style>@media (max-width: 767px) { .nav-primary { display: none; } }</style>
      <ul class="nav-primary" style="display: none"><li><a href="/n">News</a></li></ul>`);
    const a = Reveal.analyze(doc, doc.querySelector('.nav-primary a'), [], win);
    assert.equal(a.visible, false);
    assert.equal(a.responsive, true);
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt);
    assert.equal(receipt.refused, 'responsive');
    assert.equal(win.getComputedStyle(doc.querySelector('.nav-primary')).display, 'none');
    assert.equal(doc.querySelector('style[data-pdiff-reveal]'), null);
    await receipt.undo();
  });

  it('names the widths for a responsive hiding, in plain words', () => {
    const { doc, win } = docFrom(`
      <style>@media (max-width: 767px) { .nav-primary { display: none; } }</style>
      <ul class="nav-primary" style="display: none"><li><a href="/n">News</a></li></ul>`);
    const a = Reveal.analyze(doc, doc.querySelector('.nav-primary a'), [], win);
    const s = Reveal.sentence(a, 'Later snapshot');
    assert.match(s, /screens 767px wide or narrower/);
    assert.match(s, /shown on wider screens, not missing/);
    assert.doesNotMatch(s, /plain override/);
  });

  it('describes min and ranged widths without guessing', () => {
    assert.equal(Reveal.describeWidths('(min-width: 1024px)'), 'screens 1024px wide or wider');
    assert.equal(Reveal.describeWidths('screen and (min-width: 500px) and (max-width: 900px)'), 'screens between 500px and 900px wide');
    assert.equal(Reveal.describeWidths('(orientation: portrait)'), 'certain screen sizes');
  });

  it('a reveal opens with the unfold animation and settles shut on undo', async () => {
    const { doc, win } = docFrom(DROPDOWN);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt);
    const node = doc.querySelector('ul#sub-nav');
    assert.ok(doc.querySelector('style[data-pdiff-reveal-anim]'), 'the unfold keyframes must be injected');
    assert.ok(node.classList.contains('pdiff-reveal-in'), 'opening must wear the unfold class');
    await receipt.undo();
    assert.ok(!node.classList.contains('pdiff-reveal-in'));
    assert.ok(!node.classList.contains('pdiff-reveal-out'));
    assert.equal(win.getComputedStyle(node).display, 'none');
  });

  it('a close scheduled by an older reveal never tears down a newer one', async () => {
    const { doc, win } = docFrom(DROPDOWN);
    const target = doc.querySelector('li.item-primary a');
    // One analysis, applied twice: re-analyzing after the first reveal
    // would report the node visible and refuse to reveal it again.
    const a = Reveal.analyze(doc, target, [], win);
    const first = Reveal.applyReveal(doc, win, a);
    assert.ok(first);
    const node = doc.querySelector('ul#sub-nav');
    const second = Reveal.applyReveal(doc, win, a);
    assert.ok(second);
    await first.undo();
    // The stale close stands down: the newer reveal still holds the node open.
    assert.equal(win.getComputedStyle(node).display, 'block');
    await second.undo();
    assert.equal(win.getComputedStyle(node).display, 'none');
  });

  it('a JS-driven open still restages the hover styling (no white dropdown)', async () => {
    const { doc, win } = docFrom(`
      <style>
        ul#sub-nav { display: none; }
        li.top:hover ul#sub-nav li a { background: green; color: white; }
      </style>
      <ul><li class="top"><a href="/services">Services</a>
      <ul id="sub-nav"><li class="item-primary"><a href="/search">Search</a></li></ul>
      </li></ul>`);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    assert.equal(a.visible, false);
    assert.equal(a.best, null, 'background-only hover rules must not count as an opener');
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt, 'the generic open must still stand');
    assert.equal(receipt.generic, true);
    assert.equal(receipt.simulated, true, 'hover styling must be restaged even with no opener');
    assert.ok(doc.querySelector('style[data-pdiff-reveal="sim-hover"]'), 'the cloned hover styling must be injected');
    assert.equal(win.getComputedStyle(doc.querySelector('ul#sub-nav')).display, 'block');
    await receipt.undo(true);
    assert.equal(doc.querySelector('style[data-pdiff-reveal="sim-hover"]'), null);
    assert.equal(win.getComputedStyle(doc.querySelector('ul#sub-nav')).display, 'none');
  });

  it('opens every hidden level a JS-driven menu keeps its item behind', async () => {
    // The drawer is display:none and the submenu inside it is
    // visibility:hidden, each from its own rule, and nothing in a stylesheet
    // says how the script opens either one. Clearing only the topmost node
    // left the link exactly as invisible, the caller judged the reveal a
    // half-reveal and undid it, and picking the row did nothing at all.
    const { doc, win } = docFrom(`
      <style>
        .nav-responsive-1 { display: none; }
        ul#sub-nav { visibility: hidden; }
      </style>
      <div class="nav-responsive-1"><ul class="menu submenu"><li class="top-1"><a href="/s">Services</a>
      <ul id="sub-nav"><li class="item-primary"><a href="/news">News</a></li></ul>
      </li></ul></div>`);
    const target = doc.querySelector('li.item-primary a');
    const a = Reveal.analyze(doc, target, [], win);
    assert.equal(a.visible, false);
    assert.equal(a.hiddenDesc, 'div.nav-responsive-1', 'the outermost hider is still what gets named');
    assert.equal(a.best, null, 'no stylesheet rule opens it: this is the JS-driven case');
    const receipt = Reveal.applyReveal(doc, win, a);
    assert.ok(receipt);
    assert.equal(receipt.generic, true);
    // Both levels are open, so the item itself is visible - not just its box.
    const cs = win.getComputedStyle(target);
    assert.notEqual(cs.display, 'none', 'the link itself is laid out');
    assert.equal(cs.visibility, 'visible', 'the inner submenu was lifted too');
    assert.equal(win.getComputedStyle(doc.querySelector('.nav-responsive-1')).display, 'block');
    assert.equal(win.getComputedStyle(doc.querySelector('ul#sub-nav')).visibility, 'visible');
    await receipt.undo(true);
    assert.equal(win.getComputedStyle(doc.querySelector('.nav-responsive-1')).display, 'none');
    assert.equal(win.getComputedStyle(doc.querySelector('ul#sub-nav')).visibility, 'hidden');
    assert.equal(target.getAttribute('style'), null, 'the link itself is put back exactly as it was');
  });

  it('writes one exact sentence with selectors and trigger', () => {
    const { doc, win } = docFrom(DROPDOWN);
    const a = Reveal.analyze(doc, doc.querySelector('li.item-primary a'), [], win);
    const s = Reveal.sentence(a, 'Later snapshot');
    assert.match(s, /ul#sub-nav \{ display: none \}/);
    assert.match(s, /Services/);
    assert.match(s, /display: block/);
    assert.doesNotMatch(s, /most likely|maybe|probably/i);
  });
});

describe('forcing the exact change on screen', () => {
  it('opens the change\u2019s own hidden copy, not a menu beside it', () => {
    // The settlement.org 2015 shape: "Activity" lives in a second copy of
    // the nav that is display:none at every width. There is no opener rule
    // and no dropdown contains it, so the only truthful answer is to open
    // that copy and mark the link itself.
    const { doc, win } = docFrom(`
      <style>.nav-responsive-1 { display: none; }</style>
      <header><nav class="nav-responsive-1"><ul><li><a id="act" href="/activity">Activity</a></li></ul></nav>
      <nav><ul><li><a href="/services">Services</a><ul id="sub" style="display:none"><li>News</li></ul></li></ul></nav></header>`);
    const target = doc.getElementById('act');
    const receipt = Reveal.forceReveal(doc, win, target);
    assert.ok(receipt && receipt.forced);
    assert.equal(win.getComputedStyle(doc.querySelector('.nav-responsive-1')).display, 'block',
      'the hidden copy itself comes back');
    assert.equal(win.getComputedStyle(doc.querySelector('#sub')).display, 'none',
      'nothing else is opened');
    assert.equal(target.getAttribute('style'), null, 'the link is marked where it was captured');
    receipt.undo();
    assert.equal(win.getComputedStyle(doc.querySelector('.nav-responsive-1')).display, 'none');
  });

  it('lifts every visible-suppressing level of the chain', () => {
    const { doc, win } = docFrom(`
      <div style="visibility:hidden"><div style="opacity:0"><a id="x">Activity</a></div></div>`);
    const receipt = Reveal.forceReveal(doc, win, doc.getElementById('x'));
    assert.ok(receipt);
    assert.equal(win.getComputedStyle(doc.getElementById('x')).visibility, 'visible');
    // jsdom does not inherit opacity into computed style, so the setter is
    // the level to read.
    assert.equal(doc.querySelector('div div').style.opacity, '1');
    receipt.undo();
    assert.equal(win.getComputedStyle(doc.getElementById('x')).visibility, 'hidden');
  });

  it('opens [hidden], a closed details, and a zero-height overflow clip', () => {
    const { doc, win } = docFrom(`
      <div hidden><details><div style="max-height:0;overflow:hidden"><span id="x">News</span></div></details></div>`);
    const receipt = Reveal.forceReveal(doc, win, doc.getElementById('x'));
    assert.ok(receipt);
    const outer = doc.querySelector('body > div');
    assert.equal(outer.hasAttribute('hidden'), false, 'the hidden attribute is what was holding it');
    assert.equal(doc.querySelector('details').open, true, 'the details is opened');
    const clip = doc.querySelector('details div');
    assert.match(clip.getAttribute('style'), /max-height:\s*(initial|none)/);
    assert.match(clip.getAttribute('style'), /overflow:\s*visible/);
    receipt.undo();
    assert.equal(outer.hasAttribute('hidden'), true);
    assert.equal(doc.querySelector('details').open, false);
    assert.match(clip.getAttribute('style'), /max-height:\s*0/);
  });

  it('lifts an off-canvas drawer and a clipped screen-reader-only box', () => {
    const { doc, win } = docFrom(`
      <div id="drawer" style="position:absolute;left:-9999px"><a id="x">Activity</a></div>
      <div id="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"><span id="y">News</span></div>`);
    const drawer = Reveal.forceReveal(doc, win, doc.getElementById('x'));
    assert.ok(drawer);
    assert.match(doc.getElementById('drawer').getAttribute('style'), /left:\s*auto/);
    assert.match(doc.getElementById('drawer').getAttribute('style'), /position:\s*static/);
    drawer.undo();
    assert.match(doc.getElementById('drawer').getAttribute('style'), /left:\s*-9999px/);

    const sr = Reveal.forceReveal(doc, win, doc.getElementById('y'));
    assert.ok(sr);
    assert.match(doc.getElementById('sr').getAttribute('style'), /width:\s*(initial|auto)/);
    assert.match(doc.getElementById('sr').getAttribute('style'), /height:\s*(initial|auto)/);
    assert.match(doc.getElementById('sr').getAttribute('style'), /overflow:\s*visible/);
    sr.undo();
    assert.match(doc.getElementById('sr').getAttribute('style'), /width:\s*1px/);
    assert.match(doc.getElementById('sr').getAttribute('style'), /overflow:\s*hidden/);
  });

  it('leaves a menu the page itself has opened exactly as it is', () => {
    // The settlement.org shape: hovering Services opens `ul.sub`, which is
    // absolutely positioned under the nav. Its wrapper is height:0 by design
    // (the items float), and its hidden state parks it off screen. Once the
    // page's own hover has made the link visible, the forced layer must not
    // revert that height or static-ise the positioning: doing so turns a
    // compact dropdown into a full-width panel over the page.
    const { doc, win } = docFrom(`
      <div class="primary-menu" style="height:0">
        <ul class="sub" style="position:absolute;left:-9999px;visibility:hidden">
          <li><a id="news">News</a></li>
        </ul>
      </div>`);
    const sub = doc.querySelector('ul.sub');
    // The page's own hover, restaged: visible and placed under the nav.
    sub.style.visibility = 'visible';
    sub.style.left = '280px';
    const link = doc.getElementById('news');
    link.getBoundingClientRect = () => ({ width: 70, height: 51, left: 280, top: 50, right: 350, bottom: 101, x: 280, y: 50, toJSON() {} });
    assert.equal(Reveal.forceReveal(doc, win, link), null, 'nothing is forced over a menu already on screen');
    assert.match(sub.getAttribute('style'), /position:\s*absolute/);
    assert.match(sub.getAttribute('style'), /left:\s*280px/);
    assert.match(doc.querySelector('.primary-menu').getAttribute('style'), /height:\s*0/);
  });

  it('leaves a genuinely painted change exactly alone', () => {
    const { doc, win } = docFrom('<p id="x">Just text</p>');
    assert.equal(Reveal.forceReveal(doc, win, doc.getElementById('x')), null);
  });
});
