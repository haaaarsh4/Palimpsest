// test/archivePageUrl.test.js
//
// "Compare open pages" re-reads the two addresses the panes show. Those must
// be real archived page captures, a pane can wander onto the live web, and
// the endpoint must never become a fetcher for an arbitrary server. Each
// refusal below is one of those, with the plain-language reason the reader
// actually sees.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArchivePageUrl } = require('../lib/archivePageUrl');

test('a plain archived page address parses to inner URL and timestamp', () => {
  assert.deepEqual(
    parseArchivePageUrl(
      'https://web.archive.org/web/20151124141511/http://settlement.org/ontario/a-b/'
    ),
    { url: 'http://settlement.org/ontario/a-b/', timestamp: '20151124141511' }
  );
});

test('modifiers, queries, and fragments survive the round trip', () => {
  const { url, timestamp } = parseArchivePageUrl(
    'https://web.archive.org/web/20151205132120id_/https://example.org/page?q=1#frag'
  );
  assert.equal(timestamp, '20151205132120');
  assert.equal(url, 'https://example.org/page?q=1#frag');
});

test('a live-web address is refused in plain words', () => {
  assert.throws(() => parseArchivePageUrl('https://settlement.org/ontario/a/'), /live web/);
});

test('javascript:, empty, and garbage addresses are refused', () => {
  assert.throws(() => parseArchivePageUrl('javascript:void(0)'), /Only archived pages/);
  assert.throws(() => parseArchivePageUrl(''), /address/);
  assert.throws(() => parseArchivePageUrl('not a url'), /not an address/);
});

test('an archive address without a page capture is refused', () => {
  assert.throws(
    () => parseArchivePageUrl('https://web.archive.org/web/*/settlement.org'),
    /not a page capture/
  );
});

test('other hosts are refused, even archive-looking paths', () => {
  assert.throws(
    () => parseArchivePageUrl('https://evil.org/web/20151124141511/http://settlement.org/'),
    /live web/
  );
});
