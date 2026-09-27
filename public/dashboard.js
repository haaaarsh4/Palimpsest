// public/dashboard.js
//
// The "site dashboard" is a second read of the same data the main compare
// view already produces, aggregated across the whole recorded history
// instead of one pair of snapshots at a time.
//
// It leans entirely on the existing /api/diff endpoint rather than adding
// a new server route: for a chosen level of detail, it walks the site's
// snapshot list in consecutive pairs — or, for a long history, a subset
// of it sampled evenly across CALENDAR TIME rather than by position in
// the list (see computePairs) — and asks for the same diff the compare
// view would show, keeping only the counts and tag breakdown.
//
// Two things this version deliberately avoids, both because they caused
// real bugs before:
//
//   1. No hand-positioned drag controls. The "focus range" is two plain
//      <select> elements. A <select> cannot overlap its own label or
//      drift out of alignment with a track, because there is no track —
//      the browser owns its layout completely.
//
//   2. No per-fetch re-rendering. Every chart is drawn exactly once, only
//      after the whole analysis batch has returned. Redrawing mid-stream
//      meant the axis scale and bar count changed underneath the viewer
//      as data arrived. A single "analyzing" skeleton, swapped once for
//      the finished chart, is calmer and cheaper.
//
// A word on honesty: the Wayback Machine's crawler visits a site on its
// own schedule, not the site's. A gap in coverage means the crawler
// didn't stop by — it says nothing about whether the site changed in
// between. A large diff between two analyzed snapshots is "the difference
// between these two captures," never "what happened on this date." When a
// detail level's sampling skips real archived snapshots in between two
// analyzed ones, that surfaces on hover — it does not get a permanent
// visual marker, because at typical sampling levels most bars skip
// something, and a marker on almost everything stops being information.
//
// This file expects app.js to have already run: it reuses the global
// `state`, `el`, `formatDate`, `escapeHtml`, `positionHandles`, and
// `loadDiff` from that file rather than duplicating them.

const RESOLUTION_MAX = { coarse: 14, balanced: 28, fine: 55 };

const TAG_LABELS = {
  a: 'Links', img: 'Images', p: 'Paragraphs', li: 'List items',
  h1: 'Headings', h2: 'Headings', h3: 'Headings', h4: 'Headings',
  span: 'Text snippets', div: 'Text blocks', button: 'Buttons',
  td: 'Table cells', th: 'Table headers', figcaption: 'Captions',
  blockquote: 'Quotes', label: 'Labels', input: 'Form fields',
  iframe: 'Embeds', video: 'Videos', audio: 'Audio',
};
function tagLabel(tag) { return TAG_LABELS[tag] || (tag ? tag.toUpperCase() : 'Other'); }

const DASH = {
  gen: 0,
  forUrl: null,
  resolution: 'balanced',
  bucket: 'snapshot',           // 'snapshot' | 'month'
  series: { added: true, removed: true, changed: true },
  intervals: [],                // sparse array, filled positionally as fetches resolve
  completed: 0,
  totalPairs: 0,
  sampled: false,
  rangeLo: null,
  rangeHi: null,
};

// ---------------------------------------------------------------- open/close
el('openDashboardBtn').addEventListener('click', openDashboard);
el('dashModalClose').addEventListener('click', closeDashboard);
el('dashboardBackdrop').addEventListener('click', closeDashboard);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('dashboardModal').hidden) closeDashboard();
});

function openDashboard() {
  if (!state.snapshots || state.snapshots.length < 2) return;

  el('dashboardModal').hidden = false;
  el('dashSiteName').textContent = state.url;
  document.body.style.overflow = 'hidden'; // stop the page underneath scrolling with the modal open

  if (DASH.forUrl !== state.url) {
    DASH.forUrl = state.url;
    DASH.rangeLo = null;
    DASH.rangeHi = null;
  }

  renderCadence();     // needs only state.snapshots — instant, no fetch required
  startAnalysis();
}

function closeDashboard() {
  el('dashboardModal').hidden = true;
  document.body.style.overflow = '';
}

