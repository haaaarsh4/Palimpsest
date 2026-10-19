const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Sel = require('../public/selection.js');

function docFrom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  return { doc: dom.window.document, win: dom.window };
}

describe('isEdgeClick', () => {
  const rects = [{ left: 100, top: 50, right: 300, bottom: 90, width: 200, height: 40 }];
  it('takes the middle as content', () => {
    assert.equal(Sel.isEdgeClick(rects, 200, 70, 6), false);
  });
  it('takes the frame as selection', () => {
    assert.equal(Sel.isEdgeClick(rects, 102, 70, 6), true);
    assert.equal(Sel.isEdgeClick(rects, 298, 70, 6), true);
    assert.equal(Sel.isEdgeClick(rects, 200, 51, 6), true);
    assert.equal(Sel.isEdgeClick(rects, 200, 89, 6), true);
  });
  it('ignores clicks outside and tiny controls', () => {
    assert.equal(Sel.isEdgeClick(rects, 50, 70, 6), false);
    assert.equal(Sel.isEdgeClick([], 102, 70, 6), false);
    const icon = [{ left: 0, top: 0, right: 16, bottom: 16, width: 16, height: 16 }];
    assert.equal(Sel.isEdgeClick(icon, 1, 8, 6), false);
  });
});

describe('paneChangeIndex', () => {
  // Leaf ids restart at zero in every document: the removed Rent a Home
  // link's old id can share its number with the Ontario image's new id.
  // A click in the later pane must only match new ends, never old ones.
  const changes = [
    { type: 'removed', tag: 'a', oldId: 'pdiff-9' },
    { type: 'changed', tag: 'img', oldId: 'pdiff-3', newId: 'pdiff-9' },
  ];
  it('matches the new end from the later pane', () => {
    assert.equal(Sel.paneChangeIndex(changes, 'pdiff-9', 'new'), 1);
  });
  it('matches the old end from the earlier pane', () => {
    assert.equal(Sel.paneChangeIndex(changes, 'pdiff-9', 'old'), 0);
  });
  it('never spotlights the removed row for a later-pane image click', () => {
    // Before the side-aware lookup this returned 0 (Rent a Home).
    assert.notEqual(Sel.paneChangeIndex(changes, 'pdiff-9', 'new'), 0);
  });
  it('returns -1 for unknown ids and empty lists', () => {
    assert.equal(Sel.paneChangeIndex(changes, 'pdiff-99', 'new'), -1);
    assert.equal(Sel.paneChangeIndex([], 'pdiff-9', 'new'), -1);
    assert.equal(Sel.paneChangeIndex(changes, null, 'new'), -1);
  });
  it('matches either end when no side is known', () => {
    assert.equal(Sel.paneChangeIndex(changes, 'pdiff-9', null), 0);
    assert.equal(Sel.paneChangeIndex(changes, 'pdiff-3', null), 1);
  });
});

describe('showTargetFor', () => {
  it('redirects an option to its dropdown', () => {
    const { doc } = docFrom('<select id="r"><option id="o">Kitchener and Area</option></select>');
    const opt = doc.querySelector('#o');
    assert.equal(Sel.showTargetFor(opt), doc.querySelector('#r'));
  });
  it('leaves ordinary elements alone', () => {
    const { doc } = docFrom('<div id="d"><p id="p">text</p></div>');
    const p = doc.querySelector('#p');
    assert.equal(Sel.showTargetFor(p), p);
    assert.equal(Sel.showTargetFor(null), null);
  });
  it('falls back to the option when no dropdown wraps it', () => {
    const { doc } = docFrom('<div><option id="o">Orphan</option></div>');
    const opt = doc.querySelector('#o');
    assert.equal(Sel.showTargetFor(opt), opt);
  });
  it('names an option as a dropdown entry', () => {
    assert.match(Sel.describeElement('option'), /dropdown itself is highlighted/);
  });
});

