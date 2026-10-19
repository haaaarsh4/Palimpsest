// test/assetRetry.test.js
//
// One picture that failed to arrive is the difference between a pane that
// looks like the site and a pane with a hole in it, so the second ask is part
// of the cache's job rather than the reader's luck. What the retry has to get
// right is the two halves of that promise:
//
//  - a transient answer (429, a 5xx, a dropped connection, a timeout) is asked
//    again, because that is the Archive having a bad moment;
//  - a 404 or a 410 is final, because asking twice for a file the Archive does
//    not hold triples the traffic this cache sends for nothing;
//  - and a slow failure is not asked again at all: waiting out a 20s timeout
//    twice is how a pane gets slower, not how it gets complete.
//
// The whole file is exercised through the exported fetch steps with a stubbed
// global fetch, so no test ever touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const cache = require(path.join(__dirname, '..', 'lib', 'assetCache.js'));

function withFetch(responses, run) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected request: ' + url);
    if (next.throw) throw next.throw;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => (/content-type/i.test(name) ? (next.type || 'image/jpeg') : null) },
      arrayBuffer: async () => next.body || new Uint8Array([1, 2, 3]).buffer,
    };
  };
  return Promise.resolve()
    .then(run)
    .finally(() => { global.fetch = original; })
    .then((value) => ({ value, calls }));
}

test('a server error is asked again, and the file arrives', async () => {
  const { value, calls } = await withFetch(
    [
      { status: 503, type: 'text/html' },
      { status: 429, type: 'text/html' },
      { status: 200, type: 'image/jpeg', body: new Uint8Array([9, 9, 9]).buffer },
    ],
    () => cache.fetchArchive('im_', '20261018060334', 'https://www.apple.com/a.jpg'),
  );
  assert.equal(calls.length, 3, 'two failures and the answer');
  assert.equal(value.mime, 'image/jpeg');
  assert.equal(value.body.length, 3);
});

test('a 404 is final: one ask, no second request for a file nobody has', async () => {
  const { value, calls } = await withFetch(
    [{ status: 404, type: 'text/html' }],
    () => cache.fetchArchive('im_', '20261018060334', 'https://www.apple.com/gone.jpg'),
  );
  assert.equal(calls.length, 1);
  assert.equal(value, null, 'and the failure is reported as a miss, not cached as one');
});

test('a dropped connection is asked again', async () => {
  const { value, calls } = await withFetch(
    [
      { throw: new Error('socket hang up') },
      { status: 200, type: 'image/png', body: new Uint8Array([7]).buffer },
    ],
    () => cache.fetchArchive('im_', '20261018060334', 'https://www.apple.com/b.png'),
  );
  assert.equal(calls.length, 2);
  assert.equal(value.mime, 'image/png');
});

test('the first ask keeps the capture\u2019s own replay flavour', async () => {
  const { calls } = await withFetch(
    [{ status: 200, type: 'text/css', body: new Uint8Array([1]).buffer }],
    () => cache.fetchArchive('cs_', '20261018060334', 'https://www.apple.com/site.css'),
  );
  assert.match(calls[0], /\/web\/20261018060334cs_\//, 'cs_ is asked for as cs_');
});

test('an empty answer falls back to id_ rather than being retried in place', async () => {
  const { value, calls } = await withFetch(
    [
      { status: 200, type: 'text/css', body: new Uint8Array(0).buffer },
      { status: 200, type: 'text/css', body: new Uint8Array([4, 5]).buffer },
    ],
    () => cache.fetchArchive('cs_', '20261018060334', 'https://www.apple.com/empty.css'),
  );
  assert.equal(calls.length, 2, 'the empty 200 is a specific answer, not a failure');
  assert.match(calls[1], /\/web\/20261018060334id_\//, 'the second ask is the id_ flavour');
  assert.equal(value.body.length, 2);
});
