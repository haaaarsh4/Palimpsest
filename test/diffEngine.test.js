// test/diffEngine.test.js
//
// The change list is the thing this app exists to produce, and almost every way
// it can be wrong is a way nobody notices: a link that did not move reported as
// having moved, a paragraph that was rewritten reported as deleted and replaced,
// an image re-saved by the archive reported as a new image. Each test below is
// one of those, written against the exact shapes the Wayback Machine serves and
// the exact shapes this project's own pipeline produces (a document with the
// archive's <base> in its head is what every capture looks like by the time it
// reaches here, see lib/prepareCapture.js).
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { diffSnapshots } = require('../lib/diffEngine');
const { targetKey, sameTarget, classifyUrlChange, resolveTarget } = require('../lib/urlTarget');

const OLD_BASE = 'https://web.archive.org/web/20160710035916/http://etablissement.org/';
const NEW_BASE = 'https://web.archive.org/web/20261002005041/https://etablissement.org/';

function page(base, body) {
  return `<!DOCTYPE html><html><head><base href="${base}"><title>t</title></head><body>${body}</body></html>`;
}

function changesOf(beforeBody, afterBody) {
  return diffSnapshots(page(OLD_BASE, beforeBody), page(NEW_BASE, afterBody), {}).changes;
}

function oneChange(beforeBody, afterBody) {
  const changes = changesOf(beforeBody, afterBody);
  assert.equal(changes.length, 1, `expected exactly one change, got ${JSON.stringify(changes.map((c) => c.type))}`);
  return changes[0];
}

// ---------------------------------------------------------------- the report

test('a link the archive spelled differently in each capture is not a change', () => {
  // The bug this whole module was written for. Same link, same text, same text
  // before and after, only the archive's own prefix differs, which is a fact
  // about the capture date rather than about the site.
  const changes = changesOf(
    '<div id="wrapper"><form id="ctl01"><header class="header">' +
      '<a href="/web/20160710035916/http://etablissement.org/">Etablissement.Org</a>' +
      '</header></form></div>',
    '<div id="wrapper"><form id="ctl01"><header class="header">' +
      '<a href="/web/20261002005041/https://etablissement.org/">Etablissement.Org</a>' +
      '</header></form></div>'
  );
  assert.deepEqual(changes, []);
});

test('a relative link and the archive rewriting of it are the same link', () => {
  const changes = changesOf(
    '<a href="index.aspx">Home</a>',
    '<a href="/web/20261002005041/https://etablissement.org/index.aspx">Home</a>'
  );
  assert.deepEqual(changes, []);
});

test('an image the archive re-pointed is not a change', () => {
  const changes = changesOf(
    '<img src="/web/20160710035916/http://etablissement.org/img/logo.gif" alt="Logo">',
    '<img src="/web/20261002005041/https://etablissement.org/img/logo.gif" alt="Logo">'
  );
  assert.deepEqual(changes, []);
});

test('a link that really moved is one change, described by its destination', () => {
  const c = oneChange(
    '<a href="/web/20160710035916/http://etablissement.org/contact/">Contact</a>',
    '<a href="/web/20261002005041/https://etablissement.org/fees/">Contact</a>'
  );
  assert.equal(c.type, 'changed');
  assert.equal(c.textChanged, false);
  assert.equal(c.urlChanges.length, 1);
  assert.equal(c.urlChanges[0].kind, 'page');
  assert.equal(c.urlChanges[0].text, 'Same site, but it now points to a different page: /contact/ → /fees/.');
  // Traceable: the destination, not the archive's rewrite of it.
  assert.equal(c.urlChanges[0].traceUrl, 'https://etablissement.org/fees/');
  // And what a person sees as before/after is still what the page says.
  assert.deepEqual(c.attrChanges, [{
    name: 'href',
    before: '/web/20160710035916/http://etablissement.org/contact/',
    after: '/web/20261002005041/https://etablissement.org/fees/',
  }]);
});

