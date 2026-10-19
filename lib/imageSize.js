// lib/imageSize.js
//
// Why this file exists: two captures can declare different display sizes
// for the same picture file while rendering it identically. The site adds
// explicit width/height attributes the earlier capture never had
// (logo-ocasi.png: none -> 119x45), the attribute diff flags it as "new
// display size", and the reader sees two identical pictures with a change
// row insisting they differ. Whether it really renders differently is a
// fact about the file's own pixels, not its markup: an undeclared size
// renders at the file's natural size, so a declared size equal to the
// natural size changes nothing visible.
//
// So this reads the natural size straight out of the file's own bytes,
// with no dependency and no decode: PNG, GIF, JPEG, BMP and WebP carry
// their dimensions in fixed header spots, and SVG states them (or its
// viewBox) in text. Anything unrecognized returns null rather than a
// guess, and a null never demotes a change, it only declines to judge.

function u16LE(b, o) { return b[o] | (b[o + 1] << 8); }
function u16BE(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32BE(b, o) { return (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function i32LE(b, o) {
  const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  return v;
}

function valid(w, h) {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 100000 && h <= 100000
    ? { width: w, height: h }
    : null;
}

function pngSize(b) {
  // 8-byte signature, then IHDR chunk: width/height uint32BE at 16/20.
  if (b.length < 33) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4E || b[3] !== 0x47) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  return valid(u32BE(b, 16), u32BE(b, 20));
}

function gifSize(b) {
  if (b.length < 10) return null;
  const sig = String.fromCharCode(b[0], b[1], b[2]);
  if (sig !== 'GIF') return null;
  return valid(u16LE(b, 6), u16LE(b, 8));
}

// JPEG start-of-frame markers (baseline, extended, progressive and friends,
// but never DHT/DAC/SOI which share the 0xC range without carrying a size).
const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xFF) return null;
    const marker = b[o + 1];
    // Standalone markers carry no length and are skipped as one byte pair.
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { o += 2; continue; }
    const len = u16BE(b, o + 2);
    if (len < 2) return null;
    if (SOF.has(marker)) return valid(u16BE(b, o + 7), u16BE(b, o + 5));
    o += 2 + len;
  }
  return null;
}

function bmpSize(b) {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4D) return null;
  // Height is signed (top-down BMPs store it negative); the extent is what counts.
  return valid(i32LE(b, 18), Math.abs(i32LE(b, 22)));
}

function webpSize(b) {
  if (b.length < 16) return null;
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RIFF') return null;
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== 'WEBP') return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === 'VP8 ') {
    // Lossy bitstream: 3-byte frame tag, then 14-bit width/height.
    if (b.length < 30) return null;
    return valid(u16LE(b, 26) & 0x3FFF, u16LE(b, 28) & 0x3FFF);
  }
  if (chunk === 'VP8L') {
    // Lossless: 1 signature byte then width-1/height-1 packed in 28 bits.
    if (b.length < 25) return null;
    if (b[21] !== 0x2F) return null;
    const bits = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
    return valid((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1);
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas size minus one at offset 24.
    if (b.length < 30) return null;
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return valid(w, h);
  }
  return null;
}

function svgSize(b, url) {
  const isSvg = /\.svg(\?|$)/i.test(String(url || '').split('?')[0]) ||
    /<svg[\s>]/i.test(b.slice(0, 512).toString('latin1'));
  if (!isSvg) return null;
  const text = b.slice(0, 16384).toString('utf8');
  const attr = (name) => {
    const m = new RegExp(`<svg[^>]*?\\s${name}\\s*=\\s*[\"']([\\d.]+)`, 'i').exec(text);
    return m ? Number(m[1]) : null;
  };
  const w = attr('width');
  const h = attr('height');
  if (w && h) return valid(w, h);
  const vb = /<svg[^>]*?\sviewBox\s*=\s*["']([\d.\-\s,]+)["']/i.exec(text);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) return valid(parts[2], parts[3]);
  }
  return null;
}

// The file's own dimensions, or null when the bytes say nothing usable.
// Never throws: a truncated or exotic file is unrecognized, not an error.
function naturalSize(bytes, url) {
  try {
    if (!bytes || !bytes.length) return null;
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return pngSize(b) || gifSize(b) || jpegSize(b) || bmpSize(b) || webpSize(b) || svgSize(b, url);
  } catch (_) {
    return null;
  }
}

// A declared width/height attribute as a number, or null when it is absent
// or not a plain pixel count (percentages and autos are layout-relative,
// never comparable to a file's pixels).
function declaredNumber(value) {
  if (value == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { naturalSize, declaredNumber };
