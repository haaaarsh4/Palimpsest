// test/prepareVersion.test.js
//
// One number, written down twice, in two files that cannot import each other:
// the server stamps every document it prepares with PREPARE_VERSION, and the
// browser store throws away any document whose stamp is not AR_CAPTURE_VERSION.
//
// They have to be equal, and the failure when they are not is silent and ugly:
// the store keeps serving documents the pipeline no longer produces, so the film
// renders a page the compare view would not. It happened here. This test is what
// makes it fail loudly instead of quietly.
//
// The browser constant is read out of the source rather than required, because
// public/archiveStore.js is browser code with no module exports; the value is a
// plain literal on its own line for exactly that reason.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { PREPARE_VERSION } = require('../lib/prepareCapture');

test('the store and the pipeline agree on which revision of a capture is current', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'archiveStore.js'), 'utf8');
  const m = /const AR_CAPTURE_VERSION = (\d+);/.exec(source);
  assert.ok(m, 'the browser store must declare AR_CAPTURE_VERSION as a plain number');
  assert.equal(
    Number(m[1]),
    PREPARE_VERSION,
    `public/archiveStore.js says ${m[1]} and lib/prepareCapture.js says ${PREPARE_VERSION}; ` +
      'bump both together or the film will keep rendering stale captures'
  );
});
