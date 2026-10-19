// test/injectedStylesheets.test.js
//
// A capture that loads its widget CSS from a script (the loadCSS pattern:
// document.createElement('link') + l.href = '....css' on rAF/load) renders
// wrong in the panes, because nothing here runs a capture's JavaScript and
// the links are never created. prepareCapture materializes them as real
// <link> elements before the scripts are stripped.
//
// The fixture below is the shape of settlement.org's carousel loader: three
// plugin stylesheets injected at runtime, plus the older path surviving in a
// comment. Without materialization the `.item h3 { position: absolute }`
// overlay rule never applies and every slide caption sits above its picture.

const test = require('node:test');
const assert = require('node:assert');

const { prepareCapture, PREPARE_VERSION } = require('../lib/prepareCapture');

const TS = '20261002005041';
const URL = 'https://settlement.org/';

function fixture(extraHead = '') {
  return `<!DOCTYPE html><html><head><title>t</title>${extraHead}</head><body>
<script>
    var cb = function () {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        //l.href = '/Scripts/owl/assets/owl.carousel.min.css';
        l.href = '/sandbox/OwlCarousel2-2.3.4/dist/assets/owl.carousel.min.css';
        l.type = 'text/css';
        var h = document.getElementsByTagName('head')[0];
        h.parentNode.insertBefore(l, h);
        var lc = document.createElement('link');
        lc.rel = 'stylesheet';
        lc.type = 'text/css';
        lc.href = '/sandbox/OwlCarousel2-2.3.4/dist/assets/owl.carousel-custom.css';
        h.parentNode.insertBefore(lc, h);
    };
    var raf = requestAnimationFrame || mozRequestAnimationFrame;
    if (raf) raf(cb);
    else window.addEventListener('load', cb);
</script>
<script>var x = '/content/not-a-loader.css';</script>
</body></html>`;
}

test('loader-injected stylesheets become real links to the archived copies', () => {
  const html = prepareCapture(fixture(), { url: URL, timestamp: TS });
  assert.ok(
    html.includes(
      `<link rel=\"stylesheet\" href=\"https://web.archive.org/web/${TS}cs_/https://settlement.org/sandbox/OwlCarousel2-2.3.4/dist/assets/owl.carousel.min.css\">`
    ),
    'the plugin stylesheet must be linked'
  );
  assert.ok(
    html.includes('owl.carousel-custom.css'),
    'the overlay-rule stylesheet must be linked'
  );
  // Order between the injected links follows the loader script.
  assert.ok(
    html.indexOf('owl.carousel.min.css') < html.indexOf('owl.carousel-custom.css'),
    'injected links keep loader order'
  );
});

test('commented-out and non-loader stylesheet addresses are left alone', () => {
  const html = prepareCapture(fixture(), { url: URL, timestamp: TS });
  assert.ok(
    !html.includes('/Scripts/owl/assets/owl.carousel.min.css'),
    'the commented-out older path must not be materialized'
  );
  assert.ok(
    !html.includes('not-a-loader.css'),
    'a script that never builds a link element must not sprout one'
  );
});

test('an already-linked stylesheet is not linked twice', () => {
  const staticLink =
    `<link href=\"/web/${TS}cs_/https://settlement.org/content/site.css\" rel=\"stylesheet\">`;
  const html = prepareCapture(fixture(staticLink), { url: URL, timestamp: TS });
  const count = html.split('content/site.css').length - 1;
  assert.equal(count, 1, 'the static link must appear exactly once');
});

test('materialization still strips every script and stamps the revision', () => {
  const html = prepareCapture(fixture(), { url: URL, timestamp: TS });
  assert.ok(!/<script/i.test(html), 'no loader script may survive into the pane');
  assert.ok(
    html.includes(`<meta name=\"palimpsest-capture\" content=\"${PREPARE_VERSION}\">`),
    'the document carries the current stamp'
  );
});