test('an image whose file really changed is described as a file, not a page', () => {
  const c = oneChange(
    '<img src="/web/20160710035916/http://etablissement.org/img/old.gif" alt="Logo">',
    '<img src="/web/20261002005041/https://etablissement.org/img/new.gif" alt="Logo">'
  );
  assert.equal(c.type, 'changed');
  assert.equal(c.urlChanges[0].kind, 'page');
  assert.equal(c.urlChanges[0].text, 'Same site, but it now points to a different file: /img/old.gif → /img/new.gif.');
});

test('a reworded paragraph is one change, not a delete and an insert', () => {
  const c = oneChange('<p>The annual fee is $20.</p>', '<p>The annual fee is $25.</p>');
  assert.equal(c.type, 'changed');
  assert.equal(c.textChanged, true);
  assert.equal(c.before, 'The annual fee is $20.');
  assert.equal(c.after, 'The annual fee is $25.');
});

test('an unrelated paragraph replacing another is a removal and an addition', () => {
  const changes = changesOf(
    '<p>Parking is available behind the building.</p>',
    '<p>Our offices are closed on statutory holidays.</p>'
  );
  assert.deepEqual(changes.map((c) => c.type).sort(), ['added', 'removed']);
});

test('an element that only moved is one change, marked as having moved', () => {
  const changes = changesOf(
    '<div id="nav"><a href="/web/20160710035916/http://etablissement.org/a">Alpha</a>' +
      '<a href="/web/20160710035916/http://etablissement.org/b">Beta</a></div>',
    '<div id="nav"><a href="/web/20261002005041/https://etablissement.org/b">Beta</a>' +
      '<a href="/web/20261002005041/https://etablissement.org/a">Alpha</a></div>'
  );
  // A swap stays a swap in the change counts, the page has the same two links,
  // in a different order, but whatever the sequence diff could not match in
  // order must not be reported as a deletion plus a new element.
  assert.ok(changes.every((c) => c.type === 'changed'), JSON.stringify(changes));
  assert.ok(changes.every((c) => c.moved === true));
  assert.equal(new Set(changes.map((c) => c.tag)).size, 1);
});

test('a changed image keeps its full attributes so the panel can name it', () => {
  // The sidebar used to render a changed <img> as a bare arrow: both ends'
  // text is empty, and attrChanges holds only the file that moved, so the
  // unchanged alt text, the only words naming the picture, was dropped.
  // The full snapshots stay on the change for exactly that reason.
  const c = oneChange(
    '<img src="/web/20160710035916/http://etablissement.org/img/old.gif" alt="Logo">',
    '<img src="/web/20261002005041/https://etablissement.org/img/new.gif" alt="Logo">'
  );
  assert.equal(c.type, 'changed');
  assert.deepEqual(c.attrsBefore, {
    src: '/web/20160710035916/http://etablissement.org/img/old.gif',
    alt: 'Logo',
  });
  assert.deepEqual(c.attrsAfter, {
    src: '/web/20261002005041/https://etablissement.org/img/new.gif',
    alt: 'Logo',
  });
});

test('a repeated image is flagged, and pinned to its clipped carousel slide', () => {
  // Measured on settlement.org Jun 2016 → Oct 2026: four changed <img> rows
  // were repeats of one carousel image, and the earlier pane marked a copy the
  // band had clipped out of view, so selecting the change lit nothing up. The
  // reader cannot see that from the change itself, so the engine says it.
  const page3 = (srcs) =>
    '<div class="owl-carousel palimpsest-revived"><div class="pal-track">' +
    srcs.map((s) => `<div class="owl-item"><div class="item"><img src="${s}" alt=""></div></div>`).join('') +
    '</div></div>';
  const changes = changesOf(page3(['/a.png', '/b.png', '/b.png']), page3(['/a.png', '/b.png', '/change.png']));
  const changed = changes.find((c) => c.tag === 'img');
  assert.ok(changed, JSON.stringify(changes.map((c) => [c.tag, c.type])));
  assert.equal(changed.type, 'changed');
  assert.equal(changed.duplicate, true, 'the page repeats this image');
  assert.deepEqual(changed.carousel, { size: 3, index: 2 }, 'which clipped slide it sits in');
});

test('a one-off image is not flagged as duplicated', () => {
  const c = oneChange(
    '<img src="/web/20160710035916/http://etablissement.org/img/old.gif" alt="Logo">',
    '<img src="/web/20261002005041/https://etablissement.org/img/new.gif" alt="Logo">'
  );
  assert.equal(c.duplicate, false);
});

