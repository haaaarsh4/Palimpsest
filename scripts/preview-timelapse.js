// scripts/preview-timelapse.js
//
// A preview harness for the timelapse, in the same spirit as
// scripts/preview-dashboard.js and for the same reason: reaching the film for
// real means a slow Wayback round trip, and the one thing you cannot eyeball
// without watching it move is a film.
//
// It inlines the REAL styles.css, the REAL archiveStore.js, the REAL
// dashboard.js, the REAL timelapse.js, the REAL app.js helper they borrow, and
// the REAL markup out of index.html, then feeds all of it a synthetic 27-year
// archive through a mock /api/record-step. Nothing is re-implemented, so what
// plays here is what ships.
//
// Two views share one reading of that archive, which is the whole point of the
// store, and this harness is where you can see it: press "Open dashboard"
// first, let it finish, then press "Open timelapse" and watch the film start
// with nothing left to fetch. Press them the other way round and it works the
// same, because the record is stored rather than re-read.
//
// The mock has to return real documents, not just counts — a timelapse whose
// frames are all the same white rectangle tells you nothing about whether the
// cross-fade works. So each mock snapshot generates a page in the visual
// idiom of its era: a table-and-Times layout in 1999, centred fixed-width
// tables through the aughties, a CSS reskin by 2010, and a flat modern page by
// the 2020s. Four layouts means the film has four obvious visual phases, which
// is exactly what you want to see dissolve into each other.
//
// The delay is per request and matters: the real Archive is rate-limited to
// about one request per 1.1s and the first reading of a record waits for all
// of it, so a preview that answered instantly would never show the wait, and
// the thing that needs checking is exactly what happens during it. A pause a
// little under the real rate reproduces it. Set TIMELAPSE_PREVIEW_FAST=1 for a
// quick smoke test.
//
//   node scripts/preview-timelapse.js
//
// Writes .freebuff/preview/timelapse-<timestamp>.html and prints the path.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.freebuff', 'preview');