// ---------------------------------------------------------------- resolution (segmented control)
el('dashResolutionToggle').querySelectorAll('.toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    el('dashResolutionToggle').querySelectorAll('.toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
    DASH.resolution = btn.dataset.value;
    DASH.rangeLo = null;
    DASH.rangeHi = null;
    startAnalysis();
  });
});

// ---------------------------------------------------------------- group-by & series controls
el('dashBucketSnapshot').addEventListener('click', () => setBucket('snapshot'));
el('dashBucketMonth').addEventListener('click', () => setBucket('month'));
function setBucket(mode) {
  DASH.bucket = mode;
  el('dashBucketSnapshot').classList.toggle('active', mode === 'snapshot');
  el('dashBucketMonth').classList.toggle('active', mode === 'month');
  if (DASH.completed >= DASH.totalPairs) renderCharts();
}

['Added', 'Removed', 'Changed'].forEach((name) => {
  el('dashSeries' + name).addEventListener('change', () => {
    DASH.series[name.toLowerCase()] = el('dashSeries' + name).checked;
    if (DASH.completed >= DASH.totalPairs) renderCharts();
  });
});

// ---------------------------------------------------------------- focus range (plain selects)
el('dashRangeFrom').addEventListener('change', () => {
  let lo = parseInt(el('dashRangeFrom').value, 10);
  let hi = parseInt(el('dashRangeTo').value, 10);
  if (lo > hi) { hi = lo; el('dashRangeTo').value = hi; }
  DASH.rangeLo = lo; DASH.rangeHi = hi;
  renderCharts();
});
el('dashRangeTo').addEventListener('change', () => {
  let lo = parseInt(el('dashRangeFrom').value, 10);
  let hi = parseInt(el('dashRangeTo').value, 10);
  if (hi < lo) { lo = hi; el('dashRangeFrom').value = lo; }
  DASH.rangeLo = lo; DASH.rangeHi = hi;
  renderCharts();
});
el('dashRangeReset').addEventListener('click', () => {
  DASH.rangeLo = null;
  DASH.rangeHi = null;
  setupFocusControls();
  renderCharts();
});

function setupFocusControls() {
  const all = DASH.intervals.filter(Boolean);
  const n = all.length;
  const show = n > 6;
  el('dashRangeFilter').hidden = !show;
  if (!show) return;

  if (DASH.rangeLo == null || DASH.rangeHi == null || DASH.rangeHi > n - 1) {
    DASH.rangeLo = 0;
    DASH.rangeHi = n - 1;
  }

  const optionsHtml = all.map((iv, i) =>
    `<option value="${i}">${escapeHtml(formatDate(iv.fromDate))} \u2192 ${escapeHtml(formatDate(iv.toDate))}</option>`
  ).join('');
  el('dashRangeFrom').innerHTML = optionsHtml;
  el('dashRangeTo').innerHTML = optionsHtml;
  el('dashRangeFrom').value = DASH.rangeLo;
  el('dashRangeTo').value = DASH.rangeHi;
}

// ---------------------------------------------------------------- fetching
// Rather than sampling every Nth snapshot BY POSITION — which, on an
// archive where capture density is wildly uneven, means almost the whole
// sampling budget lands in whichever era got crawled most often — this
// spaces target points evenly across CALENDAR TIME and snaps each one to
// the nearest snapshot that actually exists. A sparse decade and a dense
// month each get a share of the detail proportional to how much time they
// cover, not how many times a crawler happened to stop by.
function nearestSnapshotIndex(targetT) {
  const snaps = state.snapshots;
  let lo = 0, hi = snaps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(snaps[mid].date).getTime() < targetT) lo = mid + 1; else hi = mid;
  }
  if (lo > 0) {
    const dLo = Math.abs(new Date(snaps[lo].date).getTime() - targetT);
    const dPrev = Math.abs(new Date(snaps[lo - 1].date).getTime() - targetT);
    if (dPrev < dLo) return lo - 1;
  }
  return lo;
}

