const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Nav = require('../public/paneNav.js');

describe('displayUrl', () => {
  it('shows the page address, not the archive copy address', () => {
    assert.equal(
      Nav.displayUrl('https://web.archive.org/web/20160620235517/http://settlement.org/firstdays/'),
      'http://settlement.org/firstdays/'
    );
    assert.equal(
      Nav.displayUrl('https://web.archive.org/web/20261002005041/https://settlement.org/firstdays/'),
      'https://settlement.org/firstdays/'
    );
  });

  it('handles archive modifiers (id_, if_, bare)', () => {
    assert.equal(
      Nav.displayUrl('https://web.archive.org/web/20261002005041id_/https://settlement.org/content/site.css'),
      'https://settlement.org/content/site.css'
    );
    assert.equal(
      Nav.displayUrl('http://web.archive.org/web/20160726061652if_/http://settlement.org/'),
      'http://settlement.org/'
    );
  });

  it('passes live and typed addresses through untouched', () => {
    assert.equal(Nav.displayUrl('https://settlement.org/firstdays/'), 'https://settlement.org/firstdays/');
    assert.equal(Nav.displayUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  });

  it('passes garbage through rather than blanking the bar', () => {
    assert.equal(Nav.displayUrl(''), '');
    assert.equal(Nav.displayUrl('https://web.archive.org/web/'), 'https://web.archive.org/web/');
    assert.equal(Nav.displayUrl(null), null);
  });
});

describe('sameArchivePage', () => {
  it('treats different captures of one page as the same page', () => {
    // The EN->FR round trip: the toggle lands on another capture of the
    // page the comparison started from, and the pane must restore home.
    assert.equal(
      Nav.sameArchivePage(
        'https://web.archive.org/web/20261002005041/https://settlement.org/',
        'https://web.archive.org/web/20150914235916/http://settlement.org/'
      ),
      true
    );
  });

  it('ignores scheme, www, trailing slash, query and fragment', () => {
    assert.equal(Nav.sameArchivePage('http://www.settlement.org', 'https://settlement.org/?lang=fr#top'), true);
    assert.equal(
      Nav.sameArchivePage(
        'https://web.archive.org/web/20261002005041id_/https://settlement.org/',
        'https://web.archive.org/web/20150914235916if_/http://settlement.org/'
      ),
      true
    );
  });

  it('matches a home built from a bare stored address against a followed absolute link', () => {
    // The real round trip: state.url is stored bare (host plus path, no
    // scheme), so the home address is `.../web/<ts>/settlement.org` while
    // every followed link resolves absolute. Without the bare-host read
    // these never compare equal and the return home renders a plain
    // capture with no highlights instead of the comparison.
    assert.equal(
      Nav.sameArchivePage(
        'https://web.archive.org/web/20261004140241/https://settlement.org/',
        'https://web.archive.org/web/20261002005041/settlement.org'
      ),
      true
    );
    assert.equal(Nav.innerPageKey('settlement.org'), Nav.innerPageKey('https://settlement.org/'));
  });

  it('tells two different pages apart', () => {
    assert.equal(
      Nav.sameArchivePage(
        'https://web.archive.org/web/20261002005041/https://etablissement.org/',
        'https://web.archive.org/web/20150914235916/http://settlement.org/'
      ),
      false
    );
    assert.equal(Nav.sameArchivePage('https://settlement.org/fees/', 'https://settlement.org/about/'), false);
    assert.equal(Nav.sameArchivePage('', 'https://settlement.org/'), false);
    assert.equal(Nav.sameArchivePage(null, null), false);
  });
});

describe('isSamePageFragment', () => {
  it('reads a bare "#name" as a spot on this page', () => {
    // The month strip under a carousel: <a href="#Sep">. In a srcdoc pane the
    // resolved href is the archive's full URL and the document is
    // about:srcdoc, so only the attribute itself can answer this.
    assert.equal(Nav.isSamePageFragment('#Sep'), true);
    assert.equal(Nav.isSamePageFragment('#main-content'), true);
    assert.equal(Nav.isSamePageFragment('  #top'), true);
    assert.equal(Nav.fragmentName('#Sep'), 'Sep');
    assert.equal(Nav.fragmentName('#'), '');
  });

  it('never mistakes another page for one', () => {
    assert.equal(Nav.isSamePageFragment('https://settlement.org/#Sep'), false);
    assert.equal(Nav.isSamePageFragment('/ontario/health/#fees'), false);
    assert.equal(Nav.isSamePageFragment(''), false);
    assert.equal(Nav.isSamePageFragment(null), false);
    assert.equal(Nav.fragmentName('https://settlement.org/#Sep'), '');
  });
});