const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const archiveStoreJs = fs.readFileSync(path.join(ROOT, 'public', 'archiveStore.js'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.js'), 'utf8');
const timelapseJs = fs.readFileSync(path.join(ROOT, 'public', 'timelapse.js'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------- synthetic archive
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSnapshots(target) {
  const rand = mulberry32(20260927);
  const start = Date.UTC(1999, 9, 9);
  const end = Date.UTC(2026, 8, 22);
  const span = end - start;

  const snaps = [start];
  for (let t = start + 86400000; t <= end; t += 86400000) {
    const progress = (t - start) / span;
    const p = 0.0022 + Math.pow(progress, 2.6) * 0.42;
    if (rand() < p) snaps.push(t);
  }
  while (snaps.length > target) snaps.splice(Math.floor(rand() * snaps.length), 1);
  while (snaps.length < target) {
    const i = Math.floor(rand() * (snaps.length - 1));
    snaps.splice(i + 1, 0, Math.round((snaps[i] + snaps[i + 1]) / 2));
  }
  snaps.sort((a, b) => a - b);
  return snaps.map((t, i) => ({
    timestamp: String(t) + '000',
    original: `https://web.archive.org/web/${t}/http://settlement.org/`,
    date: new Date(t).toISOString(),
    index: i,
  }));
}

// The record the harness films. The real thing is 737 captures, which at the
// Archive's own rate is a quarter of an hour of waiting — fine for a real
// trace, useless for iterating. Override it to rehearse a short record or a
// different one:
//
//   TIMELAPSE_PREVIEW_SNAPSHOTS=40 node scripts/preview-timelapse.js
const SNAPSHOT_COUNT = parseInt(process.env.TIMELAPSE_PREVIEW_SNAPSHOTS, 10) || 737;
const SNAPSHOTS = buildSnapshots(SNAPSHOT_COUNT);

// How long the mocked /api/record-step takes. The real Archive is rate-limited
// to about one request per 1.1s and the first reading of a record waits for
// all of it, so the preview has to as well or the waiting phase - which is the
// part with a progress card on it - is never actually seen.
const MOCK_DELAY_MS = process.env.TIMELAPSE_PREVIEW_FAST ? 0 : 420;

// ---------------------------------------------------------------- mock documents
// A page in the visual idiom of its year. Real archived pages of one site
// really do drift like this, and four clearly distinct layouts are what make
// the cross-fade legible in a preview.
function mockPage(year, seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const headlines = [
    'Settlement.ORG', 'Settlement', 'Settlement — Rethinking the Commute',
    'Settlement', 'Settlement', 'Settlement', 'Settlement',
  ];
  const nav = ['About', 'Projects', 'People', 'News', 'Contact', 'Archive', 'Search'];
  const blurb = [
    'We work with communities on the ground.',
    'Independent research on housing, transport and public space.',
    'Notes from twenty-seven years of looking at how places change.',
    'A small practice with a long memory.',
  ];

  if (year < 2004) {
    return `<!DOCTYPE html><html><head><title>${headlines[0]}</title></head>
<body bgcolor="#000080" text="#000000" link="#ffff00" vlink="#ffff00" alink="#ff0000">
<center>
<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#c0c0c0">
<tr><td align="center"><font face="Times New Roman, serif" size="7"><b>${headlines[0]}</b></font>
<br><font face="Times New Roman, serif" size="2">est. 1999</font></td></tr>
<tr><td bgcolor="#000080"><font face="Arial" size="2" color="#ffffff">
${nav.slice(0, 4).map((n) => `<a href="#">${n}</a>`).join(' | ')}</font></td></tr>
<tr><td><font face="Times New Roman, serif" size="3">
<h2>${pick(blurb)}</h2>
${pick(blurb)}
<hr size="1" noshade>
<font size="2">This page last modified ${pick(['Tuesday', 'Friday', 'Sunday'])}.
<br>You are visitor number ${10000 + Math.floor(rand() * 89000)}.</font>
<p><font size="2"><a href="mailto:hi@settlement.org">hi@settlement.org</a></font></p>
</font></td></tr>
</table>
</center></body></html>`;
  }

  if (year < 2010) {
    return `<!DOCTYPE html><html><head><title>${headlines[1]}</title>
<style>body{font-family:Verdana,Arial,sans-serif;font-size:12px;background:#fff;color:#333;margin:0}
.wrap{width:760px;margin:0 auto}
h1{font-family:Georgia,serif;font-size:34px;color:#1a4d8f;margin:0;padding:18px 0 4px}
h2{font-size:15px;color:#1a4d8f;border-bottom:2px solid #d8e4f0;padding-bottom:6px}
.nav{background:#1a4d8f;padding:7px 0}.nav a{color:#fff;margin:0 11px;text-decoration:none;font-size:11px}
.cols{display:flex;gap:18px;padding:16px 0}
.col{flex:1;font-size:12px;line-height:1.6}
.foot{border-top:1px solid #d8e4f0;padding:12px 0;font-size:11px;color:#777}</style>
</head><body><div class="wrap">
<h1>${headlines[1]}</h1>
<div class="nav">${nav.map((n) => `<a href="#">${n}</a>`).join('')}</div>
<div class="cols">
<div class="col"><h2>${pick(blurb)}</h2><p>${pick(blurb)} ${pick(blurb)}.</p></div>
<div class="col"><h2>Latest</h2><ul>${Array.from({ length: 4 }, () => `<li>${pick(blurb)}</li>`).join('')}</ul></div>
</div>
<div class="foot">&copy; 1999&ndash;${year} settlement.org &middot; <a href="#">RSS</a> &middot; <a href="#">Contact</a></div>
</div></body></html>`;
  }

  if (year < 2019) {
    return `<!DOCTYPE html><html><head><title>${headlines[2]}</title>
<style>*{box-sizing:border-box}
body{font-family:"Helvetica Neue",Arial,sans-serif;background:#f7f7f5;color:#222;margin:0;line-height:1.6}
header{background:#14110f;color:#fff;padding:28px 0}
.wrap{max-width:1000px;margin:0 auto;padding:0 24px}
h1{font-size:30px;font-weight:600;margin:0;letter-spacing:-0.02em}
nav{margin-top:16px}nav a{color:#e8734a;margin-right:20px;text-decoration:none;font-size:13px;font-weight:500}
main{padding:34px 0}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:34px}
h2{font-size:19px;margin:0 0 10px}
.card{background:#fff;border:1px solid #e4e2dd;border-radius:8px;padding:18px;margin-bottom:14px}
.tag{display:inline-block;background:#14110f;color:#fff;font-size:10px;letter-spacing:0.08em;
text-transform:uppercase;padding:3px 9px;border-radius:3px;margin-bottom:9px}
footer{border-top:1px solid #e4e2dd;padding:20px 0;font-size:12px;color:#777}</style>
</head><body>
<header><div class="wrap"><h1>${headlines[2]}</h1>
<nav>${nav.map((n) => `<a href="#">${n}</a>`).join('')}</nav></div></header>
<main><div class="wrap"><div class="grid">
<div>
<div class="card"><span class="tag">Project</span><h2>${pick(blurb)}</h2><p>${pick(blurb)}.</p></div>
<div class="card"><span class="tag">Research</span><h2>${pick(blurb)}</h2><p>${pick(blurb)} ${pick(blurb)}.</p></div>
</div>
<div>
<div class="card"><h2>On this site</h2><ul>${nav.slice(0, 4).map((n) => `<li><a href="#">${n}</a></li>`).join('')}</ul></div>
<div class="card"><h2>Elsewhere</h2><p><a href="#">Mastodon</a><br><a href="#">Newsletter</a></p></div>
</div>
</div></div></main>
<footer><div class="wrap">&copy; settlement.org &middot; A practice in ${['Hackney', 'Glasgow', 'Rotterdam'][Math.floor(rand() * 3)]}</div></footer>
</body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>${headlines[3]}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d0d0f;color:#f2f2f0;margin:0;line-height:1.6}
.wrap{max-width:1080px;margin:0 auto;padding:0 28px}
header{padding:76px 0 56px;border-bottom:1px solid #26262a}
h1{font-size:clamp(38px,6vw,64px);font-weight:650;letter-spacing:-0.035em;margin:0 0 14px}
p.lede{font-size:19px;color:#a8a8a4;max-width:56ch;margin:0}
nav{margin-top:30px;display:flex;gap:8px;flex-wrap:wrap}
nav a{color:#f2f2f0;text-decoration:none;font-size:13px;padding:7px 15px;border:1px solid #34343a;border-radius:100px}
nav a:hover{border-color:#e8734a;color:#e8734a}
main{padding:48px 0}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:20px}
.card{background:#16161a;border:1px solid #26262a;border-radius:14px;padding:24px}
.card h2{font-size:17px;margin:0 0 8px}
.card p{color:#a8a8a4;font-size:14px;margin:0}
.yr{font-variant-numeric:tabular-nums;color:#e8734a;font-size:12px;letter-spacing:0.06em}
footer{border-top:1px solid #26262a;padding:26px 0;font-size:12px;color:#6e6e74}</style>
</head><body>
<header><div class="wrap">
<h1>${headlines[3]}</h1>
<p class="lede">${pick(blurb)}. Working at the intersection of design, policy and place since 1999.</p>
<nav>${nav.map((n) => `<a href="#">${n}</a>`).join('')}</nav>
</div></header>
<main><div class="wrap">
<div class="row">${Array.from({ length: 3 }, () => `
<div class="card"><span class="yr">${year - Math.floor(rand() * 6)}</span>
<h2>${pick(blurb)}</h2><p>${pick(blurb)}.</p></div>`).join('')}</div>
<div class="card"><h2>${pick(blurb)}</h2><p>${pick(blurb)} ${pick(blurb)} ${pick(blurb)}.</p></div>
</div></main>
<footer><div class="wrap">Settlement is an independent practice. Text licensed CC BY 4.0.</div></footer>
</body></html>`;
}

// Counts consistent with the era the documents came from, so the delta figures
// on the date card and the tick heights on the rail agree with what you can
// actually see change on screen.
function mockCounts(fromYear, toYear) {
  const rand = mulberry32(fromYear * 7919 + toYear * 104729);
  const progress = Math.min(1, Math.max(0, (toYear - 1999) / 27));
  const scale = 0.35 + Math.pow(progress, 2.2) * 5.4;

  let added = Math.round(rand() * 9 * scale);
  let removed = Math.round(rand() * 5 * scale);
  let changed = Math.round(rand() * 34 * scale);

  if (toYear === 2015) { added = 244; removed = 66; changed = 0; }
  else if (toYear === 2021) { added = 3; removed = 12; changed = 96; }

  return { added, removed, changed };
}

// The per-element breakdown the dashboard's tag chart is made of. Spread over
// plausible tags rather than dropped on one, so the chart has a shape.
function mockTagCounts(fromYear, toYear) {
  const counts = mockCounts(fromYear, toYear);
  const rand = mulberry32(fromYear * 31 + toYear * 17);
  const out = {};

  const spread = (total, tags) => {
    let left = total;
    tags.forEach((t, i) => {
      const n = i === tags.length - 1
        ? left
        : Math.round(left * (0.15 + rand() * 0.55));
      const take = Math.max(0, Math.min(n, left));
      if (take) out[t] = (out[t] || 0) + take;
      left -= take;
    });
  };

  spread(counts.added, ['a', 'img', 'li', 'div', 'span']);
  spread(counts.removed, ['a', 'td', 'font', 'div']);
  spread(counts.changed, ['p', 'span', 'div', 'a', 'h2', 'td']);
  return out;
}

// ---------------------------------------------------------------- stub globals
const STUB = `
const PREVIEW_SNAPSHOTS = ${JSON.stringify(SNAPSHOTS)};

// mockPage and mockCounts are serialised in below and both draw from this, so
// it has to travel with them — the harness runs in the page, not in Node.
${mulberry32.toString()}

const state = {
  url: 'settlement.org',
  snapshots: PREVIEW_SNAPSHOTS,
  fromIndex: 690,
  toIndex: 736,
  currentDiff: null,
  viewMode: 'side',
  notesTimer: null,
};

const el = (id) => document.getElementById(id);

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>\"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]
  ));
}

// The one app.js helper the timelapse borrows, verbatim.
function injectScrollFix(html) {
  if (!html) return html;
  const fixStyle = '<style>html,body{overflow-x:hidden !important;}' +
    'img,video,table,iframe,pre{max-width:100%;}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + fixStyle);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + fixStyle);
  return fixStyle + html;
}

${mockPage.toString()}
${mockCounts.toString()}
${mockTagCounts.toString()}

// Two app.js globals the dashboard borrows when a bar is clicked. The real
// ones drive the compare view, which has nothing to say about either of these
// views, so the harness just needs them to exist.
function positionHandles() {}
function loadDiff() {}

window.__fetches = [];
window.fetch = async (url) => {
  const u = String(url);
  window.__fetches.push(u.split('?')[1] || '');
  const params = new URLSearchParams(u.split('?')[1] || '');
  const fromSnap = PREVIEW_SNAPSHOTS.find((s) => s.timestamp === params.get('from'));
  const toSnap = PREVIEW_SNAPSHOTS.find((s) => s.timestamp === params.get('to'));
  const fromYear = new Date(fromSnap.date).getUTCFullYear();
  const toYear = new Date(toSnap.date).getUTCFullYear();

  const counts = mockCounts(fromYear, toYear);
  // Not instant: the first reading of a record waits for all of it, and that
  // wait is the thing this preview exists to show.
  await new Promise((r) => setTimeout(r, ${MOCK_DELAY_MS}));

  return {
    ok: true,
    json: async () => ({
      counts,
      tagCounts: mockTagCounts(fromYear, toYear),
      newHtml: mockPage(toYear, new Date(toSnap.date).getTime() % 100000),
      // The store only asks for the older page when it does not already hold
      // it, so honouring that here is what proves the walk is asking once.
      oldHtml: params.get('withOld') === '1'
        ? mockPage(fromYear, new Date(fromSnap.date).getTime() % 100000)
        : undefined,
    }),
  };
};
`;

// ---------------------------------------------------------------- assemble
html = html.replace(/<link rel="stylesheet" href="\/styles\.css" \/>/, () => `<style>\n${css}\n</style>`);
['app.js', 'archiveStore.js', 'dashboard.js', 'timelapse.js'].forEach((f) => {
  html = html.replace(new RegExp(`\\s*<script src="\\/${f.replace('.', '\\.')}"><\\/script>`), '');
});

// Hide everything the trace page would still be hiding, and skip the hero so
// the views are the first thing on screen.
html = html.replace('id="timelineSection" class="timeline-section" hidden', 'id="timelineSection" class="timeline-section"');
html = html.replace('id="workspace" class="workspace" hidden', 'id="workspace" class="workspace"');
html = html.replace(/<section class="hero">/, '<section class="hero" hidden>');

const BOOTSTRAP = `
<script>
(function () {
  el('timelineSiteName').textContent = state.url;
  el('timelineMeta').textContent =
    state.snapshots.length + ' recorded changes on file, spanning ' +
    formatDate(state.snapshots[0].date) + ' to ' + formatDate(state.snapshots[state.snapshots.length - 1].date);
})();
</script>
`;

// Three buttons rather than an auto-play, because the thing worth checking is
// the ORDER: whichever view opens first reads the record, and the second one
// finds it stored. Clearing IndexedDB first is the only way to see the wait
// again in a session that has already paid it.
const RESET = `
<div class="preview-reset">
  <button type="button" id="previewDash">Open dashboard</button>
  <button type="button" id="previewTl">Open timelapse</button>
  <button type="button" id="previewRefetch">Refetch from scratch</button>
</div>
<style>
.preview-reset { position: fixed; z-index: 900; right: 14px; top: 14px; display: flex; gap: 6px; }
.preview-reset button {
  font-family: var(--sans); font-size: 11px; font-weight: 600;
  padding: 7px 12px; border-radius: 100px; cursor: pointer;
  background: var(--ink); color: var(--accent-ink); border: 0;
}
</style>
<script>
document.getElementById('previewDash').addEventListener('click', function () {
  closeTimelapse(); openDashboard();
});
document.getElementById('previewTl').addEventListener('click', function () {
  closeDashboard(); openTimelapse();
});
document.getElementById('previewRefetch').addEventListener('click', function () {
  indexedDB.deleteDatabase('palimpsest-record');
  location.reload();
});
</script>
`;

html = html.replace('</body>',
  `${RESET}<script>${STUB}</script>\n<script>${archiveStoreJs}</script>\n` +
  `<script>${dashboardJs}</script>\n<script>${timelapseJs}</script>\n${BOOTSTRAP}</body>`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `timelapse-${Date.now()}.html`);
fs.writeFileSync(file, html);
console.log(file);
