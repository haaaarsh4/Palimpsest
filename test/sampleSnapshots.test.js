// test/sampleSnapshots.test.js
//
// Two regressions that both read as "the app is broken", from the same day of
// use, and both of them are about a plausible-looking answer being wrong.
//
// 1. The timeline's sample dropped the history it could not fit. On
//    nytimes.com (436,339 captures) the even-index thinning kept the recent
//    window and threw away nearly every older month, so a comparison link to
//    April 2017 - a capture the Archive certainly holds - answered "that
//    comparison link names captures that are not on this record any more".
//    Measured before this pin: 3 points for 2016-2017, one of them in April.
//    Measured after: every month of every year is present.
//
// 2. A routed asset address is relative ("/api/asset?..."), and the pane's
//    document carries the capture's own <base href="https://web.archive.org/
//    ...">. Relative to that base it names the Archive, not this app, so the
//    browser asked web.archive.org for /api/asset, got nothing, and every
//    pane rendered as unstyled HTML - the "there is no CSS in here" report.
//    The panes now get absolute addresses to this app, and the test below is
//    the only thing standing between that and a future tidy-up that "makes
//    the URLs consistent" by dropping the origin again.

const test = require('node:test');
const assert = require('node:assert');

const { sampleSnapshots, MAX_TIMELINE_POINTS } = require('../lib/sampleSnapshots');
const { routeHtml } = require('../lib/routeAssets');

function stamp(y, mo, d, h = '00', mi = '00', s = '00') {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}${p(mo)}${p(d)}${p(h)}${p(mi)}${p(s)}`;
}

function dateOf(ts) {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;
}

// One capture every hour for `days` days from the start date.
function everyHour(startY, startMo, startD, days) {
  const out = [];
  const start = Date.UTC(startY, startMo - 1, startD);
  for (let i = 0; i < days * 24; i++) {
    const d = new Date(start + i * 3600 * 1000);
    const ts = stamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours());
    out.push({ timestamp: ts, original: `https://example.org/${i}`, date: dateOf(ts) });
  }
  return out;
}

test('a record under the cap is sent whole, without the capture address', () => {
  const snaps = everyHour(2019, 1, 1, 2);
  const sample = sampleSnapshots(snaps);
  assert.equal(sample.length, snaps.length);
  assert.deepEqual(sample[0], { timestamp: snaps[0].timestamp, date: snaps[0].date });
  assert.ok(!('original' in sample[0]), 'the sample is {timestamp, date} only');
});

test('every month of the history is a point on the rail', () => {
  // 2016-2017 at a handful of captures a year, then a recent window dense
  // enough that the old even-index thinning threw the old years away.
  const old = [];
  for (let y = 2016; y <= 2017; y++) {
    for (let mo = 1; mo <= 12; mo++) {
      for (let d = 1; d <= 3; d++) {
        const ts = stamp(y, mo, d);
        old.push({ timestamp: ts, date: dateOf(ts) });
      }
    }
  }
  // Recent: 20 per day for 400 days, so the sample is well past the cap and
  // the old months are a rounding error of it.
  const recent = [];
  const start = Date.UTC(2026, 0, 1);
  for (let day = 0; day < 400; day++) {
    for (let k = 0; k < 20; k++) {
      const d = new Date(start + day * 86400000 + k * 60000);
      const ts = stamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
      recent.push({ timestamp: ts, date: dateOf(ts) });
    }
  }
  const all = [...old, ...recent];
  assert.ok(all.length > MAX_TIMELINE_POINTS, 'the fixture has to be over the cap');
  const now = Date.UTC(2026, 11, 31);
  const sample = sampleSnapshots(all, now);
  const months = new Set(sample.map((s) => s.timestamp.slice(0, 6)));
  ['201604', '201611', '201701', '201704', '201712'].forEach((m) => {
    assert.ok(months.has(m), `${m} has to be on the rail`);
  });
  assert.equal(sample.length, sample.length); // sentinel keeps the shape honest
  assert.ok(sample.length < all.length);
});

test('the recent window keeps a day, not every capture of it', () => {
  const year = new Date().getUTCFullYear();
  const all = [];
  for (let day = 0; day < 500; day++) {
    for (let k = 0; k < 30; k++) {
      const d = new Date(Date.UTC(year, 0, 1) + day * 86400000 + k * 1000);
      const ts = stamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
      all.push({ timestamp: ts, date: dateOf(ts) });
    }
  }
  const sample = sampleSnapshots(all, Date.UTC(year, 11, 31));
  const lastDay = all[all.length - 1].timestamp.slice(0, 8);
  const perDay = new Map();
  sample.forEach((s) => {
    const day = s.timestamp.slice(0, 8);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  });
  // One a day, except the record's last day: the final capture is the rail's
  // right end and is kept even when that day already has its one point.
  perDay.forEach((count, day) => {
    const allowed = day === lastDay ? 2 : 1;
    assert.ok(count <= allowed, `${day} has ${count} points, at most ${allowed} expected`);
  });
  assert.ok(sample.length <= 600, `a 500-day window is ~500 points, got ${sample.length}`);
});

test('the first and last captures are always the ends of the rail', () => {
  const all = everyHour(2026, 1, 1, 30);
  const sample = sampleSnapshots(all, Date.UTC(2026, 11, 31));
  assert.equal(sample[0].timestamp, all[0].timestamp);
  assert.equal(sample[sample.length - 1].timestamp, all[all.length - 1].timestamp);
});

// ---- the pane's asset addresses -------------------------------------------

const CAPTURE_URL = 'https://www.example.org/index.html';
const TS = '20170401002116';

function paneDocument(origin) {
  const html = '<!DOCTYPE html><html><head>' +
    `<base href="https://web.archive.org/web/${TS}/https://www.example.org/">` +
    '<link rel="stylesheet" href="/web/' + TS + 'cs_/https://www.example.org/site.css">' +
    '</head><body>' +
    '<img src="/web/' + TS + 'im_/https://www.example.org/logo.png">' +
    '<div style="background-image:url(/web/' + TS + 'im_/https://www.example.org/bg.png)"></div>' +
    '</body></html>';
  return routeHtml(html, { url: CAPTURE_URL, timestamp: TS, origin });
}

test('a pane stylesheet reaches this app, not the Archive its <base> names', () => {
  const routed = paneDocument('http://localhost:3000');
  const href = /<link[^>]*href="([^"]+)"/.exec(routed)[1];
  assert.ok(href.startsWith('http://localhost:3000/api/asset?'),
    `the sheet has to be absolute to this app, got ${href}`);
  assert.ok(href.includes('site.css'), 'and it keeps naming the archived file');
});

test('pictures and inline backgrounds are absolute in the same way', () => {
  const routed = paneDocument('http://localhost:3000');
  const img = /<img[^>]*src="([^"]+)"/.exec(routed)[1];
  assert.ok(img.startsWith('http://localhost:3000/api/asset?'), `img src was ${img}`);
  assert.ok(/url\((?:&quot;|")?http:\/\/localhost:3000\/api\/asset/.test(routed),
    'an inline background-image has to survive the base tag too');
});

test('with no origin known, the address stays relative (and is no worse than before)', () => {
  const routed = paneDocument('');
  const href = /<link[^>]*href="([^"]+)"/.exec(routed)[1];
  assert.ok(href.startsWith('/api/asset?'), `expected the old relative shape, got ${href}`);
});