test('an added image carries its file and description', () => {
  const changes = changesOf(
    '<p>Keep</p>',
    '<p>Keep</p><img src="/web/20261002005041/https://etablissement.org/img/new.gif" alt="Logo">'
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'added');
  assert.deepEqual(changes[0].attrsAfter, {
    src: '/web/20261002005041/https://etablissement.org/img/new.gif',
    alt: 'Logo',
  });
});

test('an attribute-only change keeps its text and reports the attribute', () => {
  const c = oneChange(
    '<a href="/web/20160710035916/http://etablissement.org/x" title="Old">Handbook</a>',
    '<a href="/web/20261002005041/https://etablissement.org/x" title="New">Handbook</a>'
  );
  assert.equal(c.textChanged, false);
  assert.deepEqual(c.attrChanges, [{ name: 'title', before: 'Old', after: 'New' }]);
  // The href was rewritten by the archive and did not move, so it says nothing.
  assert.deepEqual(c.urlChanges, []);
});

test('a hidden form field is not content, so its machine state is not a change', () => {
  // ASP.NET's __VIEWSTATE is a base64 blob that differs on every render. Read as
  // content, it is a change nobody made and nobody can see; measured on a real
  // pair of captures, two of twenty-four "changed" entries were exactly this.
  const changes = changesOf(
    '<form><input type="hidden" name="__VIEWSTATE" value="/wEPDwUJMjU4NTU2Mjc0ZGQ="><p>Same text.</p></form>',
    '<form><input type="hidden" name="__VIEWSTATE" value="WxlFLxIzzztVd1EvIaUXfCz/"><p>Same text.</p></form>'
  );
  assert.deepEqual(changes, []);
});

test('a visible field that really changed is still reported', () => {
  const c = oneChange(
    '<input type="text" placeholder="Search">',
    '<input type="text" placeholder="Search this site">'
  );
  assert.equal(c.type, 'changed');
  assert.deepEqual(c.attrChanges, [{ name: 'placeholder', before: 'Search', after: 'Search this site' }]);
});

test('www and no-www are the same site', () => {
  assert.equal(sameTarget('http://www.ocasi.org/', 'http://ocasi.org/'), true);
  assert.equal(sameTarget('http://www.ocasi.org/a', 'http://www.ocasi.org/b'), false);
  const changes = changesOf(
    '<a href="/web/20160710035916/http://www.ocasi.org/">OCASI</a>',
    '<a href="/web/20261002005041/https://ocasi.org/">OCASI</a>'
  );
  assert.deepEqual(changes, []);
});

test('a genuinely new element is an addition', () => {
  const changes = changesOf('<p>Fees apply.</p>', '<p>Fees apply.</p><p>New this year: online payment.</p>');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'added');
});

test('a removed element is a removal', () => {
  const changes = changesOf('<p>Fees apply.</p><p>Closed Sundays.</p>', '<p>Fees apply.</p>');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'removed');
  assert.equal(changes[0].before, 'Closed Sundays.');
});

test('the counts add up the way the captions promise they do', () => {
  const { counts } = diffSnapshots(
    page(OLD_BASE, '<h1>Welcome</h1><p>The fee is $20.</p><p>Old news.</p>'),
    page(NEW_BASE, '<h1>Welcome</h1><p>The fee is $25.</p><p>Brand new announcement text.</p>'),
    {}
  );
  assert.deepEqual(counts, { added: 1, removed: 1, changed: 1 });
});

test('the change list carries no working fields into the payload', () => {
  const diff = diffSnapshots(
    page(OLD_BASE, '<p>One.</p><p>Two.</p>'),
    page(NEW_BASE, '<p>Two.</p><p>One.</p>'),
    {}
  );
  // `signature` and `node` are for the engine's own move detection. A DOM node
  // left in the array would blow up on JSON.stringify, in a response, a long way
  // from here.
  assert.doesNotThrow(() => JSON.stringify(diff));
  diff.changes.forEach((c) => {
    assert.equal(c.signature, undefined);
    assert.equal(c.node, undefined);
  });
  // A path a person can read. The URL parser percent-encodes every character it
  // dislikes, so a sentence built from the parsed form would say
  // "/%7Bpage%7D → /%7Bsection%7D", correct, and no use to anybody.
  const unresolved = changesOf(
    '<a href="{page}">Handbook</a>',
    '<a href="{section}">Handbook</a>'
  );
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].urlChanges[0].text, 'Same site, but it now points to a different page: /{page} → /{section}.');
});

