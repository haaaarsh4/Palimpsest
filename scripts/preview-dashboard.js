// scripts/preview-dashboard.js
//
// A throwaway-but-reusable preview harness for the parts of Palimpsest that
// are painful to eyeball against live data: the trace-page legend and the
// whole "Site dashboard" modal. Reaching either one for real means a slow
// Wayback round trip, so this builds a single self-contained HTML file that
// inlines the REAL styles.css, the REAL dashboard.js and the REAL markup out
// of index.html, then feeds dashboard.js a synthetic-but-plausible archive
// (737 captures over 27 years, uneven crawler density, a couple of spikes)
// through a mock /api/diff.
//
// Because nothing here is re-implemented, what you see is what the shipped
// page renders — the only stub is the handful of globals dashboard.js borrows
// from app.js (state, el, formatDate, escapeHtml, positionHandles, loadDiff).
//
//   node scripts/preview-dashboard.js
//
// Writes .freebuff/preview/dash-<timestamp>.html and prints the path. A fresh
// filename every run on purpose: the preview server caches by path.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.freebuff', 'preview');

const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.js'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------- synthetic archive
// Deterministic PRNG so successive previews are comparable.
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
    // The crawler's appetite grows with the web: rare in 1999, relentless by 2026.
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

const SNAPSHOTS = buildSnapshots(737);
const PREVIEW_SNAPSHOTS = SNAPSHOTS; // the name this array has inside the page

// One diff per consecutive pair. Early years are near-static; later years carry
// real churn, with two deliberate spikes so the chart's shape gets exercised.
// Serialised into the page, so it must only touch names that exist there.
function mockCounts(fromIdx, toIdx) {
  const rand = mulberry32(fromIdx * 7919 + toIdx * 104729);
  const year = new Date(PREVIEW_SNAPSHOTS[toIdx].date).getUTCFullYear();
  const progress = Math.min(1, Math.max(0, (year - 1999) / 27));
  const scale = 0.35 + Math.pow(progress, 2.2) * 5.4;

  let added = Math.round(rand() * 9 * scale);
  let removed = Math.round(rand() * 5 * scale);
  let changed = Math.round(rand() * 34 * scale);

  // Two remembered redesigns, so the chart gets a tall bar and a wide one.
  if (year === 2015) { added = 244; removed = 66; changed = 0; }
  else if (year === 2021) { added = 3; removed = 12; changed = 96; }

  const tagPool = [
    ['a', 0.34], ['p', 0.2], ['div', 0.14], ['img', 0.1], ['li', 0.08],
    ['span', 0.06], ['h2', 0.04], ['button', 0.02], ['input', 0.014], ['td', 0.006],
  ];
  const tagCounts = {};
  const total = added + removed + changed;
  for (let i = 0; i < total; i++) {
    let r = rand(), acc = 0, pick = 'p';
    for (const [tag, w] of tagPool) { acc += w; if (r <= acc) { pick = tag; break; } }
    tagCounts[pick] = (tagCounts[pick] || 0) + 1;
  }

  return { counts: { added, removed, changed }, tagCounts };
}

