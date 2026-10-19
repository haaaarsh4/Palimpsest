// test/imageBytes.test.js
//
// Same address, different picture: the attribute diff calls it identical
// because src, alt and size all match. These run the real post-pass
// (lib/imageBytes.js) with a stubbed hasher, so no network is touched,
// and pin the promise: different bytes promote to a changed entry, equal
// bytes stay silent, and a failed fetch never becomes a change.

const test = require('node:test');
const assert = require('node:assert/strict');

const { promoteSilentImageChanges, assetTarget } = require('../lib/imageBytes');
const { prepareCapture } = require('../lib/prepareCapture');
const { diffSnapshots } = require('../lib/diffEngine');

const OLD_BASE = 'https://web.archive.org/web/20150914235916/http://settlement.org/';
const NEW_BASE = 'https://web.archive.org/web/20261002005041/https://settlement.org/';

function page(base, body) {
  return `<!DOCTYPE html><html><head><base href=\"${base}\"></head><body>${body}</body></html>`;
}

test('assetTarget prefers the capture timestamp for relative addresses', () => {
  const t = assetTarget('images/logo.png', OLD_BASE, '20150914235916');
  assert.ok(t);
  assert.equal(t.ts, '20150914235916');
  assert.match(t.url, /settlement\.org/);
});

test('assetTarget keeps the timestamp the archive baked into the address', () => {
  const t = assetTarget('/web/20261002005041im_/https://settlement.org/img/a.png', NEW_BASE, '20150914235916');
  assert.ok(t);
  assert.equal(t.ts, '20261002005041');
});

test('assetTarget refuses inline placeholders and non-http targets', () => {
  assert.equal(assetTarget('data:image/gif;base64,AAAA', OLD_BASE, '20150914235916'), null);
  assert.equal(assetTarget('mailto:a@b.org', OLD_BASE, '20150914235916'), null);
});

test('identical bytes stay silent', async () => {
  const oldHtml = page(OLD_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const newHtml = page(NEW_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 0);
  await promoteSilentImageChanges(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => 'same-hash');
  assert.equal(result.changes.length, 0);
});

test('different bytes promote the silent pair to a changed entry', async () => {
  const oldHtml = page(OLD_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const newHtml = page(NEW_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 0);
  await promoteSilentImageChanges(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async (raw, base) => (String(base).includes('2015') ? 'hash-old' : 'hash-new'));
  assert.equal(result.changes.length, 1);
  const c = result.changes[0];
  assert.equal(c.type, 'changed');
  assert.equal(c.tag, 'img');
  assert.equal(c.imageBytesChanged, true);
  assert.equal(result.counts.changed, 1);
  assert.match(result.newHtml, /data-pdiff-changed/);
  assert.match(result.oldHtml, /data-pdiff-removed/);
});

test('a failed fetch never becomes a change', async () => {
  const oldHtml = page(OLD_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const newHtml = page(NEW_BASE, '<img src=\"https://settlement.org/img/logo.png\" alt=\"Ontario\">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  await promoteSilentImageChanges(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => null);
  assert.equal(result.changes.length, 0);
});

test('an already-flagged address change needs no fetch', async () => {
  const oldHtml = page(OLD_BASE, '<img src=\"https://settlement.org/img/a.png\" alt=\"Ontario\">');
  const newHtml = page(NEW_BASE, '<img src=\"https://settlement.org/img/b.png\" alt=\"Ontario\">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 1);
  let calls = 0;
  await promoteSilentImageChanges(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => { calls++; return 'hash'; });
  assert.equal(calls, 0);
  assert.equal(result.changes.length, 1);
});

test('prepareCapture forces new-tab targets back to the pane itself', () => {
  const raw = '<!DOCTYPE html><html><head></head><body>' +
    '<base target=\"_blank\">' +
    '<a href=\"/en\" target=\"_blank\">EN</a>' +
    '<a href=\"/plain\">plain</a>' +
    '<form action=\"/go\" target=\"_blank\"></form>' +
    '</body></html>';
  const out = prepareCapture(raw, { url: 'https://settlement.org/', timestamp: '20261002005041' });
  assert.doesNotMatch(out, /target=\"_blank\"/i);
  assert.match(out, /target=\"_self\"/);
  assert.doesNotMatch(out, /<base[^>]*target/i);
});

test('a byte-changed picture reads as a different picture everywhere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf-8');
  const slice = (from, to) => {
    const start = src.indexOf(from);
    assert.ok(start >= 0, `marker not found: ${from}`);
    const end = src.indexOf(to, start);
    assert.ok(end > start, `end marker not found: ${to}`);
    return src.slice(start, end);
  };
  const helpersSrc =
    slice('const TEXTLESS_TAGS', 'function renderChangesList') +
    slice('function truncate(s, n)', 'function formatDate');
  const { sidebarTextForChange, imageChangeVerdict, describeImageChange } = new Function(
    `${helpersSrc}; return { sidebarTextForChange, imageChangeVerdict, describeImageChange };`
  )();
  const c = {
    type: 'changed', tag: 'img', imageBytesChanged: true,
    attrsBefore: { src: '/img/logo.png', alt: 'Ontario' },
    attrsAfter: { src: '/img/logo.png', alt: 'Ontario' },
    attrChanges: [],
  };
  assert.equal(imageChangeVerdict(c), 'different');
  assert.match(describeImageChange(c), /address stayed the same.*bytes differ/s);
  assert.match(sidebarTextForChange(c), /Same address, different picture/);
});

test('a declared size matching the natural size is demoted as a no-op', async () => {
  // The OCASI shape: same file, same description, width/height the later
  // capture declares and the earlier does not, while the file itself is
  // 119x45. Both renders are pixel-identical, so the entry goes away.
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const png119x45 = (() => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12);
    b.writeUInt32BE(119, 16);
    b.writeUInt32BE(45, 20);
    return b;
  })();
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/logo-ocasi.png" alt="OCASI">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/logo-ocasi.png" width="119" height="45" alt="OCASI">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 1);
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => png119x45);
  assert.equal(result.changes.length, 0);
  assert.equal(result.counts.changed, 0);
  // The style block itself names the selectors, so match the mark as an
  // attribute on the image element, not the bare string.
  assert.doesNotMatch(result.newHtml, /<img[^>]*data-pdiff-changed/);
  assert.doesNotMatch(result.oldHtml, /<img[^>]*data-pdiff-removed/);
});

test('a declared size that really resizes the picture stays flagged', async () => {
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const png200x100 = (() => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12);
    b.writeUInt32BE(200, 16);
    b.writeUInt32BE(100, 20);
    return b;
  })();
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/icon.png" alt="Icon">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/icon.png" width="90" height="23" alt="Icon">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 1);
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => png200x100);
  // 90x23 declared against a 200x100 file: a genuine resize, kept.
  assert.equal(result.changes.length, 1);
});