function computePairs() {
  const n = state.snapshots.length;
  const maxPoints = RESOLUTION_MAX[DASH.resolution];

  let indices;
  if (n - 1 <= maxPoints) {
    indices = Array.from({ length: n }, (_, i) => i);
  } else {
    const minT = new Date(state.snapshots[0].date).getTime();
    const maxT = new Date(state.snapshots[n - 1].date).getTime();
    const span = Math.max(1, maxT - minT);
    const set = new Set([0, n - 1]);
    for (let k = 1; k < maxPoints; k++) {
      set.add(nearestSnapshotIndex(minT + (span * k) / maxPoints));
    }
    indices = Array.from(set).sort((a, b) => a - b);
  }

  const pairs = [];
  for (let i = 0; i < indices.length - 1; i++) pairs.push([indices[i], indices[i + 1]]);
  return pairs;
}

async function fetchIntervalDiff(fromIdx, toIdx) {
  const from = state.snapshots[fromIdx];
  const to = state.snapshots[toIdx];
  const res = await fetch(`/api/diff?url=${encodeURIComponent(state.url)}&from=${from.timestamp}&to=${to.timestamp}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not build that comparison.');

  const tagCounts = {};
  (data.changes || []).forEach((c) => { tagCounts[c.tag] = (tagCounts[c.tag] || 0) + 1; });

  return {
    fromIdx, toIdx,
    fromDate: from.date, toDate: to.date,
    skipped: Math.max(0, toIdx - fromIdx - 1),
    added: data.counts.added, removed: data.counts.removed, changed: data.counts.changed,
    total: data.counts.added + data.counts.removed + data.counts.changed,
    tagCounts,
  };
}

async function runQueue(pairs, limit, myGen) {
  let cursor = 0;

  async function worker() {
    while (cursor < pairs.length) {
      if (DASH.gen !== myGen) return;
      const idx = cursor++;
      const [fromIdx, toIdx] = pairs[idx];
      try {
        const result = await fetchIntervalDiff(fromIdx, toIdx);
        if (DASH.gen !== myGen) return;
        DASH.intervals[idx] = result;
      } catch (_) {
        if (DASH.gen !== myGen) return;
        DASH.intervals[idx] = {
          fromIdx, toIdx,
          fromDate: state.snapshots[fromIdx].date, toDate: state.snapshots[toIdx].date,
          skipped: Math.max(0, toIdx - fromIdx - 1),
          added: 0, removed: 0, changed: 0, total: 0, tagCounts: {}, error: true,
        };
      }
      if (DASH.gen !== myGen) return;
      DASH.completed++;
      updateLoadingProgressText();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, pairs.length) }, worker));
}

async function startAnalysis() {
  DASH.gen++;
  const myGen = DASH.gen;
  const pairs = computePairs();
  DASH.intervals = new Array(pairs.length);
  DASH.completed = 0;
  DASH.totalPairs = pairs.length;
  DASH.sampled = pairs.length < state.snapshots.length - 1;

  el('dashSubtitle').textContent = DASH.sampled
    ? `${state.snapshots.length} snapshots on file \u00b7 analyzing ${pairs.length + 1} of them across the full span`
    : `${state.snapshots.length} snapshots on file \u00b7 analyzing every one of them`;
  el('dashActivityHint').textContent = DASH.sampled
    ? 'Click a bar to open it \u00b7 hover for skipped snapshots'
    : 'Click any bar to open that comparison';

  renderKpiSkeleton();
  renderLoadingSkeletons();

  if (pairs.length === 0) { renderAll(); return; }

  await runQueue(pairs, 4, myGen);
  if (DASH.gen !== myGen) return; // superseded by a newer resolution change
  renderAll();
}

function updateLoadingProgressText() {
  const span = document.querySelector('#dashActivityChart .dash-loading-panel span');
  if (span) span.textContent = `Analyzing ${DASH.completed} of ${DASH.totalPairs}\u2026`;
}

function loadingPanelHTML(text) {
  return `<div class="dash-loading-panel"><div class="spinner"></div><span>${escapeHtml(text)}</span></div>`;
}

function renderLoadingSkeletons() {
  el('dashActivityChart').innerHTML = loadingPanelHTML(`Analyzing ${DASH.completed} of ${DASH.totalPairs}\u2026`);
  el('dashCompositionChart').innerHTML = loadingPanelHTML('Loading\u2026');
  el('dashTagChart').innerHTML = loadingPanelHTML('Loading\u2026');
  el('dashLeaderboard').innerHTML = loadingPanelHTML('Loading\u2026');
}

// ---------------------------------------------------------------- render root
function renderAll() {
  renderKpis();
  setupFocusControls();
  renderCharts();
}

function renderCharts() {
  const visible = getVisibleIntervals();
  renderActivityChart(visible);
  renderComposition(visible);
  renderTagChart(visible);
  renderLeaderboard(visible);
}

// ---------------------------------------------------------------- data shaping
function getVisibleIntervals() {
  const all = DASH.intervals.filter(Boolean);
  const lo = DASH.rangeLo ?? 0;
  const hi = DASH.rangeHi ?? Math.max(0, all.length - 1);
  const sliced = all.slice(lo, hi + 1);

  if (DASH.bucket === 'snapshot' || sliced.length === 0) return sliced;

  const map = new Map();
  sliced.forEach((iv) => {
    const d = new Date(iv.toDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!map.has(key)) {
      map.set(key, {
        key, label: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        fromIdx: iv.fromIdx, toIdx: iv.toIdx, fromDate: iv.fromDate, toDate: iv.toDate,
        skipped: 0, added: 0, removed: 0, changed: 0, total: 0, tagCounts: {},
      });
    }
    const b = map.get(key);
    b.toIdx = iv.toIdx;
    b.toDate = iv.toDate;
    b.skipped += iv.skipped;
    b.added += iv.added; b.removed += iv.removed; b.changed += iv.changed; b.total += iv.total;
    Object.entries(iv.tagCounts).forEach(([t, c]) => { b.tagCounts[t] = (b.tagCounts[t] || 0) + c; });
  });
  return Array.from(map.values());
}

// ---------------------------------------------------------------- KPIs
// Every KPI follows the same shape: a big value, one short plain-text
// line underneath, never a sentence, never a second line. Anything
// longer (a full added/removed/edited breakdown, a skip count) lives in
// the title attribute as a native hover tooltip instead of visible text
// that has to be squeezed to fit.
function humanDuration(fromIso, toIso) {
  const days = Math.round((new Date(toIso) - new Date(fromIso)) / 86400000);
  if (days < 1) return 'under a day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} mo`;
  const years = Math.floor(months / 12), remM = months % 12;
  return remM ? `${years} yr ${remM} mo` : `${years} yr`;
}

function kpiCard(label, value, sub, opts = {}) {
  const accent = opts.accent ? ' accent' : '';
  const clickable = opts.onClick ? ' dash-kpi-clickable' : '';
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
  const id = opts.id ? ` id="${opts.id}"` : '';
  return `<div class="dash-kpi${clickable}"${id}${title}>
    <span class="dash-kpi-label">${escapeHtml(label)}</span>
    <span class="dash-kpi-value${accent}">${value}</span>
    <span class="dash-kpi-sub">${sub}</span>
  </div>`;
}

function renderKpiSkeleton() {
  const n = state.snapshots.length;
  const first = state.snapshots[0].date, last = state.snapshots[n - 1].date;
  el('dashKpiRow').innerHTML = [
    kpiCard('Snapshots tracked', n, `Since ${formatDate(first)}`),
    kpiCard('History span', humanDuration(first, last), `${formatDate(first)} \u2192 ${formatDate(last)}`),
    kpiCard('Total changes', '\u2026', 'Calculating\u2026', { accent: true }),
    kpiCard('Longest capture gap', '\u2026', 'Calculating\u2026'),
    kpiCard('Largest difference', '\u2026', 'Calculating\u2026'),
  ].join('');
}

// The longest stretch between two REAL, consecutive archived snapshots —
// about crawler coverage, not site activity. The site may well have
// changed several times in a gap like this; the crawler just never
// caught it.
function longestCaptureGap() {
  const snaps = state.snapshots;
  let best = { days: -1, fromDate: null, toDate: null };
  for (let i = 0; i < snaps.length - 1; i++) {
    const days = Math.round((new Date(snaps[i + 1].date) - new Date(snaps[i].date)) / 86400000);
    if (days > best.days) best = { days, fromDate: snaps[i].date, toDate: snaps[i + 1].date };
  }
  return best;
}

function renderKpis() {
  const n = state.snapshots.length;
  const first = state.snapshots[0].date, last = state.snapshots[n - 1].date;
  const done = DASH.intervals.filter(Boolean);

  const totals = done.reduce((acc, iv) => {
    acc.added += iv.added; acc.removed += iv.removed; acc.changed += iv.changed; return acc;
  }, { added: 0, removed: 0, changed: 0 });
  const grandTotal = totals.added + totals.removed + totals.changed;

  const gap = longestCaptureGap();

  let busy = null;
  if (done.length) busy = done.reduce((a, b) => (b.total > a.total ? b : a), done[0]);

  el('dashKpiRow').innerHTML = [
    kpiCard('Snapshots tracked', n, `Since ${formatDate(first)}`),
    kpiCard('History span', humanDuration(first, last), `${formatDate(first)} \u2192 ${formatDate(last)}`),
    kpiCard(
      'Total changes', grandTotal,
      `+${totals.added} \u00b7 \u2212${totals.removed} \u00b7 ~${totals.changed}`,
      { accent: true, title: `${totals.added} added, ${totals.removed} removed, ${totals.changed} edited` }
    ),
    kpiCard(
      'Longest capture gap', gap.days >= 0 ? `${gap.days}d` : '\u2014',
      gap.days >= 0 ? `${formatDate(gap.fromDate)} \u2192 ${formatDate(gap.toDate)}` : '',
      { title: 'Crawler did not return during this window' }
    ),
    busy
      ? kpiCard('Largest difference', busy.total, `${formatDate(busy.fromDate)} \u2192 ${formatDate(busy.toDate)}`, {
          accent: true, id: 'dashBusiestKpi', onClick: true,
          title: (busy.skipped > 0 ? `Spans ${busy.skipped} skipped snapshot${busy.skipped === 1 ? '' : 's'} \u2014 ` : '') + 'Click to open this comparison',
        })
      : kpiCard('Largest difference', 0, '\u2014'),
  ].join('');

  if (busy) el('dashBusiestKpi').addEventListener('click', () => jumpToComparison(busy.fromIdx, busy.toIdx));
}

// ---------------------------------------------------------------- activity chart (SVG)
function seriesTotal(iv) {
  return (DASH.series.added ? iv.added : 0) + (DASH.series.removed ? iv.removed : 0) + (DASH.series.changed ? iv.changed : 0);
}

function renderActivityChart(intervals) {
  const wrap = el('dashActivityChart');
  if (!intervals.length) {
    wrap.innerHTML = `<p class="dash-empty-note">Nothing in the focused range.</p>`;
    return;
  }

  const W = 1000, H = 300, ML = 44, MR = 12, MT = 16, MB = 40;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = intervals.length;
  const band = plotW / n;
  const barW = Math.max(2, Math.min(band * 0.62, 34));

  const maxVal = Math.max(1, ...intervals.map(seriesTotal));
  const y = (v) => (v / maxVal) * plotH;

  let gridlines = '';
  let ticksLabels = '';
  for (let g = 0; g <= 4; g++) {
    const val = Math.round((maxVal * g) / 4);
    const yy = MT + plotH - y(val);
    gridlines += `<line class="dash-gridline" x1="${ML}" y1="${yy}" x2="${W - MR}" y2="${yy}" />`;
    ticksLabels += `<text class="dash-axis-label" x="${ML - 8}" y="${yy + 3}" text-anchor="end">${val}</text>`;
  }

  const labelEvery = Math.max(1, Math.ceil(n / 7));
  let bars = '';
  let xLabels = '';
  intervals.forEach((iv, i) => {
    const x = ML + i * band + (band - barW) / 2;
    let cursorY = MT + plotH;
    let segs = '';
    [
      ['removed', iv.removed, 'var(--removed)'],
      ['changed', iv.changed, 'var(--changed)'],
      ['added', iv.added, 'var(--added)'],
    ].forEach(([key, val, color]) => {
      if (!DASH.series[key] || !val) return;
      const h = y(val);
      cursorY -= h;
      segs += `<rect x="${x}" y="${cursorY}" width="${barW}" height="${h}" fill="${color}" />`;
    });
    bars += `<g class="dash-bar" data-i="${i}">
        <rect x="${x}" y="${MT}" width="${barW}" height="${plotH}" fill="transparent" />
        ${segs}
      </g>`;

    if (i % labelEvery === 0 || i === n - 1) {
      const lbl = iv.label || shortDate(iv.toDate);
      xLabels += `<text class="dash-axis-label" x="${x + barW / 2}" y="${H - MB + 16}" text-anchor="middle">${escapeHtml(lbl)}</text>`;
    }
  });

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${gridlines}
    <line class="dash-axis-line" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />
    ${ticksLabels}
    ${bars}
    ${xLabels}
  </svg>`;

  wrap.querySelectorAll('.dash-bar').forEach((g) => {
    const iv = intervals[parseInt(g.dataset.i, 10)];
    g.addEventListener('mouseenter', (e) => showDashTooltip(e, iv));
    g.addEventListener('mousemove', (e) => moveDashTooltip(e));
    g.addEventListener('mouseleave', hideDashTooltip);
    g.addEventListener('click', () => jumpToComparison(iv.fromIdx, iv.toIdx));
  });
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function showDashTooltip(e, iv) {
  const tip = el('dashTooltip');
  const label = iv.label ? iv.label : `${formatDate(iv.fromDate)} \u2192 ${formatDate(iv.toDate)}`;
  const skipNote = iv.skipped > 0
    ? `<div class="dash-tooltip-skip">${iv.skipped} snapshot${iv.skipped === 1 ? '' : 's'} skipped in between</div>`
    : '';
  tip.innerHTML = `
    <div class="dash-tooltip-title">${escapeHtml(label)}</div>
    <div class="dash-tooltip-row"><i class="dot dot-added"></i>${iv.added} added</div>
    <div class="dash-tooltip-row"><i class="dot dot-removed"></i>${iv.removed} removed</div>
    <div class="dash-tooltip-row"><i class="dot dot-changed"></i>${iv.changed} changed</div>
    ${skipNote}
  `;
  tip.hidden = false;
  moveDashTooltip(e);
}
function moveDashTooltip(e) {
  const tip = el('dashTooltip');
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 260) + 'px';
  tip.style.top = Math.max(e.clientY - 10, 10) + 'px';
}
function hideDashTooltip() { el('dashTooltip').hidden = true; }

function jumpToComparison(fromIdx, toIdx) {
  closeDashboard();
  state.fromIndex = fromIdx;
  state.toIndex = toIdx;
  positionHandles();
  loadDiff();
}

// ---------------------------------------------------------------- composition
function renderComposition(intervals) {
  const wrap = el('dashCompositionChart');
  const totals = intervals.reduce((acc, iv) => {
    acc.added += iv.added; acc.removed += iv.removed; acc.changed += iv.changed; return acc;
  }, { added: 0, removed: 0, changed: 0 });
  const grand = totals.added + totals.removed + totals.changed;

  if (!grand) {
    wrap.innerHTML = `<p class="dash-empty-note">No structural changes in this range.</p>`;
    return;
  }

  const pct = (v) => Math.round((v / grand) * 100);
  const rows = [
    ['added', 'Added', totals.added],
    ['removed', 'Removed', totals.removed],
    ['changed', 'Changed', totals.changed],
  ];

  const dominant = rows.reduce((a, b) => (b[2] > a[2] ? b : a), rows[0]);
  let readout = '';
  if (dominant[2] / grand > 0.45) {
    const phrase = dominant[0] === 'added' ? 'growing with new content'
      : dominant[0] === 'removed' ? 'shedding content over time'
        : 'mostly edits, not new material';
    readout = `<p class="dash-composition-readout muted small">Mostly ${phrase}.</p>`;
  }

  wrap.innerHTML = `
    <div class="dash-composition-total">
      ${totals.added ? `<span class="seg-added" style="width:${pct(totals.added)}%"></span>` : ''}
      ${totals.removed ? `<span class="seg-removed" style="width:${pct(totals.removed)}%"></span>` : ''}
      ${totals.changed ? `<span class="seg-changed" style="width:${pct(totals.changed)}%"></span>` : ''}
    </div>
    <div class="dash-row-list">
      ${rows.map(([key, label, val]) => `
        <div class="dash-row">
          <span class="dash-row-label"><i class="dot dot-${key}"></i>${label}</span>
          <div class="dash-row-track"><div class="dash-row-fill" style="width:${Math.max(3, pct(val))}%; background:var(--${key});"></div></div>
          <span class="dash-row-count">${pct(val)}%</span>
        </div>
      `).join('')}
    </div>
    ${readout}
  `;
}

// ---------------------------------------------------------------- tag chart
function renderTagChart(intervals) {
  const wrap = el('dashTagChart');
  const counts = {};
  intervals.forEach((iv) => Object.entries(iv.tagCounts).forEach(([t, c]) => { counts[t] = (counts[t] || 0) + c; }));

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  if (!entries.length) {
    wrap.innerHTML = `<p class="dash-empty-note">No structural changes in this range.</p>`;
    return;
  }
  const max = entries[0][1];

  wrap.innerHTML = `<div class="dash-row-list">
    ${entries.map(([tag, count]) => `
      <div class="dash-row">
        <span class="dash-row-label" title="&lt;${escapeHtml(tag)}&gt;">${escapeHtml(tagLabel(tag))}</span>
        <div class="dash-row-track"><div class="dash-row-fill" style="width:${Math.max(4, (count / max) * 100)}%;"></div></div>
        <span class="dash-row-count">${count}</span>
      </div>
    `).join('')}
  </div>`;
}

// ---------------------------------------------------------------- archive coverage (from
// state.snapshots alone — no diff fetch needed, so this renders instantly)
function renderCadence() {
  const wrap = el('dashCadenceChart');
  const snaps = state.snapshots;
  const minT = new Date(snaps[0].date).getTime();
  const maxT = new Date(snaps[snaps.length - 1].date).getTime();
  const span = Math.max(1, maxT - minT);

  const BUCKETS = Math.min(48, Math.max(12, snaps.length));
  const counts = new Array(BUCKETS).fill(0);
  snaps.forEach((s) => {
    const t = new Date(s.date).getTime();
    let idx = Math.floor(((t - minT) / span) * BUCKETS);
    if (idx >= BUCKETS) idx = BUCKETS - 1;
    counts[idx]++;
  });

  const W = 1000, H = 130, ML = 34, MR = 10, MT = 10, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const band = plotW / BUCKETS;
  const barW = Math.max(1.5, band * 0.72);
  const maxCount = Math.max(1, ...counts);

  let bars = '';
  const bucketMeta = [];
  counts.forEach((c, i) => {
    const h = (c / maxCount) * plotH;
    const x = ML + i * band + (band - barW) / 2;
    const y = MT + plotH - h;
    bucketMeta.push({
      count: c,
      from: minT + (span * i) / BUCKETS,
      to: minT + (span * (i + 1)) / BUCKETS,
    });
    bars += `<g class="dash-bar" data-i="${i}">
      <rect x="${x - 1}" y="${MT}" width="${barW + 2}" height="${plotH}" fill="transparent" />
      <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, c ? 1.5 : 0)}" fill="${c ? 'var(--ink-faint)' : 'transparent'}" rx="1.5" />
    </g>`;
  });

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="dash-axis-line" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />
    ${bars}
    <text class="dash-axis-label" x="${ML}" y="${H - MB + 18}" text-anchor="start">${escapeHtml(formatDate(snaps[0].date))}</text>
    <text class="dash-axis-label" x="${W - MR}" y="${H - MB + 18}" text-anchor="end">${escapeHtml(formatDate(snaps[snaps.length - 1].date))}</text>
  </svg>`;

  wrap.querySelectorAll('.dash-bar').forEach((g) => {
    const bucket = bucketMeta[parseInt(g.dataset.i, 10)];
    g.addEventListener('mouseenter', (e) => showCadenceTooltip(e, bucket));
    g.addEventListener('mousemove', (e) => moveDashTooltip(e));
    g.addEventListener('mouseleave', hideDashTooltip);
  });

  renderGapBreakdown(snaps);
}

