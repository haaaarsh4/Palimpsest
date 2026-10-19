// test/imageLabels.test.js
//
// An <img> carries no text, so the sidebar's generic before/after rendering
// gave it nothing: added and removed images were blank rows, a changed image
// a bare "→". These tests run the real label functions from public/app.js
// (extracted as source and evaluated, the helpers under test are pure and
// touch no DOM) and pin the promise: no image row is ever blank or a bare
// arrow again.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf-8');

function slice(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `marker not found: ${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `end marker not found: ${to}`);
  return src.slice(start, end);
}

// The label block (pure helpers ending where rendering begins) plus the two
// string helpers they use, which live further down the same file.
const helpersSrc =
  slice('const TEXTLESS_TAGS', 'function renderChangesList') +
  slice('function truncate(s, n)', 'function formatDate');

const { sidebarTextForChange, fileNameFromUrl, imageChangeVerdict, describeImageChange, dimensionChangeText, displaySizeValue, maxWidthLimit, sizeRowIsNoop } = new Function(
  `${helpersSrc}; return { sidebarTextForChange, fileNameFromUrl, imageChangeVerdict, describeImageChange, dimensionChangeText, displaySizeValue, maxWidthLimit, sizeRowIsNoop };`
)();

test('file names survive archive rewrites, queries, and bad escapes', () => {
  assert.equal(
    fileNameFromUrl('/web/20261002005041im_/https://settlement.org/images/logos/logo-cic-en.png'),
    'logo-cic-en.png'
  );
  assert.equal(fileNameFromUrl('/img/photo.jpg?width=300#frag'), 'photo.jpg');
  assert.equal(fileNameFromUrl('data:image/gif;base64,AAAA'), 'inline image');
  assert.equal(fileNameFromUrl('%E0%A4%A'), '%E0%A4%A'); // malformed escape: no throw, no loss
  assert.equal(fileNameFromUrl(''), '');
});

test('an added image names its description, never a blank row', () => {
  const html = sidebarTextForChange({
    type: 'added',
    tag: 'img',
    attrsAfter: { src: '/web/20261002005041/https://example.org/img/logo.png', alt: 'Settlement logo' },
  });
  assert.ok(html.includes('Settlement logo'), html);
  assert.ok(html.trim().length > 0);
});

test('an added image with no description names its file, never a blank row', () => {
  const html = sidebarTextForChange({
    type: 'added',
    tag: 'img',
    attrsAfter: { src: '/web/20261002005041/https://example.org/img/badge-years-en.png' },
  });
  assert.ok(html.includes('badge-years-en.png'), html);
});

test('a removed image names what was there', () => {
  const html = sidebarTextForChange({
    type: 'removed',
    tag: 'img',
    attrsBefore: { src: '/web/20160710035916/http://example.org/img/old.gif', alt: 'Old banner' },
  });
  assert.ok(html.includes('Old banner'), html);
});

test('a changed image with the same description shows it once, not a bare arrow', () => {
  const html = sidebarTextForChange({
    type: 'changed',
    tag: 'img',
    before: '',
    after: '',
    textChanged: false,
    attrsBefore: { src: '/web/20160710035916/http://example.org/img/old.gif', alt: 'Logo' },
    attrsAfter: { src: '/web/20261002005041/https://example.org/img/new.gif', alt: 'Logo' },
    attrChanges: [
      { name: 'src', before: '/web/20160710035916/http://example.org/img/old.gif', after: '/web/20261002005041/https://example.org/img/new.gif' },
    ],
  });
  assert.ok(html.includes('Logo'), html);
  assert.ok(!html.includes('&rarr;'), `same picture must not render an arrow: ${html}`);
});

test('a changed image with a new description keeps the meaningful arrow', () => {
  const html = sidebarTextForChange({
    type: 'changed',
    tag: 'img',
    before: '',
    after: '',
    textChanged: false,
    attrsBefore: { src: '/img/a.gif', alt: 'Old photo' },
    attrsAfter: { src: '/img/b.gif', alt: 'New photo' },
    attrChanges: [{ name: 'alt', before: 'Old photo', after: 'New photo' }],
  });
  assert.ok(html.includes('Old photo') && html.includes('New photo'), html);
  assert.ok(html.includes('&rarr;'), html);
});

// ------------------------------------------ same picture, or a different one?
// "Image file changed" was the whole explanation, which is not one. These
// pin the two cases it has to tell apart, using the real files from the
// record this was reported against.

test('a renamed annual badge reads as the same picture', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/web/20160620im_/http://settlement.org/images/badge-15-years-en.png', alt: 'Online since 2000' },
    attrsAfter: { src: '/web/20261002im_/https://settlement.org/images/badge-years-en.png', alt: 'Online since 2000' },
  };
  assert.equal(imageChangeVerdict(c), 'same');
  const text = describeImageChange(c);
  assert.match(text, /badge-15-years-en\.png → badge-years-en\.png/);
  assert.match(text, /same picture re-saved/i);
});

test('a different logo file reads as a different picture', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/web/2016im_/http://settlement.org/images/logos/logo-ontario.png', alt: 'Ontario' },
    attrsAfter: { src: '/web/2026im_/https://settlement.org/images/logos/logo-ontario-positive.png', alt: 'Ontario' },
  };
  // Same prefix, extra word: a different picture, not a version of this one.
  assert.equal(imageChangeVerdict(c), 'different');
  assert.match(describeImageChange(c), /different picture now/i);
});

test('an old/new tag on the same name is the same picture', () => {
  assert.equal(imageChangeVerdict({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/img/promo-old.png' },
    attrsAfter: { src: '/img/promo-new.png' },
  }), 'same');
});

test('an unchanged file with a rewritten description says so', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/img/strip.png', alt: 'Old words' },
    attrsAfter: { src: '/img/strip.png', alt: 'New words' },
  };
  assert.equal(imageChangeVerdict(c), 'different');
  assert.match(describeImageChange(c), /describes the picture as changed/);
});

test('a same-name change says which kind it is, not "image file changed"', () => {
  const html = sidebarTextForChange({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/web/2016im_/http://settlement.org/images/badge-15-years-en.png', alt: 'Online since 2000' },
    attrsAfter: { src: '/web/2026im_/https://settlement.org/images/badge-years-en.png', alt: 'Online since 2000' },
  });
  assert.doesNotMatch(html, /image file changed/i);
  assert.match(html, /Same picture, re-saved under a new file name/);
});

test('a lazy-loaded picture names the real files, not the placeholder', () => {
  const text = describeImageChange({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/Content/slider/pics/aug-rent-apartment.png', alt: '' },
    attrsAfter: { src: 'data:image/png;base64,AAAA', alt: '', 'data-src': '/Content/slider/pics/aug-rent-apartment.jpg' },
    attrChanges: [
      { name: 'src', before: '/Content/slider/pics/aug-rent-apartment.png', after: 'data:image/png;base64,AAAA' },
      { name: 'data-src', before: null, after: '/Content/slider/pics/aug-rent-apartment.jpg' },
    ],
  });
  assert.match(text, /Before it was aug-rent-apartment\.png, now it arrives via aug-rent-apartment\.jpg/);
  const html = sidebarTextForChange({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/Content/slider/pics/aug-rent-apartment.jpg', alt: '' },
    attrsAfter: { src: '/Content/slider/pics/aug-rent-apartment.jpg', alt: '' },
    attrChanges: [{ name: 'data-src', before: null, after: '/Content/slider/pics/aug-rent-apartment.jpg' }],
  });
  assert.match(html, /Loads differently now/);
});

test('a resized icon with the same file names its new size', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/images/logos/logo-ontario.png', alt: 'Province of Ontario' },
    attrsAfter: { src: '/images/logos/logo-ontario.png', width: '90', height: '23', alt: 'Province of Ontario' },
    attrChanges: [
      { name: 'width', before: null, after: '90' },
      { name: 'height', before: null, after: '23' },
    ],
  };
  assert.match(describeImageChange(c), /Same picture file.*display size changed.*width 90, height 23/s);
  assert.match(sidebarTextForChange(c), /New display size/);
});

test('a paired picture with nothing different says so honestly', () => {
  const text = describeImageChange({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/img/same.png', alt: 'Same' },
    attrsAfter: { src: '/img/same.png', alt: 'Same' },
    attrChanges: [],
  });
  assert.match(text, /Nothing about this picture itself differs/);
  assert.doesNotMatch(text, /neither its address nor its description/);
});

test('a measured resize names the exact before number, never (none)', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/img/icon.png', alt: 'Icon' },
    attrsAfter: { src: '/img/icon.png', width: '90', height: '23', alt: 'Icon' },
    attrChanges: [
      { name: 'width', before: null, after: '90' },
      { name: 'height', before: null, after: '23' },
    ],
    sizeBefore: { w: 200, h: 100 },
    sizeAfter: { w: 90, h: 23 },
  };
  assert.equal(displaySizeValue(c, { name: 'width', before: null, after: '90' }, 'before'), '200 (natural size)');
  assert.equal(displaySizeValue(c, { name: 'width', before: null, after: '90' }, 'after'), '90');
  assert.match(describeImageChange(c), /width 200 \u2192 90/);
  assert.match(describeImageChange(c), /height 100 \u2192 23/);
  assert.ok(!dimensionChangeText(c).includes('(none)'));
});

test('max-width gates read as numbers, anything else as no gate', () => {
  assert.equal(maxWidthLimit('screen and (max-width: 767px)'), 767);
  assert.equal(maxWidthLimit('(max-width: 48em)'), 768);
  assert.equal(maxWidthLimit('all and (min-width: 900px)'), null);
  assert.equal(maxWidthLimit(''), null);
  assert.equal(maxWidthLimit(null), null);
});

test('a picture embedded inline says so instead of naming a lazy-load file', () => {
  const text = describeImageChange({
    type: 'changed', tag: 'img',
    attrsBefore: { src: '/images/icon-forum-c.png' },
    attrsAfter: { src: 'data:image/png;base64,iVBORw0KGgo=' },
    attrChanges: [{ name: 'src', before: '/images/icon-forum-c.png', after: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  assert.match(text, /embedded inline.*instead of loading icon-forum-c\.png/);
  assert.doesNotMatch(text, /lazy-loads/);
});

test('a size row whose number did not move is noise and drops out', () => {
  const c = {
    type: 'changed', tag: 'img',
    attrChanges: [
      { name: 'width', before: null, after: '256' },
      { name: 'height', before: null, after: '45' },
    ],
    sizeBefore: { w: 244, h: 45 },
    sizeAfter: { w: 256, h: 45 },
  };
  assert.equal(sizeRowIsNoop(c, c.attrChanges[0]), false);
  assert.equal(sizeRowIsNoop(c, c.attrChanges[1]), true);
  assert.match(dimensionChangeText(c), /width 244 \u2192 256/);
  assert.doesNotMatch(dimensionChangeText(c), /height/);
});

test('plain text rows render exactly as before', () => {
  const changed = sidebarTextForChange({ type: 'changed', tag: 'p', before: 'Fee $20.', after: 'Fee $25.' });
  assert.ok(changed.includes('Fee $20.') && changed.includes('Fee $25.') && changed.includes('&rarr;'));
  const added = sidebarTextForChange({ type: 'added', tag: 'p', after: 'Hello.' });
  assert.ok(added.includes('Hello.'));
});