// ---------------------------------------------------------------- urlTarget

test('archive prefixes come off, and what is left is the real destination', () => {
  assert.equal(
    targetKey('/web/20160710035916/http://etablissement.org/', OLD_BASE),
    'etablissement.org/'
  );
  const t = resolveTarget('/web/20261002005041/https://etablissement.org/fees/?a=1#top', NEW_BASE);
  assert.equal(t.target, 'https://etablissement.org/fees/?a=1#top');
  assert.equal(t.archiveTimestamp, '20261002005041');
  // The archive's rewrite is still what a browser would request, and it is kept
  // for that reason rather than for comparison.
  assert.equal(t.href, 'https://web.archive.org/web/20261002005041/https://etablissement.org/fees/?a=1#top');
});

test('http and https are the same destination', () => {
  assert.equal(sameTarget('http://x.org/fees', 'https://x.org/fees'), true);
});

test('a trailing slash is a difference, and it is named as one', () => {
  assert.equal(sameTarget('http://x.org/fees/', 'http://x.org/fees'), false);
  const c = classifyUrlChange('http://x.org/fees/', 'https://x.org/fees', {}, {});
  assert.equal(c.kind, 'slash');
  assert.equal(c.text, 'Same page, written without a trailing slash now: /fees/ → /fees.');
});

test('different pages, hosts, parameters and fragments all get their own sentence', () => {
  assert.match(classifyUrlChange('http://x.org/a', 'http://x.org/b').text, /different page: \/a → \/b/);
  assert.match(classifyUrlChange('http://x.org/a', 'http://y.org/a').text, /different domain entirely: x\.org → y\.org/);
  assert.match(classifyUrlChange('http://x.org/a?p=1', 'http://x.org/a?p=2').text, /different URL parameters attached: \?p=1 → \?p=2/);
  assert.match(classifyUrlChange('http://x.org/a#one', 'http://x.org/a#two').text, /jumps to a different section/);
});

test('an inline placeholder swapping with a file gets its own sentence', () => {
  const toInline = classifyUrlChange('http://x.org/pic.jpg', 'data:image/png;base64,AAA', {}, { noun: 'file' });
  assert.equal(toInline.kind, 'inline');
  assert.match(toInline.text, /tiny inline placeholder picture instead of loading pic\.jpg/);
  const fromInline = classifyUrlChange('data:image/png;base64,AAA', 'http://x.org/pic.jpg', {}, { noun: 'file' });
  assert.equal(fromInline.kind, 'inline');
  assert.match(fromInline.text, /loads the file pic\.jpg instead/);
  assert.doesNotMatch(toInline.text + fromInline.text, /different domain/);
});

test('marked images get an inner outline on all four sides, not an inset shadow', () => {
  // Inset box-shadows paint under an <img>'s content, so the ring survived
  // only in the baseline gap below the picture ("outline only at the
  // bottom"). Images get outline-with-negative-offset instead, which
  // paints above the content on every side.
  const d = diffSnapshots(
    page(OLD_BASE, '<img src="a.png" alt="Icon">'),
    page(NEW_BASE, '<img src="b.png" alt="Icon">'),
    {}
  );
  assert.match(d.newHtml, /img\[data-pdiff-added\], img\[data-pdiff-changed\]/);
  assert.match(d.newHtml, /outline: 2px solid .* !important;\s*outline-offset: -2px !important;/);
  assert.match(d.oldHtml, /img\[data-pdiff-removed\]/);
});