function showCadenceTooltip(e, bucket) {
  const tip = el('dashTooltip');
  tip.innerHTML = `
    <div class="dash-tooltip-title">${escapeHtml(formatDate(new Date(bucket.from).toISOString()))} \u2013 ${escapeHtml(formatDate(new Date(bucket.to).toISOString()))}</div>
    <div class="dash-tooltip-row">${bucket.count} capture${bucket.count === 1 ? '' : 's'}</div>
  `;
  tip.hidden = false;
  moveDashTooltip(e);
}

function renderGapBreakdown(snaps) {
  const wrap = el('dashGapBreakdown');
  const gapsDays = [];
  for (let i = 0; i < snaps.length - 1; i++) {
    gapsDays.push(Math.round((new Date(snaps[i + 1].date) - new Date(snaps[i].date)) / 86400000));
  }
  const buckets = [
    ['< 1 day', (d) => d < 1],
    ['1\u20137 days', (d) => d >= 1 && d < 7],
    ['1\u20134 weeks', (d) => d >= 7 && d < 30],
    ['1\u20136 months', (d) => d >= 30 && d < 182],
    ['6 mo+', (d) => d >= 182],
  ].map(([label, test]) => [label, gapsDays.filter(test).length]);
  const maxBucket = Math.max(1, ...buckets.map((b) => b[1]));

  wrap.innerHTML = `
    <p class="dash-gap-breakdown-label muted small">Gaps between captures</p>
    <div class="dash-row-list">
      ${buckets.map(([label, count]) => `
        <div class="dash-row">
          <span class="dash-row-label">${label}</span>
          <div class="dash-row-track"><div class="dash-row-fill" style="width:${Math.max(3, (count / maxBucket) * 100)}%; background:var(--ink-faint);"></div></div>
          <span class="dash-row-count">${count}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------- leaderboard
function renderLeaderboard(intervals) {
  const wrap = el('dashLeaderboard');
  const top = intervals.slice().sort((a, b) => b.total - a.total).slice(0, 5);
  if (!top.length) {
    wrap.innerHTML = `<p class="dash-empty-note">Nothing to rank yet.</p>`;
    return;
  }
  const maxTotal = Math.max(1, ...top.map((t) => t.total));

  wrap.innerHTML = top.map((iv, i) => {
    const label = iv.label ? iv.label : `${formatDate(iv.fromDate)} \u2192 ${formatDate(iv.toDate)}`;
    const pctAdded = Math.max(0, (iv.added / maxTotal) * 100);
    const pctRemoved = Math.max(0, (iv.removed / maxTotal) * 100);
    const pctChanged = Math.max(0, (iv.changed / maxTotal) * 100);
    const title = iv.skipped > 0 ? ` title="Spans ${iv.skipped} skipped snapshot${iv.skipped === 1 ? '' : 's'}"` : '';
    return `<div class="dash-lb-row" data-i="${i}"${title}>
      <span class="dash-lb-rank">${i + 1}</span>
      <span class="dash-lb-dates">${escapeHtml(label)}</span>
      <span class="dash-lb-bar">
        ${iv.added ? `<span class="seg-added" style="width:${pctAdded}%"></span>` : ''}
        ${iv.removed ? `<span class="seg-removed" style="width:${pctRemoved}%"></span>` : ''}
        ${iv.changed ? `<span class="seg-changed" style="width:${pctChanged}%"></span>` : ''}
      </span>
      <span class="dash-lb-total">${iv.total} change${iv.total === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.dash-lb-row').forEach((row) => {
    const iv = top[parseInt(row.dataset.i, 10)];
    row.addEventListener('click', () => jumpToComparison(iv.fromIdx, iv.toIdx));
  });
}
