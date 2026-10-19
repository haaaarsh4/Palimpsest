// test/imageSize.test.js
//
// The demote step trusts these dimensions to un-flag a change, so every
// format branch is pinned against hand-built headers: a wrong number here
// would silently hide a real resize.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { naturalSize, declaredNumber } = require('../lib/imageSize');

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test('reads PNG dimensions', () => {
  assert.deepEqual(naturalSize(png(119, 45)), { width: 119, height: 45 });
});

test('reads GIF dimensions', () => {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0);
  b.writeUInt16LE(10, 6);
  b.writeUInt16LE(20, 8);
  assert.deepEqual(naturalSize(b), { width: 10, height: 20 });
});

test('reads JPEG dimensions from the frame header', () => {
  const b = Buffer.alloc(20);
  b[0] = 0xFF; b[1] = 0xD8; // SOI
  b[2] = 0xFF; b[3] = 0xC0; // SOF0
  b.writeUInt16BE(11, 4); // length
  b[6] = 8; // precision
  b.writeUInt16BE(45, 7); // height
  b.writeUInt16BE(119, 9); // width
  assert.deepEqual(naturalSize(b), { width: 119, height: 45 });
});

test('reads BMP dimensions, including top-down negatives', () => {
  const b = Buffer.alloc(26);
  b.write('BM', 0);
  b.writeInt32LE(119, 18);
  b.writeInt32LE(-45, 22);
  assert.deepEqual(naturalSize(b), { width: 119, height: 45 });
});

test('reads WebP extended canvas size', () => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0);
  b.write('WEBP', 8);
  b.write('VP8X', 12);
  b[24] = 118; b[27] = 44; // minus one on the wire
  assert.deepEqual(naturalSize(b), { width: 119, height: 45 });
});

test('reads SVG width/height, falling back to the viewBox', () => {
  assert.deepEqual(
    naturalSize(Buffer.from('<svg xmlns=\"x\" width=\"119\" height=\"45\"></svg>'), 'logo.svg'),
    { width: 119, height: 45 }
  );
  assert.deepEqual(
    naturalSize(Buffer.from('<svg viewBox=\"0 0 119 45\"></svg>'), 'logo.svg'),
    { width: 119, height: 45 }
  );
});

test('returns null instead of guessing or throwing', () => {
  assert.equal(naturalSize(Buffer.from([1, 2, 3, 4])), null);
  assert.equal(naturalSize(Buffer.alloc(0)), null);
  assert.equal(naturalSize(null), null);
  assert.equal(naturalSize(Buffer.from([0x89, 0x50])), null); // truncated PNG
});

test('declaredNumber takes plain pixels and refuses the rest', () => {
  assert.equal(declaredNumber('119'), 119);
  assert.equal(declaredNumber(' 45px '), 45);
  assert.equal(declaredNumber(null), null);
  assert.equal(declaredNumber('50%'), null);
  assert.equal(declaredNumber('auto'), null);
  assert.equal(declaredNumber('0'), null);
});