test('same declared size but different pixels stays flagged', async () => {
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/logo.png" alt="Logo">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/logo.png" width="119" height="45" alt="Logo">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  let n = 0;
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async (raw, base) => Buffer.from(String(base).includes('2015') ? `old-${n++}` : `new-${n++}`));
  assert.equal(result.changes.length, 1);
});

test('a swapped picture with sizes carries each side measured from its own file', async () => {
  // The 211 shape: src, alt AND size all move at once. Demotion is out of
  // the question, but the panel must still name exact numbers: before
  // from the old file's bytes, after from the new file's.
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/logo.png">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/logo.png" alt="Ontario" width="50" height="32">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 1);
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async (raw, base) => (String(base).includes('2015') ? png(64, 64) : png(50, 32)));
  assert.equal(result.changes.length, 1, 'a re-described picture is never a no-op');
  assert.deepEqual(result.changes[0].sizeBefore, { w: 64, h: 64 });
  assert.deepEqual(result.changes[0].sizeAfter, { w: 50, h: 32 });
});

test('an unreadable file never demotes anything', async () => {
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/logo.png" alt="Logo">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/logo.png" width="119" height="45" alt="Logo">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => null);
  assert.equal(result.changes.length, 1);
});

test('a genuine resize keeps its measured sizes so the panel names the before number', async () => {
  // The "(none) → 119" complaint: an undeclared side renders at the
  // file's natural size, so the kept change carries both effective sizes.
  const { demoteNoopImageResizes } = require('../lib/imageBytes');
  const png200x100 = (() => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12);
    b.writeUInt32BE(200, 16);
    b.writeUInt32BE(100, 20);
    return b;
  })();
  const oldHtml = page(OLD_BASE, '<img src="https://settlement.org/img/icon.png" alt="Icon">');
  const newHtml = page(NEW_BASE, '<img src="https://settlement.org/img/icon.png" width="90" height="23" alt="Icon">');
  const result = diffSnapshots(oldHtml, newHtml, {});
  assert.equal(result.changes.length, 1);
  await demoteNoopImageResizes(result, { tsFrom: '20150914235916', tsTo: '20261002005041' },
    async () => png200x100);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0].sizeBefore, { w: 200, h: 100 });
  assert.deepEqual(result.changes[0].sizeAfter, { w: 90, h: 23 });
});

test('srcset with the same candidates across captures is not a change', () => {
  const d = diffSnapshots(
    page(OLD_BASE, '<img src=\"a.png\" srcset=\"/web/20150914235916im_/http://settlement.org/a.png 1x, /web/20150914235916im_/http://settlement.org/b.png 2x\" alt=\"Icon\">'),
    page(NEW_BASE, '<img src=\"a.png\" srcset=\"/web/20261002005041im_/https://settlement.org/a.png 1x, /web/20261002005041im_/https://settlement.org/b.png 2x\" alt=\"Icon\">'),
    {}
  );
  assert.equal(d.changes.length, 0);
});
