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

// How many snapshots the analysis samples across the record. Balanced is the
// only setting now that the resolution switch is gone: it lands roughly one
// bar per year of a long history, which is enough to see the shape of a site
// without asking the Archive for sixty diffs.
const SAMPLE_POINTS = 28;

// Bars are filled with the CSS custom properties themselves — flat, one ink
// per series, no gradients. Colour in this dashboard means added, removed or
// changed, and every other mark is neutral.
const SERIES_STACK = ['removed', 'changed', 'added']; // stacked bottom-up

const NUM = new Intl.NumberFormat();
const fmt = (n) => NUM.format(n);

// A month and a year, for the places a full date would be clipped to an
// ellipsis: "Oct 1999 → Sep 2026" says everything "Oct 8, 1999 → Sep 5, 20…"
// was trying to say and fits in the same card.
function monthYear(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// An axis people can read: whole ticks, and a top of the scale that lands on
// the last one — 0 / 100 / 200 / 300 / 400, not 0 / 78 / 155 / 233 with a
// 310 the axis never claims to reach. If the tallest bar runs past the highest
// number printed on the axis, the axis is not telling you the scale.
function niceScale(max, targetTicks) {
  if (!(max > 0)) return { step: 1, top: 1 };
  const raw = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // Rounded to a whole number of changes: this axis counts elements, so a
  // half-tick could only ever be labelled "1" twice.
  const step = Math.max(1, Math.round((norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag));
  return { step, top: Math.max(step, Math.ceil(max / step) * step) };
}

// A rectangle with only its top corners rounded — how a stack of bars should
// end. Emitted without a fill so the caller can point it at a gradient.
function topRoundedRect(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr < 0.5) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" />`;
  return `<path d="M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y}` +
    ` L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z" />`;
}

// Every chart is drawn in the width it is actually given, so a viewBox unit is
// a pixel and 11px axis type renders as 11px instead of being scaled up from a
// 1000-unit drawing. Below COMPACT_W the chart switches to compressed margins
// and a shorter plot rather than being shrunk, which would shrink its type
// with it. The floor is only a guard against a zero measurement.
const COMPACT_W = 620;
function chartWidth(node) {
  return Math.max(300, Math.round(node.clientWidth || 300));
}

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
  sig: null,                    // the record the intervals below belong to
  running: false,               // true while a queue is in flight for DASH.sig
  intervals: [],                // sparse array, filled positionally as fetches resolve
  completed: 0,
  totalPairs: 0,
  sampled: false,
  rangeLo: null,
  rangeHi: null,
};

// Reading a long history costs one /api/diff per sampled pair, and the answer
// for a given record never changes. So it is kept. Reopening the dashboard, or
// coming back to a site you already looked at, redraws from here instead of
// asking the Archive for the same thirty diffs over again.
//
// Keyed on the record itself — url, snapshot count and the two end timestamps —
// so a re-trace that returns a different list is analyzed afresh, and nothing
// else ever is.
const ANALYSIS_CACHE_MAX = 6;
const analysisCache = new Map();

function analysisSignature() {
  const s = state.snapshots;
  return `${state.url}|${s.length}|${s[0].timestamp}|${s[s.length - 1].timestamp}`;
}

function cacheAnalysis(sig) {
  analysisCache.delete(sig);             // re-insert: Map iteration is oldest-first
  analysisCache.set(sig, {
    intervals: DASH.intervals,
    totalPairs: DASH.totalPairs,
    sampled: DASH.sampled,
  });
  while (analysisCache.size > ANALYSIS_CACHE_MAX) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
}

function restoreAnalysis(entry) {
  DASH.intervals = entry.intervals;
  DASH.totalPairs = entry.totalPairs;
  DASH.sampled = entry.sampled;
  DASH.completed = entry.totalPairs;
}

// The masthead's one line of prose, and the caption over the chart. Both depend
// only on what was analyzed, so both are re-stated whenever we redraw —
// whether that reading came off the wire or out of the cache.
function describeAnalysis() {
  el('dashSubtitle').textContent = DASH.sampled
    ? `${state.snapshots.length} snapshots on file \u00b7 analyzing ${DASH.totalPairs + 1} of them across the full span`
    : `${state.snapshots.length} snapshots on file \u00b7 analyzing every one of them`;
  el('dashActivityHint').textContent = DASH.sampled
    ? 'Click a bar to open it \u00b7 hover for skipped snapshots'
    : 'Click any bar to open that comparison';
}

