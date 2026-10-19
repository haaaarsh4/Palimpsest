// test/reviveWidgets.test.js
//
// The repair two ways a capture arrived empty, pinned on the markup that was
// actually wrong in the record (settlement.org, 2016 through 2026) rather than on
// markup invented to suit the code.
//
// The two things worth guarding here are not the happy paths. They are:
//   - the window has to come out the same for a document prepared from the cached
//     form (no script left, so only the page's own current-slide marker to read)
//     as for one prepared from the network (configuration still in hand). Two
//     different windows for one record would show up in a film as a change that
//     never happened; and
//   - a second prepare of an already-prepared page must not wrap the slides again
//     or leave a second stylesheet behind, because that is how every cached row
//     gets repaired.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const { prepareCapture, PREPARE_VERSION } = require('../lib/prepareCapture');
const { reviveWidgets, readOwlConfig, REVIVE_STYLE_ID, REVIVED_CLASS } = require('../lib/reviveWidgets');

const MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

// The carousel band as the capture has it, with Jan marked current, which is
// where the month list is rotated to on a January capture, and why the marker and
// `startPosition: 6` agree.
function carouselHtml() {
  const slides = MONTHS.map((m) => `
    <div class="item" data-hash="${m}">
      <h3><a href="/web/20160109233100/http://settlement.org/page-${m}/">Story for ${m}</a></h3>
      <img alt="" src="/web/20160109233100im_/http://settlement.org/pics/${m}.png" class="content">
    </div>`).join('');
  const months = MONTHS.map((m) => `<a href="#${m}" class="button secondary url"><span${m === 'Jan' ? ' class="currentmonth"' : ''}>${m}</span></a>`).join('');
  return `<div id="slide-timeline"><h2>Daily Life</h2>
    <div class="owl-carousel">${slides}</div>
    <div class="owl-months">${months}</div></div>`;
}

const OWL_INIT = `
  <script type="text/javascript">
    $(document).ready(function () {
      $('.owl-carousel').owlCarousel({
        loop: false,
        margin: 10,
        responsive: { 0: { items: 1 }, 600: { items: 2 }, 1000: { items: 3 } },
        startPosition: 6,
        center: true,
        navContainer: '.owl-months',
      });
    });
  </script>`;

function page(body, head = '') {
  return `<!DOCTYPE html><html lang="en" class="no-js"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

function docOf(html) {
  return new JSDOM(html).window.document;
}

function revived(html, opts = {}) {
  const doc = docOf(html);
  const result = reviveWidgets(doc, { url: 'http://settlement.org/', timestamp: '20160109233100', ...opts });
  return { doc, result };
}

// The plan the stylesheet commits to, read back out of it: per breakpoint, how
// many slides are across and how far the track is pulled left, counted in slides.
// Those two numbers are the whole window, the slides on screen are `shift` up to
// `shift + items - 1`.
function ruleFromText(text) {
  return {
    items: Number(/--pal-n:(\d+)/.exec(text)[1]),
    shift: Number(/--pal-shift:(\d+)/.exec(text)[1]),
  };
}

function planFromCss(doc) {
  const css = doc.querySelector(`#${REVIVE_STYLE_ID}`).textContent;
  const firstMedia = css.indexOf('@media');
  const base = ruleFromText(css.slice(0, firstMedia < 0 ? css.length : firstMedia));
  const tiers = [...css.matchAll(/@media \(max-width:(\d+)px\)\{(.*?)\}\}/g)]
    .map((m) => ({ maxWidth: Number(m[1]), ...ruleFromText(m[2]) }));
  return { ...base, tiers };
}

// Which window a browser would be showing at a given width, straight out of the
// stylesheet's own rules, applied in cascade order the way a browser applies
// them. A narrower band must *replace* the wider one, not add to it, that is the
// failure this pins (see buildCss in lib/reviveWidgets.js).
function visibleFromCss(doc, width) {
  const plan = planFromCss(doc);
  let win = { items: plan.items, shift: plan.shift };
  for (const tier of plan.tiers) {
    if (width <= tier.maxWidth) win = { items: tier.items, shift: tier.shift };
  }
  return win;
}

