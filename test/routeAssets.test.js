// test/routeAssets.test.js
//
// What a prepared capture's pictures and stylesheets are pointed at, and the
// two shapes that used to leave a pane empty:
//
//  - a lazy-loading placeholder inside a <picture>. Apple's 2026 front page
//    ships `<source srcset="data:image/gif;base64,R0lGOD...">` in front of the
//    real `<img src>`; a source that always matches always wins, so 51 of its
//    53 pictures were one transparent pixel. The placeholder is dropped, and
//    the picture that is actually a picture is what the pane draws;
//  - the same placeholder in an <img>, with the real address parked in a
//    data- attribute for a script that never runs. It is promoted before the
//    address is routed, so the pane asks the cache for the photograph.
//
// Also pinned: a srcset is parsed the way the HTML spec says, because a naive
// split on commas cuts a data: URI in half and the second half is then
// resolved against the page and sent to the asset proxy.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { splitSrcset, isPlaceholderImage, routeHtml, prepareAssets, collectAssetRefs } = require('../lib/routeAssets');

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const opts = { url: 'apple.com', timestamp: '20261018060334', origin: 'http://localhost:3000' };

test('a srcset is split by the HTML spec, not by commas', () => {
  const one = splitSrcset(BLANK + ' 1x');
  assert.equal(one.length, 1, 'a data: URI is one candidate, refCount and all');
  assert.equal(one[0].url, BLANK);
  assert.equal(one[0].descriptor, '1x');

  const two = splitSrcset('https://x/a.jpg 1x, https://x/b.jpg 2x');
  assert.deepEqual(two.map((c) => c.descriptor), ['1x', '2x']);
  assert.deepEqual(two.map((c) => c.url), ['https://x/a.jpg', 'https://x/b.jpg']);

  const mixed = splitSrcset(`${BLANK} 1x, /img/real.jpg 2x`);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[1].url, '/img/real.jpg', 'the comma after the data URI is the separator');
});

test('a placeholder is recognised by its size, never by a site name', () => {
  assert.equal(isPlaceholderImage(BLANK), true);
  assert.equal(isPlaceholderImage('data:image/svg+xml,<svg/>'), true);
  assert.equal(isPlaceholderImage(''), true);
  assert.equal(isPlaceholderImage('https://www.apple.com/a.jpg'), false);
  assert.equal(isPlaceholderImage('data:image/jpeg;base64,' + 'A'.repeat(4000)), false,
    'a real inline picture is not a placeholder');
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'routeAssets.js'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('function isPlaceholderImage'), src.indexOf('const LAZY_SRC')), /apple|nytimes|settlement/i);
});

test('a placeholder <source> never beats the picture behind it', () => {
  const html = '<html><body><picture><source data-empty srcset="' + BLANK + '">' +
    '<img src="https://www.apple.com/v/homepage/hero.jpg" alt="iPhone 18 Pro"></picture></body></html>';
  const out = routeHtml(html, opts);
  assert.doesNotMatch(out, /<source/, 'the placeholder source is gone');
  assert.match(out, /<img[^>]+src="[^"]*\/api\/asset\?/, 'the real picture is routed to the cache');
  assert.match(out, /hero\.jpg/, 'and it is the photograph the page named');
});