describe('twinAccepts (duplicate disambiguation)', () => {
  it('keeps non-duplicates on the old any-text-match behavior', () => {
    assert.equal(Sel.twinAccepts('div.primary-menu > ul.nav-primary > li.mnunews', 'li.top-1 > ul#sub-nav > li.item-primary', false), true);
  });
  it('routes each News copy to its own container', () => {
    const primary = 'div.primary-menu > ul.nav-primary > li.mnunews';
    const subnav = 'li.top-1 > ul#sub-nav > li.item-primary';
    assert.equal(Sel.twinAccepts(primary, primary, true), true);
    assert.equal(Sel.twinAccepts(subnav, subnav, true), true);
    assert.equal(Sel.twinAccepts(primary, subnav, true), false);
    assert.equal(Sel.twinAccepts(subnav, primary, true), false);
  });
  it('reads the live breadcrumb in the diff path format', () => {
    const { doc } = docFrom('<div class="primary-menu"><ul class="nav-primary"><li class="mnunews"><a id="n" href="/news">News</a></li></ul></div>');
    assert.equal(Sel.livePathOf(doc.querySelector('#n')), 'div.primary-menu > ul.nav-primary > li.mnunews');
  });
});

describe('scroll math', () => {
  it('centers the target, never asking for a negative scroll', () => {
    assert.equal(Sel.computeCenteredScroll(0, 1000, 0, 20, 600), 710);
    assert.equal(Sel.computeCenteredScroll(2000, 2100, 0, 20, 600), 2000 + 2100 - 290);
    assert.equal(Sel.computeCenteredScroll(0, 100, 0, 20, 600), 0);
  });

  it('refuses a scroller whose range cannot reach the target', () => {
    assert.equal(Sel.canReachScroll(4905, 596, 3471), true);
    assert.equal(Sel.canReachScroll(596, 596, 3471), false);
    assert.equal(Sel.canReachScroll(300, 100, 250), false);
    assert.equal(Sel.canReachScroll(300, 100, 200), true);
  });

  it('calls a rect on screen only when it has a box in the viewport', () => {
    assert.equal(Sel.rectInPaneViewport({ top: 100, bottom: 200, left: 10, right: 100, width: 90, height: 100 }, 500, 600), true);
    assert.equal(Sel.rectInPaneViewport({ top: 2000, bottom: 2100, left: 10, right: 100, width: 90, height: 100 }, 500, 600), false);
    assert.equal(Sel.rectInPaneViewport({ top: 100, bottom: 100, left: 10, right: 10, width: 0, height: 0 }, 500, 600), false);
    assert.equal(Sel.rectInPaneViewport(null, 500, 600), false);
  });

  it('does not call a change below the fold on screen', () => {
    // Measured on apple.com: after the scroll watch called it settled, the
    // light sat 25px past the bottom of a 697-tall pane, so the reader got a
    // picked row and nothing visible to show for it. Reaching into the frame
    // is not being in it.
    const justPast = { top: 722, bottom: 804, left: 48, right: 178, width: 130, height: 82 };
    assert.equal(Sel.rectInPaneViewport(justPast, 1600, 697), false, 'twenty-five pixels below the fold is below the fold');
    // A sliver at the edge is the same failure, and the badge above the box
    // makes it worse: the word naming the change is off screen too.
    const edge = { top: 694, bottom: 776, left: 48, right: 178, width: 130, height: 82 };
    assert.equal(Sel.rectInPaneViewport(edge, 1600, 697), false, 'three pixels showing is not showing it');
    // Fully on screen is on screen, and so is a container taller than the
    // viewport: its top is above the fold but the reader is inside it.
    assert.equal(Sel.rectInPaneViewport({ top: 100, bottom: 180, left: 48, right: 178, width: 130, height: 80 }, 1600, 697), true);
    assert.equal(Sel.rectInPaneViewport({ top: -120, bottom: 900, left: 0, right: 900, width: 900, height: 1020 }, 1600, 697), true);
    // A one-pixel spacer still only needs its one pixel seen.
    assert.equal(Sel.rectInPaneViewport({ top: 300, bottom: 301, left: 10, right: 11, width: 1, height: 1 }, 1600, 697), true);
    assert.equal(Sel.rectInPaneViewport({ top: 800, bottom: 801, left: 10, right: 11, width: 1, height: 1 }, 1600, 697), false);
  });
});