// The slides on screen at a width, named the way the page names them.
function onScreenAt(doc, width) {
  const wraps = [...doc.querySelectorAll('.owl-carousel > .pal-track > .owl-item')];
  const { items, shift } = visibleFromCss(doc, width);
  return wraps.slice(shift, shift + items).map((w) => w.querySelector('.item').getAttribute('data-hash'));
}

test('the carousel is visible, and its slides are inside wrappers the site styles', () => {
  const { doc, result } = revived(page(carouselHtml(), OWL_INIT), { rawHtml: page(carouselHtml(), OWL_INIT) });
  const box = doc.querySelector('.owl-carousel');

  assert.equal(result.carousels, 1);
  // owl's stylesheet hides the container until the plugin adds this class.
  assert.ok(box.classList.contains('owl-loaded'), 'the plugin\'s own loaded class is what makes it visible');
  assert.ok(box.classList.contains(REVIVED_CLASS));
  // The site sizes and dims `.owl-item`, `.owl-carousel .owl-item` is in owl's
  // sheet and `#slide-timeline .owl-item` is in the site's.
  assert.equal(box.querySelectorAll(':scope > .pal-track > .owl-item').length, 12);
  assert.equal(box.querySelectorAll('.item').length, 12, 'every slide is still in the document');
});

test('each revived wrapper restates the plugin positioning contract', () => {
  // Owl's own stylesheet puts `position: relative` on its item wrappers,
  // and in-slide content hangs off it (a caption pinned absolute to the
  // slide's bottom edge). Without it that content positions against a
  // distant ancestor and lands outside its picture, a banner above the
  // image instead of across its foot. The rule names the plugin's
  // structure, never any one site.
  const { doc } = revived(page(carouselHtml(), OWL_INIT), { rawHtml: page(carouselHtml(), OWL_INIT) });
  const css = doc.querySelector(`style#${REVIVE_STYLE_ID}`).textContent;
  assert.match(css, /\.owl-carousel\.palimpsest-revived>\.pal-track>\.owl-item\{position:relative;\}/);
});

test('the window is three slides centered on the current one, two at 600px, one below', () => {
  const html = page(carouselHtml(), OWL_INIT);
  const { doc } = revived(html, { rawHtml: html });
  const plan = planFromCss(doc);
  // Jan is index 6 (0-based); three across centered on it starts at slide 5
  // (Dec), so the window is shift 5 for 3 slides.
  assert.deepEqual({ items: plan.items, shift: plan.shift }, { items: 3, shift: 5 });
  assert.deepEqual(plan.tiers, [
    { maxWidth: 999, items: 2, shift: 6 },
    { maxWidth: 599, items: 1, shift: 6 },
  ]);
});

test('the window holds the current slide at every width, centered at desktop width', () => {
  const html = page(carouselHtml(), OWL_INIT);
  const { doc } = revived(html, { rawHtml: html });
  // The three bands the plugin was configured for, and what each one shows.
  assert.deepEqual(onScreenAt(doc, 1442), ['Dec', 'Jan', 'Feb'], 'three across at desktop width');
  assert.deepEqual(onScreenAt(doc, 700), ['Jan', 'Feb'], 'two below 1000px');
  assert.deepEqual(onScreenAt(doc, 500), ['Jan'], 'one below 600px');
  // The current slide is on screen in every band, and in the middle of the
  // widest one, the plugin's `center: true`.
  for (const w of [1600, 1442, 1000, 999, 700, 600, 599, 500, 375]) {
    assert.ok(onScreenAt(doc, w).includes('Jan'), `${w}px shows the current slide`);
  }
  assert.equal(onScreenAt(doc, 1442)[1], 'Jan', 'and it is the middle slide there');
});