// The dashboard presents one fixed reading of the record: consecutive
// snapshots, sampled evenly across calendar time, all three series drawn.
// There is no resolution switch, no grouping switch and no series filter —
// what is on screen is the whole picture, and the only thing you can change is
// which stretch of it you are looking at.

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
  el('dashBody').scrollTop = 0;

  if (DASH.forUrl !== state.url) {
    DASH.forUrl = state.url;
    DASH.rangeLo = null;
    DASH.rangeHi = null;
  }

  renderCadence();     // needs only state.snapshots — instant, no fetch required

  const sig = analysisSignature();
  const cached = analysisCache.get(sig);
  if (cached) {
    // This exact record has already been read. Redraw it; fetch nothing — but
    // first abandon any run still in flight for a different record, or it will
    // land in this dashboard when it finishes.
    DASH.gen++;
    DASH.running = false;
    DASH.sig = sig;
    restoreAnalysis(cached);
    describeAnalysis();
    renderAll();
    return;
  }

  if (DASH.sig === sig && DASH.running) {
    // A run for this record is already in flight. Reopening must not start a
    // second one — show where the first has got to and let it finish itself.
    describeAnalysis();
    renderKpiSkeleton();
    renderLoadingSkeletons();
    updateLoadingProgressText();
    return;
  }

  startAnalysis();
}

function closeDashboard() {
  el('dashboardModal').hidden = true;
  document.body.style.overflow = '';
  hideDashTooltip();
}

// Every chart is measured to its container, so a resize has to redraw or the
// plot keeps the width it was born with. Debounced: a drag-resize fires this
// on every frame, and the analysis itself is untouched by a width change.
let dashResizeTimer = null;
window.addEventListener('resize', () => {
  if (el('dashboardModal').hidden) return;
  clearTimeout(dashResizeTimer);
  dashResizeTimer = setTimeout(() => {
    renderCadence();
    if (DASH.completed >= DASH.totalPairs) renderCharts();
  }, 140);
});

// ---------------------------------------------------------------- range (plain selects)
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
  // A tail this short fits on screen at once, so there is nothing to narrow.
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
  const maxPoints = SAMPLE_POINTS;

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
  const sig = analysisSignature();

  DASH.sig = sig;
  DASH.running = true;
  DASH.intervals = new Array(pairs.length);
  DASH.completed = 0;
  DASH.totalPairs = pairs.length;
  DASH.sampled = pairs.length < state.snapshots.length - 1;

  describeAnalysis();
  renderKpiSkeleton();
  renderLoadingSkeletons();

  if (pairs.length === 0) {
    DASH.running = false;
    cacheAnalysis(sig);
    renderAll();
    return;
  }

  await runQueue(pairs, 4, myGen);
  if (DASH.gen !== myGen) return; // superseded by a newer analysis
  DASH.running = false;

  // A failed pair is left uncached on purpose: a flaky minute should be
  // retryable by reopening, not frozen into the dashboard forever.
  if (!DASH.intervals.some((iv) => iv && iv.error)) cacheAnalysis(sig);
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
// One interval per analyzed pair, narrowed to whatever range is selected.
function getVisibleIntervals() {
  const all = DASH.intervals.filter(Boolean);
  const lo = DASH.rangeLo ?? 0;
  const hi = DASH.rangeHi ?? Math.max(0, all.length - 1);
  return all.slice(lo, hi + 1);
}

// ---------------------------------------------------------------- measures
// Every measure follows the same shape: a small tracked caption, one large
// figure, and one annotation line under a rule. Nothing may wrap to a second
// line: anything that would have been too long is either shortened to the part
// that carries the meaning (month and year, never a clipped date) or moved
// into the title attribute as a native hover tooltip.
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
  const pending = opts.pending ? ' is-pending' : '';
  const clickable = opts.onClick ? ' dash-kpi-clickable' : '';
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
  const id = opts.id ? ` id="${opts.id}"` : '';
  const unit = opts.unit ? `<span class="dash-kpi-unit">${escapeHtml(opts.unit)}</span>` : '';
  const body = opts.subHtml != null ? opts.subHtml : escapeHtml(sub == null ? '' : sub);
  return `<div class="dash-kpi${clickable}"${id}${title}>
    <span class="dash-kpi-label">${escapeHtml(label)}</span>
    <span class="dash-kpi-value${accent}${pending}">${value}${unit}</span>
    <span class="dash-kpi-sub">${body}</span>
  </div>`;
}

