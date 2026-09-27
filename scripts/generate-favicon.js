// scripts/generate-favicon.js
//
// Generates the favicon set in public/ from a single geometry definition,
// so the hand-crisp SVG and the pixel-rasterised PNG/ICO fallbacks can
// never drift apart. Run it after editing anything in G below:
//
//   node scripts/generate-favicon.js
//
// The mark: a palimpsest is a manuscript scraped clean and written on
// again, where the earlier text still ghosts through. So three layers of
// "page" sit staggered like a deck of transparencies - the oldest faint,
// the newest solid in the site's terracotta accent. It reads as three
// clean strokes at 16px and as a stack of overwritten pages at 512.
//
// Colours are lifted straight from the :root palette in styles.css.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');

// ---- The one source of truth ----------------------------------------------

const G = {
  size: 512,

  // The cream tile, inset 2px so its hairline border sits inside the edge.
  tile: { inset: 2, radius: 92 },
  tileTop: '#FCF9F0', // --card
  tileBottom: '#EDE3CC', // between --card and --paper
  tileEdge: '#DCD1AE', // --line

  // Three layers of "page", each stepping right and up so the stack reads
  // as time passing. The oldest is faded sepia ink, the middle is a
  // half-worn version of the accent, the newest is the live thing. All
  // three are fully rounded lozenges so they stay legible at 16px.
  //
  // The oldest layer is --ink-soft rather than --ink. Pure ink at low
  // opacity over cream averages out to a cold neutral grey that read as
  // "disabled" against this warm palette; the soft ink stays sepia, so it
  // reads as old faded writing instead.
  //
  // There is deliberately no interior detail. An earlier pass ruled two
  // "text" lines onto the top layer; at 48px and below they stopped reading
  // as text and started reading as a printing defect, and the SVG is used
  // at 16px in the tab, so there was nowhere to hide them.
  layerH: 62,
  layers: [
    { x: 76, y: 311, w: 268, fill: '#6D6650', opacity: 0.42 }, // --ink-soft, sepia
    { x: 122, y: 225, w: 268, fill: '#B5451F', opacity: 0.38 }, // --accent, faded
    { x: 168, y: 139, w: 268, fill: '#B5451F', opacity: 1 }, // --accent, live
  ],
};

const R = G.size / 2;

// ---- Signed distance fields (what makes the edges smooth) -----------------

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance (in design units) -> coverage, with a half-pixel soft edge.
// The edge width has to be expressed in *pixels*, so the caller scales it
// by 0.5 / unitsPerPixel. Everything else stays in design units, which is
// what keeps one geometry correct at every size.
let edgeWidth = 0.5;
const cov = (d) => Math.min(1, Math.max(0, edgeWidth - d));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Source-over compositing onto a premultiplied-free RGBA buffer.
function over(buf, i, rgb, a) {
  if (a <= 0) return;
  const da = buf[i + 3] / 255;
  const outA = a + da * (1 - a);
  for (let c = 0; c < 3; c++) {
    const src = rgb[c] * a;
    const dst = buf[i + c] * da * (1 - a);
    buf[i + c] = Math.round((src + dst) / outA);
  }
  buf[i + 3] = Math.round(outA * 255);
}

// ---- Rasteriser ------------------------------------------------------------

function rasterize(px) {
  const S = G.size / px; // pixels per design unit
  edgeWidth = 0.5 / S; // half a pixel, expressed in design units
  const buf = Buffer.alloc(px * px * 4);

  const top = hexToRgb(G.tileTop);
  const bottom = hexToRgb(G.tileBottom);
  const edge = hexToRgb(G.tileEdge);

  const tileSdf = (x, y) =>
    sdRoundRect(x, y, R, R, R - G.tile.inset, R - G.tile.inset, G.tile.radius);

  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      // Sample point in design units, which is where all geometry lives.
      const dx = (x + 0.5) * S;
      const dy = (y + 0.5) * S;
      const i = (y * px + x) * 4;

      // Tile: vertical cream gradient, clipped by the rounded square.
      const a = cov(tileSdf(dx, dy));
      if (a > 0) over(buf, i, mix(top, bottom, dy / G.size), a);

      // Hairline border, a 4-unit ring hugging the tile edge.
      over(buf, i, edge, cov(Math.abs(tileSdf(dx, dy)) - 2) * 0.9);

      // The three layers, each a fully rounded lozenge.
      for (const layer of G.layers) {
        const d = sdRoundRect(
          dx,
          dy,
          layer.x + layer.w / 2,
          layer.y + G.layerH / 2,
          layer.w / 2,
          G.layerH / 2,
          G.layerH / 2
        );
        over(buf, i, hexToRgb(layer.fill), cov(d) * layer.opacity);
      }
    }
  }
  return buf;
}

// ---- PNG encoding (zlib is already a dependency-free builtin) --------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(px * (px * 4 + 1));
  for (let y = 0; y < px; y++) {
    raw[y * (px * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO (PNG-compressed entries, understood by every current browser) -----

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// ---- SVG, emitted from the same numbers ------------------------------------

function writeSvg() {
  const layers = G.layers
    .map(
      (l) =>
        `  <rect x="${l.x}" y="${l.y}" width="${l.w}" height="${G.layerH}" rx="${G.layerH / 2}" fill="${l.fill}" fill-opacity="${l.opacity}"/>`
    )
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G.size} ${G.size}" width="${G.size}" height="${G.size}" role="img" aria-label="Palimpsest">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${G.tileTop}"/>
      <stop offset="1" stop-color="${G.tileBottom}"/>
    </linearGradient>
  </defs>
  <rect x="${G.tile.inset}" y="${G.tile.inset}" width="${G.size - G.tile.inset * 2}" height="${G.size - G.tile.inset * 2}" rx="${G.tile.radius}" fill="url(#paper)"/>
  <rect x="${G.tile.inset}" y="${G.tile.inset}" width="${G.size - G.tile.inset * 2}" height="${G.size - G.tile.inset * 2}" rx="${G.tile.radius}" fill="none" stroke="${G.tileEdge}" stroke-width="4"/>
${layers}
</svg>
`;
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg);
  console.log('  favicon.svg');
}

// ---- Go --------------------------------------------------------------------

console.log('Rendering the Palimpsest mark:');
writeSvg();

for (const size of [16, 32, 48, 64, 180, 512]) {
  const png = encodePng(rasterize(size), size);
  const name = size === 512 ? 'icon-512.png' : size === 180 ? 'apple-touch-icon.png' : `favicon-${size}.png`;
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`  ${name} (${size}x${size}, ${png.length} bytes)`);
}

const icoSizes = [16, 32, 48];
const ico = encodeIco(
  icoSizes.map((size) => ({ size, data: encodePng(rasterize(size), size) }))
);
fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico);
console.log(`  favicon.ico (${icoSizes.join('/')}, ${ico.length} bytes)`);