test('the ends of the run hold the window inside the run', () => {
  // The cache form on purpose: with no script left, the page's own marker is the
  // only statement of which slide is current, which is the case these ends are
  // about. (With the configuration present `startPosition` wins, as it should.)
  const at = (month) => {
    const markup = carouselHtml()
      .replace('class="currentmonth"', 'class="nothing"')
      .replace(`<span>${month}</span>`, `<span class="currentmonth">${month}</span>`);
    const html = page(markup);
    return revived(html, { rawHtml: html }).doc;
  };

  // First slide current: a centered window would start before it, so the shift is
  // pulled back to 0 at every width. The last is the mirror of that.
  assert.deepEqual(planFromCss(at('Jul')), { items: 3, shift: 0, tiers: [
    { maxWidth: 999, items: 2, shift: 0 },
    { maxWidth: 599, items: 1, shift: 0 },
  ] });
  assert.deepEqual(onScreenAt(at('Jul'), 1442), ['Jul', 'Aug', 'Sep']);
  // 12 slides, 3 across: the last shift that still fits is 9. Two across, 10; one
  // across, 11.
  assert.deepEqual(planFromCss(at('Jun')), { items: 3, shift: 9, tiers: [
    { maxWidth: 999, items: 2, shift: 10 },
    { maxWidth: 599, items: 1, shift: 11 },
  ] });
  assert.deepEqual(onScreenAt(at('Jun'), 1442), ['Apr', 'May', 'Jun']);
  assert.deepEqual(onScreenAt(at('Jun'), 500), ['Jun']);
});

test('the current slide is marked the way the site\'s own stylesheet reads it', () => {
  const html = page(carouselHtml(), OWL_INIT);
  const { doc } = revived(html, { rawHtml: html });
  const wrappers = [...doc.querySelectorAll('.owl-carousel > .pal-track > .owl-item')];
  const marked = wrappers.filter((w) => w.classList.contains('active') && w.classList.contains('center'));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].getAttribute('data-hash'), undefined, 'the wrapper is not the slide');
  assert.equal(marked[0].querySelector('.item').getAttribute('data-hash'), 'Jan');
});

test('a page prepared from the cache plans the same window as one prepared from the network', () => {
  // The network one: configuration present, so startPosition wins.
  const withScript = page(carouselHtml(), OWL_INIT);
  // The cached one: the script was stripped by the build that stored it, so the
  // only statement of what was current is the marker on the page.
  const fromCache = page(carouselHtml());
  const a = planFromCss(revived(withScript, { rawHtml: withScript }).doc);
  const b = planFromCss(revived(fromCache, { rawHtml: fromCache }).doc);
  assert.deepEqual(b, a);
  assert.deepEqual({ items: a.items, shift: a.shift }, { items: 3, shift: 5 });
});

test('the config is read out of the inline script', () => {
  const cfg = readOwlConfig(page(carouselHtml(), OWL_INIT));
  assert.deepEqual(cfg.items, [{ min: 0, items: 1 }, { min: 600, items: 2 }, { min: 1000, items: 3 }]);
  assert.equal(cfg.startPosition, 6);
  assert.equal(cfg.center, true);
  assert.equal(cfg.margin, 10);
  assert.equal(readOwlConfig('<html><body>no carousel here</body></html>'), null);
});

test('a carousel with no marker and no config shows the first window rather than nothing', () => {
  const bare = page('<div class="owl-carousel"><div class="item">One</div><div class="item">Two</div><div class="item">Three</div><div class="item">Four</div></div>');
  const { doc } = revived(bare, { rawHtml: bare });
  assert.deepEqual({ items: planFromCss(doc).items, shift: planFromCss(doc).shift }, { items: 3, shift: 0 });
  assert.ok(doc.querySelector('.owl-carousel').classList.contains('owl-loaded'));
});