describe('describeElement', () => {
  it('explains the tab title instead of assuming <title> is known', () => {
    assert.match(Sel.describeElement('title'), /browser tab title/);
    assert.match(Sel.describeElement('title'), /not words on the page/);
  });

  it('names everyday elements plainly', () => {
    assert.match(Sel.describeElement('h1'), /main heading/);
    assert.match(Sel.describeElement('h3'), /section heading/);
    assert.match(Sel.describeElement('a'), /link/);
    assert.match(Sel.describeElement('img'), /image/);
    assert.match(Sel.describeElement('p'), /paragraph/);
    assert.match(Sel.describeElement('li'), /list/);
  });

  it('falls back to the tag itself for the unknown', () => {
    assert.match(Sel.describeElement('marquee'), /<marquee>/);
    assert.match(Sel.describeElement(''), /element on the page/);
  });
});

describe('carousel month strip', () => {
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  const markup = () => {
    const slides = months
      .map((m) => `<div class="owl-item"><div class="item" data-hash="${m}"><h3>${m} question</h3></div></div>`)
      .join('');
    const strip = months
      .map((m) => `<a href="#${m}" class="button secondary url"><span${m === 'Oct' ? ' class="currentmonth"' : ''}>${m}</span></a>`)
      .join('');
    return `<div id="slide"><div class="owl-carousel owl-loaded palimpsest-revived" data-pal="0">`
      + `<div class="pal-track">${slides}</div>`
      + `<div class="owl-months">${strip}</div>`
      + `</div></div>`;
  };
  // Three slides across is this site's desktop tier, written as the custom
  // property the capture's stylesheet carries.
  const threeAcross = (doc) => {
    const style = doc.createElement('style');
    style.textContent = '.owl-carousel[data-pal="0"]{--pal-n:3;}';
    doc.head.appendChild(style);
  };

  it('moves the band to the month that was clicked', () => {
    const { doc } = docFrom(markup());
    threeAcross(doc);
    assert.equal(Sel.slideCarouselTo(doc, 'Sep'), true);
    const track = doc.querySelector('.pal-track');
    // Sep is 5 of 12, three across: centred means shift 4.
    assert.equal(track.style.transform, 'translateX(calc(-100% * 4 / 3))');
    const active = [...doc.querySelectorAll('.owl-item.active')].map((w) => w.querySelector('.item').getAttribute('data-hash'));
    assert.deepEqual(active, ['Aug', 'Sep', 'Oct'], 'the clicked month is in the middle of the window');
  });

  it('pulls back inside the run at either end', () => {
    const { doc } = docFrom(markup());
    threeAcross(doc);
    Sel.slideCarouselTo(doc, 'Apr');
    assert.equal(doc.querySelector('.pal-track').style.transform, 'translateX(calc(-100% * 0 / 3))');
    Sel.slideCarouselTo(doc, 'Mar');
    assert.equal(doc.querySelector('.pal-track').style.transform, 'translateX(calc(-100% * 9 / 3))');
  });

  it('moves the currentmonth the page drew, so the strip follows the band', () => {
    const { doc } = docFrom(markup());
    threeAcross(doc);
    Sel.slideCarouselTo(doc, 'Sep');
    const current = [...doc.querySelectorAll('.owl-months .currentmonth')].map((s) => s.textContent);
    assert.deepEqual(current, ['Sep'], 'one month is current, and it is the one clicked');
    assert.equal(doc.querySelector('.owl-months a[href="#Sep"]').classList.contains('current'), true);
  });

  it('stays put when there is nothing to slide', () => {
    const { doc } = docFrom(markup());
    assert.equal(Sel.slideCarouselTo(doc, 'Nope'), false, 'a name no slide carries moves nothing');
    assert.equal(Sel.slideCarouselTo(doc, ''), false);
    assert.equal(doc.querySelector('.pal-track').style.transform, '');
  });
});