// ---------------------------------------------------------------- stub globals
const STUB = `
const PREVIEW_SNAPSHOTS = ${JSON.stringify(PREVIEW_SNAPSHOTS)};

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

${mockCounts.toString()}

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
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Mirrors the real one closely enough to judge the header: ticks per capture,
// a filled range, and the two handles dropped at the current selection.
function positionHandles() {
  const snaps = state.snapshots;
  const n = snaps.length;
  const first = new Date(snaps[0].date).getTime();
  const last = new Date(snaps[n - 1].date).getTime();
  const span = Math.max(1, last - first);
  const pctOf = (i) => ((new Date(snaps[i].date).getTime() - first) / span) * 100;

  const tickLayer = el('tickLayer');
  let ticks = '';
  for (let i = 0; i < n; i++) ticks += '<span class="tick" style="left:' + pctOf(i).toFixed(3) + '%"></span>';
  if (tickLayer) tickLayer.innerHTML = ticks;

  const lo = Math.min(state.fromIndex, state.toIndex);
  const hi = Math.max(state.fromIndex, state.toIndex);
  const a = pctOf(lo), b = pctOf(hi);
  const fill = el('rangeFill');
  if (fill) { fill.style.left = a + '%'; fill.style.width = (b - a) + '%'; }
  if (el('handleFrom')) el('handleFrom').style.left = a + '%';
  if (el('handleTo')) el('handleTo').style.left = b + '%';

  if (el('earliestLabel')) el('earliestLabel').textContent = formatDate(snaps[0].date);
  if (el('latestLabel')) el('latestLabel').textContent = formatDate(snaps[n - 1].date);
  if (el('fromDate')) el('fromDate').textContent = formatDate(snaps[lo].date);
  if (el('toDate')) el('toDate').textContent = formatDate(snaps[hi].date);
}

function loadDiff() {}

window.__fetches = [];
window.fetch = async (url) => {
  window.__fetches.push(String(url).split('?')[1] || '');
  const params = new URLSearchParams(String(url).split('?')[1] || '');
  const fromTs = params.get('from');
  const toTs = params.get('to');
  const fromIdx = PREVIEW_SNAPSHOTS.findIndex((s) => s.timestamp === fromTs);
  const toIdx = PREVIEW_SNAPSHOTS.findIndex((s) => s.timestamp === toTs);
  const { counts, tagCounts } = mockCounts(fromIdx, toIdx);
  const changes = Object.entries(tagCounts).flatMap(([tag, c]) =>
    Array.from({ length: c }, () => ({ tag }))
  );
  await new Promise((r) => setTimeout(r, 12));
  return { ok: true, json: async () => ({ counts, changes }) };
};
`;

// ---------------------------------------------------------------- assemble
// Swap the stylesheet + font links for an inlined copy, drop the real scripts.
html = html.replace(
  /<link href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/,
  '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">\n'
);
html = html.replace(/<link rel="stylesheet" href="\/styles\.css" \/>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/\s*<script src="\/app\.js"><\/script>/, '');
html = html.replace(/\s*<script src="\/dashboard\.js"><\/script>/, '');

// The trace page and workspace are hidden until a live trace finishes; the
// harness has data already, so show them.
html = html.replace('id="timelineSection" class="timeline-section" hidden', 'id="timelineSection" class="timeline-section"');
html = html.replace('id="workspace" class="workspace" hidden', 'id="workspace" class="workspace"');
html = html.replace(/<section class="hero">/, '<section class="hero" hidden>');

const TOGGLE = `
<div class="preview-toggle" id="previewToggle">
  <button type="button" data-mode="trace" class="active">Trace page</button>
  <button type="button" data-mode="dash">Dashboard</button>
</div>
<style>
.preview-toggle {
  position: fixed; z-index: 200; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; gap: 3px; padding: 4px; border-radius: 100px;
  background: var(--ink); box-shadow: var(--shadow-lifted);
}
.preview-toggle button {
  border: none; background: transparent; color: var(--accent-ink); opacity: 0.55;
  font-family: var(--sans); font-weight: 600; font-size: 12px;
  padding: 8px 16px; border-radius: 100px; cursor: pointer;
}
.preview-toggle button.active { background: rgba(255,255,255,0.16); opacity: 1; }
</style>
`;

const BOOTSTRAP = `
<script>
(function () {
  function toMode(mode) {
    document.querySelectorAll('#previewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'dash') openDashboard(); else closeDashboard();
  }
  document.querySelectorAll('#previewToggle button').forEach((b) => {
    b.addEventListener('click', () => toMode(b.dataset.mode));
  });
  window.__previewMode = toMode;

  el('timelineSiteName').textContent = state.url;
  el('timelineMeta').textContent =
    state.snapshots.length + ' recorded changes on file, spanning ' +
    formatDate(state.snapshots[0].date) + ' to ' + formatDate(state.snapshots[state.snapshots.length - 1].date);
  el('changeCounts').innerHTML =
    '<span class="change-count"><i class="dot dot-added"></i><b>25</b> added</span>' +
    '<span class="change-count"><i class="dot dot-removed"></i><b>3</b> removed</span>' +
    '<span class="change-count"><i class="dot dot-changed"></i><b>113</b> changed</span>';
  positionHandles();
  openDashboard();
})();
</script>
`;

html = html.replace('</body>', `${TOGGLE}<script>${STUB}</script>\n<script>${dashboardJs}</script>\n${BOOTSTRAP}</body>`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `dash-${Date.now()}.html`);
fs.writeFileSync(file, html);
console.log(file);