test('one stylesheet, and re-preparing wraps nothing twice', () => {
  const html = page(carouselHtml(), OWL_INIT);
  const first = prepareCapture(html, { url: 'http://settlement.org/', timestamp: '20160109233100' });
  const second = prepareCapture(first, { url: 'http://settlement.org/', timestamp: '20160109233100' });

  // Counted by the element, not by the string: the id is also the stem of the
  // class every rule in the stylesheet is scoped to.
  assert.equal((second.match(new RegExp(`<style id="${REVIVE_STYLE_ID}"`, 'g')) || []).length, 1, 'one stylesheet, not two');
  const doc = docOf(second);
  assert.equal(doc.querySelectorAll('.pal-track').length, 1, 'the track is not nested in itself');
  assert.equal(doc.querySelectorAll('.pal-track > .owl-item').length, 12);
  assert.equal(doc.querySelectorAll('.owl-item > .owl-item').length, 0);
  assert.equal(planFromCss(doc).shift, 5, 'and the plan survives the second pass');

  // Idempotent means byte-identical, which is what lets a cached row be repaired
  // in place instead of refetched. It is also the check that the second pass
  // really did rebuild the plan rather than skip it: skipping would agree with
  // itself too, so the two are told apart by comparing against the pass that came
  // from the raw page, which is the one with the script to read.
  assert.equal(second, first);
  const third = prepareCapture(second, { url: 'http://settlement.org/', timestamp: '20160109233100' });
  assert.equal(third, second);
});

test('a row an older revision wrote comes out rebuilt, not left with its old window', () => {
  const html = page(carouselHtml(), OWL_INIT);
  const current = prepareCapture(html, { url: 'http://settlement.org/', timestamp: '20160109233100' });
  assert.match(current, /--pal-n:3;--pal-shift:5;/);

  // The shape revision 4 wrote into the record: the same wrappers, the same
  // markers, and a window stated as a negative margin on the track, the rule
  // that widened the track, moved every slide, and put Aug/Sep/Oct on screen
  // where the plugin showed Dec/Jan/Feb.
  const stale = current.replace(
    /(<style id="palimpsest-revive">)[^]*?(<\/style>)/,
    '$1' +
      '.owl-carousel.palimpsest-revived{display:block!important;overflow:hidden;}' +
      '.owl-carousel.palimpsest-revived>.pal-track{display:flex;}' +
      '.owl-carousel.palimpsest-revived>.pal-track>.owl-item{flex:0 0 calc(100%/var(--pal-n));}' +
      '.owl-carousel[data-pal="0"]{--pal-n:3;--pal-k:5;}' +
      '.owl-carousel[data-pal="0"]>.pal-track{margin-left:calc(-100%*var(--pal-k)/var(--pal-n));}' +
      '$2'
  );
  assert.match(stale, /margin-left/);

  // Re-prepared from the row itself, the way the server repairs a cached capture.
  const repaired = prepareCapture(stale, { url: 'http://settlement.org/', timestamp: '20160109233100' });
  assert.doesNotMatch(repaired, /margin-left/, 'the widening shift is gone, not carried forward');
  assert.doesNotMatch(repaired, /--pal-k/);
  const doc = docOf(repaired);
  assert.equal(doc.querySelectorAll('.pal-track').length, 1, 'one track, built from the slides');
  assert.equal(doc.querySelectorAll('.pal-track > .owl-item').length, 12, 'and one wrapper per slide, not a wrapper per wrapper');
  assert.equal(doc.querySelectorAll('.owl-item > .owl-item').length, 0);
  assert.deepEqual(onScreenAt(doc, 1442), ['Dec', 'Jan', 'Feb'], 'repaired to the window the plugin showed');
  assert.equal(repaired, current, 'and to the same document the current pipeline writes');
});

test('a lazy picture behind a 1x1 placeholder is given its real address', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAAMSURBVBhXY/j//z8ABf4C/qc1gYQAAAAASUVORK5CYII=';
  const html = page(`<img alt="" src="${pixel}" data-src="/Content/slider/pics/apr-tax-return.jpg" class="content">`);
  const { doc, result } = revived(html, { rawHtml: html });

  assert.equal(result.lazyImages, 1);
  const img = doc.querySelector('img');
  // The Archive rewrites `src` and `href` and leaves `data-src` alone, so the
  // address arrives root-relative; against this app's base that is a 404 on
  // web.archive.org. It is rewritten into the form the page's own tags use.
  assert.equal(img.getAttribute('src'), '/web/20160109233100im_/http://settlement.org/Content/slider/pics/apr-tax-return.jpg');
  assert.equal(img.getAttribute('data-src'), '/Content/slider/pics/apr-tax-return.jpg', 'the page keeps saying what it said');
});