describe('carousel slide alignment', () => {
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  const band = () => {
    const slides = months
      .map((m) => `<div class="owl-item${m === 'Oct' ? ' active center' : ''}"><div class="item" data-hash="${m}"><img src="${m}.jpg"><h3><a href="#">How do I apply for ${m}?</a></h3></div></div>`)
      .join('');
    return `<div class="owl-carousel owl-loaded palimpsest-revived" data-pal="0"><div class="pal-track">${slides}</div></div>`;
  };
  const tier = (doc) => {
    const style = doc.createElement('style');
    style.textContent = '.owl-carousel[data-pal="0"]{--pal-n:2;}';
    doc.head.appendChild(style);
  };

  it('moves the whole slide a caption belongs to, never the caption', () => {
    // The caption is inset inside its picture. Aligning the caption's own
    // left edge slid the picture out of frame and the words started
    // mid-sentence - the reported "slided to the left".
    const { doc } = docFrom(band());
    tier(doc);
    const caption = doc.querySelector('.item[data-hash="Aug"] a');
    const moved = Sel.moveCarouselToNode(caption);
    assert.ok(moved && moved.undo, 'the band moved');
    // Aug is 4 of 6 and two are across: the window starts at Aug itself
    // (an even window centres on its left slide, as shiftFor() does).
    assert.equal(months.indexOf('Aug'), 4);
    assert.equal(doc.querySelector('.pal-track').style.transform, 'translateX(calc(-100% * 4 / 2))');
    const active = [...doc.querySelectorAll('.owl-item.active')].length;
    assert.equal(active, 2, 'the window is two slides, both fully in frame');
  });

  it('undo puts the band and its dimming back exactly', () => {
    const { doc } = docFrom(band());
    tier(doc);
    const before = doc.querySelector('.pal-track').style.transform;
    const beforeActive = [...doc.querySelectorAll('.owl-item.active')].length;
    const moved = Sel.moveCarouselToNode(doc.querySelector('.item[data-hash="Jun"] a'));
    moved.undo();
    assert.equal(doc.querySelector('.pal-track').style.transform, before);
    assert.equal([...doc.querySelectorAll('.owl-item.active')].length, beforeActive);
  });

  it('leaves a node that is not in a band alone', () => {
    const { doc } = docFrom('<p id="p">plain text</p>');
    assert.equal(Sel.moveCarouselToNode(doc.querySelector('#p')), null);
    assert.equal(Sel.moveCarouselToNode(null), null);
  });

  it('moves instantly when the caller measures the target right after', () => {
    // A selection reads the box of the picked picture in the same task as the
    // move. With the 0.35s ease still running it measures the old place and
    // believes the picture is still parked, which is how the whole band got
    // marked. `instant` sets the final transform before anything is read.
    const { doc } = docFrom(`<div class="wrap">${band()}</div>`);
    tier(doc);
    const track = doc.querySelector('.pal-track');
    const moved = Sel.moveCarouselToNode(doc.querySelector('.item[data-hash="Aug"] a'), { instant: true });
    assert.ok(moved);
    assert.equal(track.style.transition, 'none');
    assert.equal(track.style.transform, 'translateX(calc(-100% * 4 / 2))');
    moved.undo();
    assert.equal(track.style.transform, '');
    assert.equal(track.style.transition, '');
  });

  it('keeps the month strip pointing at the slide the band moved to', () => {
    // The strip under settlement.org's Daily Life carousel is plain markup that
    // names slides with `href="#Jun"`; the page draws `current` on the month
    // the capture opened at. A band moved to another slide with the strip still
    // on the old month looks broken, so the strip follows, and goes back with
    // the move.
    const strip = `<div class="owl-months">` +
      months.map((m) => `<a href="#${m}"${m === 'Sep' ? ' class="current"' : ''}><span${m === 'Sep' ? ' class="currentmonth"' : ''}>${m}</span></a>`).join('') +
      `</div>`;
    const { doc } = docFrom(`<div class="wrap">${strip}${band()}</div>`);
    tier(doc);
    const moved = Sel.moveCarouselToNode(doc.querySelector('.item[data-hash="Jun"] a'));
    assert.ok(moved);
    assert.equal(doc.querySelector('a[href="#Jun"]').classList.contains('current'), true);
    assert.equal(doc.querySelector('a[href="#Jun"] span').classList.contains('currentmonth'), true);
    assert.equal(doc.querySelector('a[href="#Sep"]').classList.contains('current'), false);
    assert.equal(doc.querySelector('a[href="#Sep"] span').classList.contains('currentmonth'), false);
    moved.undo();
    assert.equal(doc.querySelector('a[href="#Sep"]').classList.contains('current'), true, 'the page\u2019s own month comes back');
    assert.equal(doc.querySelector('a[href="#Sep"] span').classList.contains('currentmonth'), true);
    assert.equal(doc.querySelector('a[href="#Jun"]').classList.contains('current'), false);
  });
});
