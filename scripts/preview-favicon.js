// scripts/preview-favicon.js
//
// Builds a throwaway, self-contained page that shows the generated icons
// at real sizes, in a mock browser tab, and blown up to the pixel grid.
// The images are inlined as data URIs because the preview server only
// serves the one HTML file, and the filename is bumped on every run
// because that server also caches by path.
//
//   node scripts/preview-favicon.js
//
// Nothing here ships. It exists so the mark can be judged honestly at
// 16px instead of only at the size it was designed at.

const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');

const dataUri = (file) =>
  `data:image/${file.endsWith('.svg') ? 'svg+xml' : 'png'};base64,` +
  fs.readFileSync(path.join(PUB, file)).toString('base64');

const ICON = (file, px, note) =>
  `<div class="cell"><img src="${dataUri(file)}" style="width:${px}px"/><span>${note}</span></div>`;

const ZOOM = (file, px, note) =>
  `<div class="cell"><img src="${dataUri(file)}" style="width:${px}px;image-rendering:pixelated"/><span>${note}</span></div>`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
  body{margin:0;background:#EFE8D6;font-family:ui-sans-serif,system-ui,sans-serif;color:#1B1811}
  .wrap{padding:28px 32px 34px}
  h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6D6650;margin:0 0 16px;font-weight:600}
  .row{display:flex;align-items:flex-end;gap:26px}
  .cell{text-align:center}
  .cell span{display:block;margin-top:8px;font-size:10px;color:#A79D7E;font-family:ui-monospace,monospace}
  .tabs{background:#1a1a1a;padding:10px 10px 0;display:flex;gap:6px;align-items:flex-end}
  .tab{background:#2f2f2f;color:#e8e6e3;border-radius:10px 10px 0 0;padding:9px 14px;font-size:13px;display:flex;align-items:center;gap:9px}
  .tab.active{background:#3a3a3a}
  .tab img{width:16px;height:16px;display:block}
  .chrome{background:#fff;padding:22px;color:#bbb;font-size:13px}
  .onpaper{background:#EFE8D6;padding:26px;border-radius:12px}
  .ondark{background:#1a1a1a;padding:26px;border-radius:12px}
</style></head><body><div class="wrap">

  <div class="onpaper">
    <h2>Raster PNGs, on your page background</h2>
    <div class="row">
      ${ICON('icon-512.png', 132, '512')}
      ${ICON('apple-touch-icon.png', 80, '180')}
      ${ICON('favicon-64.png', 64, '64')}
      ${ICON('favicon-48.png', 48, '48')}
      ${ICON('favicon-32.png', 32, '32')}
      ${ICON('favicon-16.png', 16, '16')}
    </div>
  </div>

  <div class="ondark" style="margin-top:20px">
    <h2>In a real tab (dark chrome) &mdash; what people actually see</h2>
    <div class="tabs">
      <div class="tab active"><img src="${dataUri('favicon-16.png')}"/>Palimpsest</div>
      <div class="tab"><img src="${dataUri('favicon-16.png')}"/>Some other site</div>
    </div>
    <div class="chrome">page content area</div>
  </div>

  <div class="ondark" style="margin-top:20px">
    <h2>SVG (vector, what Chrome/Edge/Firefox use)</h2>
    <div class="row">
      ${ICON('favicon.svg', 132, '132')}
      ${ICON('favicon.svg', 64, '64')}
      ${ICON('favicon.svg', 32, '32')}
      ${ICON('favicon.svg', 16, '16')}
    </div>
  </div>

  <div class="ondark" style="margin-top:20px">
    <h2>Zoomed to the pixel grid &mdash; is it actually readable?</h2>
    <div class="row">
      ${ZOOM('favicon-16.png', 160, '16px &times; 10')}
      ${ZOOM('favicon-32.png', 160, '32px &times; 5')}
      ${ZOOM('favicon-48.png', 144, '48px &times; 3')}
    </div>
  </div>

</div></body></html>`;

// Bump the filename so the preview server can't hand back a stale copy.
const n = fs
  .readdirSync(__dirname.length ? path.join(__dirname, '..') : '.')
  .filter((f) => /^favicon-preview-\d+\.html$/.test(f))
  .length;

const out = path.join(__dirname, '..', `favicon-preview-${n}.html`);
fs.writeFileSync(out, html);
console.log('wrote', path.basename(out), `(${(html.length / 1024).toFixed(0)}KB)`);