test('the address resolves against the scheme-less key the record is kept under', () => {
  // This is the shape the running app passes: `normalizeInputUrl` drops the
  // scheme, so a relative address has no base to resolve against unless the
  // capture's own rewritten links say which one it was taken over. Without this,
  // the promotion silently did nothing in the app while passing against a
  // hand-written full URL.
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAMSURBVBhXY/j//z8ABf4C/qc1gYQAAAAASUVORK5CYII=';
  const html = page(
    '<div id="wrapper"><a href="/web/20261002005041/https://settlement.org/document.aspx">A page</a>' +
    '<a href="https://web.archive.org/web/20261002005041/https://www.facebook.com/Settlement.Org">Facebook</a>' +
    `<img src="${pixel}" data-src="/Content/slider/pics/apr-tax-return.jpg"></div>`
  );
  const doc = docOf(html);
  reviveWidgets(doc, { url: 'settlement.org', timestamp: '20261002005041' });
  // https, from the page's own link, not from the third-party one and not guessed.
  assert.equal(doc.querySelector('#wrapper img').getAttribute('src'), '/web/20261002005041im_/https://settlement.org/Content/slider/pics/apr-tax-return.jpg');
});

test('a picture that already has an address is left exactly as it was', () => {
  const html = page('<img src="/web/20160109233100im_/http://settlement.org/real.png" data-src="/other.png">');
  const { doc, result } = revived(html, { rawHtml: html });
  assert.equal(result.lazyImages, 0);
  assert.equal(doc.querySelector('img').getAttribute('src'), '/web/20160109233100im_/http://settlement.org/real.png');
});

test('a lazy picture that is only fetched near the viewport is fetched anyway', () => {
  const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const html = page(`<img src="${pixel}" data-src="https://settlement.org/a/photo.jpg" loading="lazy">`);
  const { doc } = revived(html, { rawHtml: html });
  assert.equal(doc.querySelector('img').getAttribute('loading'), 'eager');
  assert.equal(doc.querySelector('img').getAttribute('src'), '/web/20160109233100im_/https://settlement.org/a/photo.jpg');
});

test('a lazy srcset is rewritten with its width descriptors intact', () => {
  const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const html = page(`<img src="${pixel}" data-srcset="/a/small.jpg 480w, https://settlement.org/a/big.jpg 1200w">`);
  const { doc, result } = revived(html, { rawHtml: html });
  assert.equal(result.lazySrcsets, 1);
  assert.equal(
    doc.querySelector('img').getAttribute('srcset'),
    '/web/20160109233100im_/http://settlement.org/a/small.jpg 480w, /web/20160109233100im_/https://settlement.org/a/big.jpg 1200w'
  );
});

test('prepareCapture still does the things it did before, with the current revision', () => {
  const html = page(
    `<base href="https://web.archive.org/web/20160109233100/http://settlement.org/"><script>alert(1)</script>` +
    `<noscript><img src="fallback.png"></noscript><img src="/web/20160109233100im_/http://settlement.org/logo.png">` +
    carouselHtml() + '<div id="wm-ipp-base"></div>',
    '<link rel="stylesheet" href="/web/20160109233100cs_/http://settlement.org/Site.css">'
  );
  const out = prepareCapture(html, { url: 'http://settlement.org/', timestamp: '20160109233100' });

  assert.match(out, new RegExp(`<meta name="${'palimpsest-capture'}" content="${PREPARE_VERSION}">`));
  assert.doesNotMatch(out, /<script|<noscript/i, 'no script survives, which is also what the cache check reads');
  assert.doesNotMatch(out, /alert\(1\)/, 'the carousel config is read from the script, not kept in it');
  assert.doesNotMatch(out, /wm-ipp-base/, 'the toolbar is still gone');
  assert.equal((out.match(/<base /g) || []).length, 1);
  assert.match(out, /<base href="https:\/\/web\.archive\.org\/web\/20160109233100\/http:\/\/settlement\.org\/"/);
  assert.match(out, /class="owl-carousel[^"]*owl-loaded/);
});