// The longest gap needs nothing but the snapshot list, so it is known before a
// single diff comes back — it renders at full strength while the rest of the
// strip is still counting itself up.
function gapKpi(gap) {
  if (gap.days < 0) return kpiCard('Longest capture gap', '\u2014', '', { subHtml: '' });
  return kpiCard('Longest capture gap', fmt(gap.days), '', {
    unit: 'days',
    subHtml: `${escapeHtml(monthYear(gap.fromDate))} \u2192 ${escapeHtml(monthYear(gap.toDate))}`,
    title: 'The crawler did not return during this window',
  });
}

function renderKpiSkeleton() {
  const n = state.snapshots.length;
  const first = state.snapshots[0].date, last = state.snapshots[n - 1].date;
  el('dashKpiRow').innerHTML = [
    kpiCard('Snapshots tracked', fmt(n), '', { subHtml: `Since ${escapeHtml(formatDate(first))}` }),
    kpiCard('History span', humanDuration(first, last), '', {
      subHtml: `${escapeHtml(monthYear(first))} \u2192 ${escapeHtml(monthYear(last))}`,
    }),
    kpiCard('Total changes', '\u2014', '', { accent: true, pending: true, subHtml: 'Calculating\u2026' }),
    gapKpi(longestCaptureGap()),
    kpiCard('Largest difference', '\u2014', '', { pending: true, subHtml: 'Calculating\u2026' }),
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

  // The three figures are painted in their own series colour but keep their
  // +/-/~ marks, so the line still reads correctly without the colour.
  const sep = `<span class="dash-kpi-sub-sep">\u00b7</span>`;
  const fig = (key, sign, val) =>
    `<span class="dash-kpi-fig is-${key}"><b>${sign}${fmt(val)}</b></span>`;
  const countsSub = fig('added', '+', totals.added) + sep +
    fig('removed', '\u2212', totals.removed) + sep +
    fig('changed', '~', totals.changed);

  el('dashKpiRow').innerHTML = [
    kpiCard('Snapshots tracked', fmt(n), '', { subHtml: `Since ${escapeHtml(formatDate(first))}` }),
    kpiCard('History span', humanDuration(first, last), '', {
      subHtml: `${escapeHtml(monthYear(first))} \u2192 ${escapeHtml(monthYear(last))}`,
    }),
    kpiCard('Total changes', fmt(grandTotal), '', {
      accent: true,
      subHtml: countsSub,
      title: `Across ${fmt(done.length)} analyzed comparisons: ` +
        `${fmt(totals.added)} added, ${fmt(totals.removed)} removed, ${fmt(totals.changed)} edited`,
    }),
    gapKpi(gap),
    busy
      ? kpiCard('Largest difference', fmt(busy.total), '', {
          accent: true, id: 'dashBusiestKpi', onClick: true,
          subHtml: `${escapeHtml(monthYear(busy.fromDate))} \u2192 ${escapeHtml(monthYear(busy.toDate))}`,
          title: (busy.skipped > 0 ? `Spans ${busy.skipped} unanalyzed snapshot${busy.skipped === 1 ? '' : 's'}. ` : '') +
            'Click to open this comparison',
        })
      : kpiCard('Largest difference', '0', '', { subHtml: '' }),
  ].join('');

  if (busy) el('dashBusiestKpi').addEventListener('click', () => jumpToComparison(busy.fromIdx, busy.toIdx));
}

// ---------------------------------------------------------------- activity chart (SVG)
function seriesTotal(iv) {
  return iv.added + iv.removed + iv.changed;
}

// Chart geometry, in one place: the plots are measured to their container, so
// these numbers are pixels on screen and the type never gets resampled.
const ACTIVITY_H = 348, ACTIVITY_ML = 60, ACTIVITY_MR = 22, ACTIVITY_MT = 30, ACTIVITY_MB = 48;


function renderActivityChart(intervals) {
  const wrap = el('dashActivityChart');
  if (!intervals.length) {
    wrap.innerHTML = `<p class="dash-empty-note">Nothing in the focused range.</p>`;
    return;
  }

  const W = chartWidth(wrap);
  const compact = W < COMPACT_W;
  const H = compact ? 252 : ACTIVITY_H;
  const ML = compact ? 34 : ACTIVITY_ML;
  const MR = compact ? 10 : ACTIVITY_MR;
  const MT = compact ? 18 : ACTIVITY_MT;
  const MB = compact ? 36 : ACTIVITY_MB;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = intervals.length;
  const band = plotW / n;
  // Caps the width so a coarse reading does not become four fat slabs.
  const barW = Math.max(3, Math.min(band * 0.6, 30));

  const peak = Math.max(1, ...intervals.map(seriesTotal));
  const { step, top: axisTop } = niceScale(peak, 4);
  const y = (v) => (v / axisTop) * plotH;

  let grid = '';
  // Ticks run to the top of the scale, not to the peak, so the highest number
  // printed is the number the axis actually reaches.
  for (let g = 0; g * step <= axisTop + 1e-9; g++) {
    const val = g * step;
    const yy = MT + plotH - y(val);
    if (g > 0) grid += `<line class="dash-gridline" x1="${ML}" y1="${yy}" x2="${W - MR}" y2="${yy}" />`;
    grid += `<text class="dash-axis-label" x="${ML - 10}" y="${yy + 4}" text-anchor="end">${fmt(Math.round(val))}</text>`;
  }

  let bars = '';
  intervals.forEach((iv, i) => {
    const x = ML + i * band + (band - barW) / 2;
    const stack = SERIES_STACK
      .filter((key) => iv[key])
      .map((key) => ({ key, val: iv[key] }));

    let bottom = MT + plotH;
    let segs = '';
    stack.forEach((s, k) => {
      const h = Math.max(1.5, y(s.val));
      const top = bottom - h;
      const isTop = k === stack.length - 1;
      // A hairline of card showing through between two stacked colours, so the
      // boundary between them stays legible when the tones sit close together.
      const segTop = k === 0 ? top : top + 1;
      const segH = Math.max(0.8, h - (k === 0 ? 0 : 1));
      const shape = isTop
        ? topRoundedRect(x, segTop, barW, segH, Math.min(2, barW / 2))
        : `<rect x="${x}" y="${segTop}" width="${barW}" height="${segH}" rx="1" />`;
      segs += `<g fill="var(--${s.key})" class="dash-bar-seg">${shape}</g>`;
      bottom -= h;
    });

    bars += `<g class="dash-bar" data-i="${i}">
        <rect class="dash-bar-wash" x="${ML + i * band}" y="${MT}" width="${band}" height="${plotH}" />
        ${segs}
        <rect class="dash-bar-hit" x="${ML + i * band}" y="${MT}" width="${band}" height="${plotH}" fill="transparent" />
      </g>`;
  });

  // Date labels are placed greedily and dropped when they would collide. The
  // last bar always keeps its date, because "when does this record end" is the
  // one question an axis must answer — it displaces its neighbour instead of
  // being dropped itself.
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const marks = [];
  const MIN_LABEL_GAP = 14;
  for (let i = 0; i < n; i += labelEvery) marks.push(i);
  if (marks[marks.length - 1] !== n - 1) marks.push(n - 1);

  const kept = [];
  marks.forEach((i) => {
    const cx = ML + i * band + band / 2;
    const text = intervals[i].label || shortDate(intervals[i].toDate);
    const half = Math.max(17, text.length * 3.3);
    while (kept.length && cx - half < kept[kept.length - 1].right + MIN_LABEL_GAP) {
      if (i === n - 1) kept.pop();
      else return;
    }
    kept.push({ cx, text, right: cx + half });
  });
  const xLabels = kept.map((m) =>
    `<text class="dash-axis-label" x="${m.cx}" y="${H - MB + 24}" text-anchor="middle">${escapeHtml(m.text)}</text>`
  ).join('');

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    ${grid}
    <line class="dash-axis-line" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />
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
  const total = iv.added + iv.removed + iv.changed;
  const skipNote = iv.skipped > 0
    ? `<div class="dash-tooltip-skip">${fmt(iv.skipped)} archived snapshot${iv.skipped === 1 ? '' : 's'} in between were not analyzed</div>`
    : '';
  tip.innerHTML = `
    <div class="dash-tooltip-title">${escapeHtml(label)}</div>
    <div class="dash-tooltip-row"><i class="dot dot-added"></i>added<b>${fmt(iv.added)}</b></div>
    <div class="dash-tooltip-row"><i class="dot dot-removed"></i>removed<b>${fmt(iv.removed)}</b></div>
    <div class="dash-tooltip-row"><i class="dot dot-changed"></i>changed<b>${fmt(iv.changed)}</b></div>
    <div class="dash-tooltip-row dash-tooltip-row-total">in total<b>${fmt(total)}</b></div>
    ${skipNote}
  `;
  tip.hidden = false;
  moveDashTooltip(e);
}
function moveDashTooltip(e) {
  const tip = el('dashTooltip');
  const w = tip.offsetWidth || 240;
  const h = tip.offsetHeight || 120;
  // Flip to the other side of the cursor rather than let the card run off the
  // right or bottom edge of the window.
  const left = e.clientX + 16 + w > window.innerWidth - 12 ? e.clientX - w - 16 : e.clientX + 16;
  const top = Math.min(Math.max(e.clientY - 12, 12), window.innerHeight - h - 12);
  tip.style.left = Math.max(12, left) + 'px';
  tip.style.top = top + 'px';
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

  el('dashCompositionHint').textContent = grand ? `${fmt(grand)} changes in all` : 'Nothing to chart';
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

  wrap.innerHTML = `
    <div class="dash-composition-total">
      ${rows.filter(([, , val]) => val).map(([key, label, val]) =>
        `<span class="seg-${key}" style="width:${(val / grand) * 100}%" title="${fmt(val)} ${label.toLowerCase()}"></span>`
      ).join('')}
    </div>
    <div class="dash-row-list">
      ${rows.map(([key, label, val]) => `
        <div class="dash-row">
          <span class="dash-row-label"><i class="dot dot-${key}"></i>${label}</span>
          <div class="dash-row-track"><div class="dash-row-fill" style="width:${Math.max(3, pct(val))}%; background:var(--${key});"></div></div>
          <span class="dash-row-count">${fmt(val)}<span class="dash-row-pct">${pct(val)}%</span></span>
        </div>
      `).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------- tag chart
function renderTagChart(intervals) {
  const wrap = el('dashTagChart');
  const counts = {};
  intervals.forEach((iv) => Object.entries(iv.tagCounts).forEach(([t, c]) => { counts[t] = (counts[t] || 0) + c; }));

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  el('dashTagHint').textContent = ranked.length
    ? `${ranked.length} element type${ranked.length === 1 ? '' : 's'} touched`
    : 'Nothing to chart';
  if (!ranked.length) {
    wrap.innerHTML = `<p class="dash-empty-note">No structural changes in this range.</p>`;
    return;
  }
  const entries = ranked.slice(0, 7);
  const max = entries[0][1];
  const touched = ranked.reduce((a, [, c]) => a + c, 0);

  wrap.innerHTML = `<div class="dash-row-list">
    ${entries.map(([tag, count]) => `
      <div class="dash-row">
        <span class="dash-row-label" title="&lt;${escapeHtml(tag)}&gt;"><i class="dot dot-blank"></i>${escapeHtml(tagLabel(tag))}</span>
        <div class="dash-row-track"><div class="dash-row-fill" style="width:${Math.max(4, (count / max) * 100)}%;"></div></div>
        <span class="dash-row-count">${fmt(count)}</span>
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

  const W = chartWidth(wrap);
  const compact = W < COMPACT_W;
  // Roughly one bar per 22px, so the density stays honest rather than being
  // fixed at a count that looks right in one window width and wrong in another.
  const BUCKETS = Math.max(10, Math.min(56, Math.round(W / (compact ? 16 : 22))));
  const counts = new Array(BUCKETS).fill(0);
  snaps.forEach((s) => {
    const t = new Date(s.date).getTime();
    let idx = Math.floor(((t - minT) / span) * BUCKETS);
    if (idx >= BUCKETS) idx = BUCKETS - 1;
    counts[idx]++;
  });

  const H = compact ? 136 : 172;
  const ML = compact ? 10 : 20, MR = compact ? 10 : 20, MT = compact ? 14 : 30, MB = compact ? 30 : 32;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const band = plotW / BUCKETS;
  const barW = Math.max(2, Math.min(band * 0.66, 20));
  const maxCount = Math.max(1, ...counts);

  let bars = '';
  const bucketMeta = [];
  counts.forEach((c, i) => {
    const h = c ? Math.max(3, (c / maxCount) * plotH) : 0;
    const x = ML + i * band + (band - barW) / 2;
    const y = MT + plotH - h;
    bucketMeta.push({
      count: c,
      from: minT + (span * i) / BUCKETS,
      to: minT + (span * (i + 1)) / BUCKETS,
    });
    bars += `<g class="dash-bar" data-i="${i}">
      <rect class="dash-bar-wash" x="${ML + i * band}" y="${MT}" width="${band}" height="${plotH}" />
      ${c ? `<g fill="var(--coverage)" class="dash-bar-seg">${topRoundedRect(x, y, barW, h, Math.min(2, barW / 2))}</g>` : ''}
      <rect class="dash-bar-hit" x="${ML + i * band}" y="${MT}" width="${band}" height="${plotH}" fill="transparent" />
    </g>`;
  });

  const atMs = (t) => formatDate(new Date(t).toISOString());

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    ${bars}
    <line class="dash-axis-line" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />
    <text class="dash-axis-label" x="${ML}" y="${H - MB + 22}" text-anchor="start">${escapeHtml(atMs(minT))}</text>
    <text class="dash-axis-label" x="${W / 2}" y="${H - MB + 22}" text-anchor="middle">${escapeHtml(atMs(minT + span / 2))}</text>
    <text class="dash-axis-label" x="${W - MR}" y="${H - MB + 22}" text-anchor="end">${escapeHtml(atMs(maxT))}</text>
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
    <div class="dash-tooltip-row"><i class="dot" style="background:var(--coverage)"></i>captures<b>${fmt(bucket.count)}</b></div>
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
    ['Under a day', (d) => d < 1],
    ['1\u20137 days', (d) => d >= 1 && d < 7],
    ['1\u20134 weeks', (d) => d >= 7 && d < 30],
    ['1\u20136 months', (d) => d >= 30 && d < 182],
    ['Six months or more', (d) => d >= 182],
  ].map(([label, test]) => [label, gapsDays.filter(test).length]);
  const maxBucket = Math.max(1, ...buckets.map((b) => b[1]));

  wrap.innerHTML = `
    <p class="dash-gap-breakdown-label">Gaps between captures</p>
    <div class="dash-row-list">
      ${buckets.map(([label, count]) => `
        <div class="dash-row">
          <span class="dash-row-label">${label}</span>
          <div class="dash-row-track">${count
            ? `<div class="dash-row-fill" style="width:${Math.max(4, (count / maxBucket) * 100)}%"></div>`
            : ''}</div>
          <span class="dash-row-count">${fmt(count)}</span>
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

  // Bar widths are a share of the largest row, so the leader's bar fills the
  // column and every other row is read against it at a glance.
  const pctOfMax = (v) => Math.max(0, (v / maxTotal) * 100);

  wrap.innerHTML = top.map((iv, i) => {
    const label = iv.label ? iv.label : `${formatDate(iv.fromDate)} \u2192 ${formatDate(iv.toDate)}`;
    const title = iv.skipped > 0
      ? ` title="Spans ${fmt(iv.skipped)} unanalyzed snapshot${iv.skipped === 1 ? '' : 's'}"`
      : '';
    return `<div class="dash-lb-row" data-i="${i}"${title}>
      <span class="dash-lb-rank">${i + 1}</span>
      <span class="dash-lb-dates">${escapeHtml(label)}</span>
      <span class="dash-lb-bar">
        ${iv.added ? `<span class="seg-added" style="width:${pctOfMax(iv.added)}%"></span>` : ''}
        ${iv.removed ? `<span class="seg-removed" style="width:${pctOfMax(iv.removed)}%"></span>` : ''}
        ${iv.changed ? `<span class="seg-changed" style="width:${pctOfMax(iv.changed)}%"></span>` : ''}
      </span>
      <span class="dash-lb-total">${fmt(iv.total)}<em>changes</em></span>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.dash-lb-row').forEach((row) => {
    const iv = top[parseInt(row.dataset.i, 10)];
    row.addEventListener('click', () => jumpToComparison(iv.fromIdx, iv.toIdx));
  });
}