test('a placeholder <img> promotes the real address before routing', () => {
  const html = '<html><body><img src="' + BLANK + '" data-src="https://www.apple.com/v/homepage/a.jpg" alt="x">' +
    '<img src="' + BLANK + '" data-lazy-srcset="https://www.apple.com/b.jpg 1x, https://www.apple.com/b@2x.jpg 2x" alt="y">' +
    '</body></html>';
  const out = routeHtml(html, opts);
  const imgs = out.match(/<img[^>]*>/g) || [];
  assert.equal(imgs.length, 2);
  assert.match(imgs[0], /\/api\/asset\?[^"]*a\.jpg/, 'data-src becomes the routed src');
  assert.match(imgs[1], /srcset="[^"]*b\.jpg[^"]* 1x, [^"]*b%402x\.jpg[^"]* 2x"/, 'and a lazy srcset becomes the routed srcset, descriptors kept');
  assert.doesNotMatch(imgs[1], /srcset="[^"]*data:image\/gif/, 'no placeholder candidate survives in it');
});

test('an all-placeholder srcset is removed so the element falls back to src', () => {
  const html = '<html><body><img src="https://www.apple.com/real.jpg" srcset="' + BLANK + ' 1x" alt="x"></body></html>';
  const out = routeHtml(html, opts);
  assert.doesNotMatch(out, /srcset=/, 'no placeholder candidate is left to win');
  assert.match(out, /\/api\/asset\?[^"]*real\.jpg/, 'and the real src is routed');
});

test('a real data: picture is left inline, never proxied', () => {
  const real = 'data:image/png;base64,' + 'A'.repeat(400);
  const html = `<html><body><img src="${real}" alt="x"></body></html>`;
  const out = routeHtml(html, opts);
  assert.match(out, /src="data:image\/png;base64,A{400}"/, 'it stays exactly as the page wrote it');
  assert.doesNotMatch(out, /api\/asset/, 'and never becomes a cache request');
});

test('the whole page is collected for the prefetch, roots and all', () => {
  const html = '<img src="http://localhost:3000/api/asset?m=im_&amp;t=20261018060334&amp;u=https%3A%2F%2Fa%2Fx.jpg&amp;v=3">' +
    '<div style="background-image:url(/api/asset?m=im_&t=20261018060334&u=https%3A%2F%2Fa%2Fy.png&v=3)"></div>';
  const refs = collectAssetRefs(html);
  assert.equal(refs.length, 2, 'both attribute escaping and plain CSS are read');
  assert.deepEqual(refs.map((r) => r.url).sort(), ['https://a/x.jpg', 'https://a/y.png']);
  assert.equal(refs[0].ts, '20261018060334');
  assert.equal(typeof prepareAssets, 'function', 'and the prefetch is a real step, not a promise in the comment');
});

test('the prefetch never throws and never waits past its deadline', async () => {
  const started = Date.now();
  const empty = await prepareAssets('<html><body><p>no assets</p></body></html>', { deadlineMs: 50 });
  assert.equal(empty.asked, 0, 'nothing to ask for');
  assert.equal(empty.timedOut, false);
  assert.deepEqual(empty.missing, [], 'and nothing is missing from a page with no assets');
  assert.ok(Date.now() - started < 500);
});

test('what the prefetch could not get is asked for again, then reported', async () => {
  // A hole in a pane is almost always one cold file the Archive was slow with,
  // so a failed reference is swept a second time inside the same deadline,
  // and whatever is still missing is named - the panes hide those quietly (a
  // broken picture prints its alt text across the design) and the run log is
  // where a hole can be traced to a file instead of guessed at.
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'routeAssets.js'), 'utf8');
  const body = src.slice(src.indexOf('async function prepareAssets'), src.indexOf('module.exports'));
  assert.match(body, /failures\.push\(ref\)/, 'a reference that failed is remembered, not dropped');
  assert.match(body, /failures = await sweep\(again, \[\]\)/, 'and swept again');
  assert.match(body, /Date\.now\(\) - started < deadlineMs/, 'still inside the same deadline');
  assert.match(body, /missing: failures\.slice\(0, 40\)\.map\(\(r\) => r\.url\)/, 'bounded, and named by their address');
  // And the cache retries the fetch itself before a reference is ever called
  // missing: a 429 or a 5xx is the Archive having a bad moment (see
  // test/assetRetry.test.js, which exercises that policy with a stub).
  const cache = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'assetCache.js'), 'utf8');
  assert.match(cache, /const RETRY_DELAYS_MS = \[/, 'a failed fetch has its own retry policy');
  assert.match(cache, /res\.status === 429 \|\| res\.status >= 500/, 'which 429s and 5xxs are worth retrying');
  assert.match(cache, /return \{ asset: null, retry: true \};/, 'and a dropped connection too');
});