test('marked pictures are never lifted above the page\'s own overlays', () => {
  // A marked <img> used to get position+z-index like every other mark,
  // which hoisted it above absolutely-positioned overlays and buried a
  // carousel caption bar under its own picture. The outline paints above
  // the picture with no lifting, so pictures get none, and neither does
  // the badge wrapper around a selected one.
  const d = diffSnapshots(
    page(OLD_BASE, '<img src="a.png" alt="Icon">'),
    page(NEW_BASE, '<img src="b.png" alt="Icon">'),
    {}
  );
  const imgRule = d.newHtml.match(/img\[data-pdiff-added\][^{]*\{[^}]*\}/);
  assert.ok(imgRule, 'expected a picture-specific mark rule');
  const declarations = imgRule[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(declarations, /z-index/);
  assert.doesNotMatch(declarations, /position/);
  // No badge is drawn into the snapshot at all: neither the ::after word nor
  // the wrapper span it used to need on replaced elements. The word is the
  // comparison's own chrome, in a layer over the pane's frame.
  assert.doesNotMatch(d.newHtml, /\.pdiff-selected::after/);
  assert.doesNotMatch(d.newHtml, /\.pdiff-selected-badge/);
  assert.match(d.newHtml, /\.pdiff-selected \{[\s\S]*?--pdiff-badge:/,
    'the picked element still carries the colour the host reads for its badge');
});

test('data-src compares as a destination, width and height ride along on images', () => {
  const d = diffSnapshots(
    page(OLD_BASE, '<img src="a.png" alt="Icon">'),
    page(NEW_BASE, '<img src="a.png" width="90" height="23" alt="Icon">'),
    {}
  );
  const img = d.changes.find((c) => c.tag === 'img');
  assert.ok(img, 'expected the resized icon to be flagged');
  assert.ok((img.attrChanges || []).some((a) => a.name === 'width'));
});

test('empty query segments are not a change, parameter order is', () => {
  assert.equal(sameTarget('http://x.org/a?b=1', 'http://x.org/a?b=1&'), true);
  assert.equal(sameTarget('http://x.org/a?b=1&c=2', 'http://x.org/a?c=2&b=1'), false);
});

test('a merged fragment run points both click directions at the outlined parent', () => {
  // Rainbow-text headings (one <font> per run of letters) merge into a
  // single change outlined on their shared parent. That outline is only
  // clickable when the parent carries an id the change points at: before
  // this, the change kept the first fragment's id while the parent had
  // none, so sidebar jumps landed on a markless node and pane clicks on
  // the parent resolved to nothing.
  const r = diffSnapshots(
    page(OLD_BASE, '<h2><font>AB</font><font>CD</font></h2><p>same</p>'),
    page(NEW_BASE, '<p>same</p>'),
    {}
  );
  assert.equal(r.changes.length, 1);
  const c = r.changes[0];
  assert.equal(c.type, 'removed');
  assert.ok(c.oldId, 'merged change needs an id to jump to');
  assert.ok(
    r.oldHtml.includes(`<h2 data-pdiff-removed="true" data-pdiff-id="${c.oldId}"`),
    'the outlined parent must carry the id the change points at'
  );
});

test('a removed line of single-letter links merges into the line, not the letters', () => {
  // An alphabet strip reads to the leaf walk as one one-letter element per
  // letter, so a removed line used to come back as eight "removed <a>" rows.
  // A person would say the line went away, once: the run merges onto its
  // shared parent with the joined letters.
  const nav = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">${'ABCDEFGH'[i]}</a>`).join(' ');
  const c = oneChange(`<div class="az">${nav}</div><p>same</p>`, '<p>same</p>');
  assert.equal(c.type, 'removed');
  assert.equal(c.tag, 'div');
  assert.equal(c.before, 'A B C D E F G H');
});

test('an added line of single-letter links merges the same way', () => {
  const nav = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">${'ABCDEFGH'[i]}</a>`).join(' ');
  const c = oneChange('<p>same</p>', `<div class="az">${nav}</div><p>same</p>`);
  assert.equal(c.type, 'added');
  assert.equal(c.tag, 'div');
  assert.equal(c.after, 'A B C D E F G H');
});

test('one linked letter that genuinely moved is still exactly one change', () => {
  // Changed pairs never merge: hiding the one letter that moved inside its
  // unchanged neighbours would say which line changed but not which letter.
  const nav = (href3) =>
    Array.from({ length: 8 }, (_, i) => `<a href="${i === 3 ? href3 : `/p${i}`}">${'ABCDEFGH'[i]}</a>`).join(' ');
  const c = oneChange(`<div class="az">${nav('/p3')}</div>`, `<div class="az">${nav('/other')}</div>`);
  assert.equal(c.type, 'changed');
  assert.equal(c.tag, 'a');
  assert.equal(c.after, 'D');
});

test('an inserted picture with its own description never steals a neighboring pairing', () => {
  // The forum-icon/211-logo mismatch: old [jobs, guide, forum, news], new
  // the same slots gone inline with a 211 logo inserted mid-run. The 211
  // declares its own alt while the old icon has none, so they must never
  // pair: the icons become inline and the 211 is one addition.
  const pix = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const changes = changesOf(
    '<div><img src="/images/icon-alt-jobs.png"><img src="/images/icon-apt-guide.png">' +
      '<img src="/images/icon-forum-c.png"><img src="/images/icon-news.png"></div>',
    '<div><img src="' + pix + '"><img src="' + pix + '">' +
      '<img src="/images/logos/211-logo.png" alt="211Toronto.ca" width="50" height="32">' +
      '<img src="' + pix + '"><img src="' + pix + '"></div>'
  );
  const kinds = changes.map((c) => c.type).sort();
  assert.deepEqual(kinds, ['added', 'changed', 'changed', 'changed', 'changed']);
  const added = changes.filter((c) => c.type === 'added');
  assert.equal(added.length, 1);
  assert.ok(String(added[0].attrsAfter.src).includes('211-logo.png'));
  // No change may name the 211 as the after of a forum icon.
  changes.filter((c) => c.type === 'changed').forEach((c) => {
    assert.doesNotMatch(String((c.attrsAfter && c.attrsAfter.src) || ''), /211-logo/);
  });
});

test('a value that is not a URL is compared as the text it is', () => {
  assert.equal(sameTarget('{page}', '{page}'), true);
  assert.equal(sameTarget('{page}', '{section}'), false);
  assert.equal(sameTarget('mailto:info@x.org', 'mailto:info@x.org'), true);
  assert.equal(sameTarget('mailto:info@x.org', 'mailto:other@x.org'), false);
  assert.equal(resolveTarget('javascript:void(0)').resolved, true);
  assert.equal(resolveTarget('{page}').resolved, false);
  assert.equal(resolveTarget('   '), null);
});

test('an unrelated picture inserted before an image does not steal its pairing', () => {
  // The forum-icon/211-logo mismatch: the later capture holds a new 211
  // logo ahead of the same forum icon. The icon must pair with itself
  // (no change), leaving the logo as one addition, never as
  // "icon-forum-c.png changed into 211-logo.png".
  const changes = changesOf(
    '<div><img src="/img/icon-forum-c.png" alt="Forum"><p>talk</p></div>',
    '<div><img src="/img/211-logo.png" alt="211 Toronto">' +
      '<img src="/img/icon-forum-c.png" alt="Forum"><p>talk</p></div>'
  );
  assert.equal(changes.length, 1, JSON.stringify(changes.map((c) => [c.type, c.tag])));
  assert.equal(changes[0].type, 'added');
  assert.equal(changes[0].tag, 'img');
});

test('a resized icon still pairs with itself when a new picture sits ahead of it', () => {
  // Harder variant: the kept icon also gained declared sizes, so its
  // signature differs and both pictures land in one align run. The strong
  // same-file pairing must win over the positional stranger.
  const changes = changesOf(
    '<div><img src="/img/icon-forum-c.png" alt="Forum"><p>talk</p></div>',
    '<div><img src="/img/211-logo.png" alt="211 Toronto">' +
      '<img src="/img/icon-forum-c.png" width="50" height="50" alt="Forum"><p>talk</p></div>'
  );
  const kinds = changes.map((c) => c.type).sort();
  assert.deepEqual(kinds, ['added', 'changed']);
  const changed = changes.find((c) => c.type === 'changed');
  assert.equal(changed.tag, 'img');
  assert.ok(String(changed.attrsAfter.src).includes('icon-forum-c.png'));
  const added = changes.find((c) => c.type === 'added');
  assert.ok(String(added.attrsAfter.src).includes('211-logo.png'));
});
