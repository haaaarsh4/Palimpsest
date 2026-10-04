// public/claims.js
//
// The claim-records page. It does three things, in order, and only the first of
// them is slow.
//
//   1. Make sure the record is on file. The analysis runs on the server over
//      the cached captures of one address, and those captures are the same rows
//      the compare view and the timelapse read. If some of the record has never
//      been read, this walks the missing captures itself, one request per
//      capture, at the Archive's own pace, with an honest progress bar, and
//      then asks for the analysis again.
//   2. Ask for the analysis. One request; a report that has already been built
//      for this record and this version of the rules comes back immediately.
//   3. Draw it. Every number on the page comes from the report and nothing is
//      computed here that the report does not contain, so the page cannot drift
//      from the analysis.
//
// The one thing this file decides for itself is geometry: where a date sits on
// a timeline, how long a bar is, how tall a column is. That is drawing, not
// analysis, and it is the only place the page is allowed to have an opinion.

// The reading is paused while this page's interface is being settled. While it
// is true, the button, the chips and any address handed over in the query
// string do nothing at all, so this page never reaches the backend. Flip it to
// false to put the reading back.
const CW_PAUSED = true;

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CATEGORY_LABELS = {
  climate: 'Climate',
  social: 'People',
  labour: 'Labour',
  privacy: 'Privacy',
  governance: 'Governance',
  service: 'Customers',
  other: 'General',
};

// ---------------------------------------------------------------- formatting

function dateOf(ts) {
  const s = String(ts || '');
  const y = s.slice(0, 4), m = parseInt(s.slice(4, 6), 10), d = parseInt(s.slice(6, 8), 10);
  if (!y || !m) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function shortDate(ts) {
  const s = String(ts || '');
  return `${MONTHS[parseInt(s.slice(4, 6), 10) - 1]} ${s.slice(0, 4)}`;
}

function timeOf(ts) { return new Date(Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8))).getTime(); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function humanMonths(m) {
  if (m === null || m === undefined) return null;
  const abs = Math.abs(Math.round(m));
  if (abs < 24) return `${abs} month${abs === 1 ? '' : 's'}`;
  return `${(abs / 12).toFixed(abs % 12 === 0 ? 0 : 1)} years`;
}

function normaliseInput(raw) {
  let s = String(raw || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return s;
}

// ---------------------------------------------------------------- record walk

// The report already tells us which captures it read. Anything in the snapshot
// list that is missing from it has never been fetched, and the Archive is the
// only place it can come from, so this is the slow, honest part, asked for
// only when it is actually needed.
async function cwReadRecord(url, snapshots, have, onProgress) {
  const wanted = snapshots.map((s) => s.timestamp).filter((ts) => !have.has(ts));
  if (!wanted.length) return;

  const started = Date.now();
  let done = 0;
  let failed = 0;
  let cursor = 0;
  const LANES = 4;

  await Promise.all(Array.from({ length: LANES }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= wanted.length) return;
      try {
        const res = await fetch(`/api/capture?url=${encodeURIComponent(url)}&ts=${encodeURIComponent(wanted[i])}`);
        if (!res.ok) failed++;
      } catch (_) {
        failed++;
      }
      done++;
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(0.5, elapsed);
      onProgress({ done, total: wanted.length, failed, etaSeconds: (wanted.length - done) / Math.max(0.2, rate) });
    }
  }));
}

function cwPaintProgress(state) {
  el('cwProgress').hidden = false;
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  el('cwProgressCount').textContent = `${fmt.format(state.done)} / ${fmt.format(state.total)}`;
  el('cwProgressFill').style.width = `${pct}%`;

  if (state.phase === 'analyzing') {
    el('cwProgressTitle').textContent = 'Reading the promises';
    el('cwProgressSub').textContent = 'Scanning every capture for commitments, and following each one across the years…';
    return;
  }
  el('cwProgressTitle').textContent = 'Reading the record';
  const left = state.etaSeconds && isFinite(state.etaSeconds)
    ? ` · about ${state.etaSeconds > 90 ? `${Math.round(state.etaSeconds / 60)} min` : `${Math.round(state.etaSeconds)} sec`} left`
    : '';
  el('cwProgressSub').textContent = state.total
    ? `Fetching the captures that are not on file yet${left}. The Archive serves about one page a second, so this is the slow part.`
    : 'Asking for the analysis…';
}

// ---------------------------------------------------------------- entry

async function cwRun(rawUrl) {
  if (CW_PAUSED) return;
  const url = normaliseInput(rawUrl);
  if (!url) return;

  el('cwError').hidden = true;
  el('cwEmpty').hidden = true;
  el('cwReportSection').hidden = true;
  location.hash = `#${url}`;
  const historyUrl = new URL(location.href);
  historyUrl.searchParams.set('url', url);
  window.history.replaceState(null, '', historyUrl);

  cwPaintProgress({ phase: 'fetching', done: 0, total: 0, etaSeconds: 0 });

  let snapshots = [];
  try {
    const res = await fetch(`/api/snapshots?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not reach the Wayback Machine.');
    snapshots = data.snapshots || [];
  } catch (err) {
    cwFail(err.message);
    return;
  }
  if (snapshots.length < 2) {
    cwFail('The Archive has fewer than two captures of this address, so there is no record to read.');
    return;
  }

  let report;
  try {
    report = await cwFetchReport(url);
  } catch (err) {
    cwFail(err.message);
    return;
  }
  if (!report) return;   // already reported

  const have = new Set(report.coverage.analyzedTimestamps || []);
  const missing = snapshots.filter((s) => !have.has(s.timestamp));

  if (missing.length) {
    await cwReadRecord(url, snapshots, have, (p) => cwPaintProgress(Object.assign({ phase: 'fetching' }, p)));
    cwPaintProgress({ phase: 'analyzing', done: 1, total: 1, etaSeconds: 0 });
    try {
      report = await cwFetchReport(url);
    } catch (err) {
      cwFail(err.message);
      return;
    }
    if (!report) return;
  }

  el('cwProgress').hidden = true;
  cwRender(url, report, snapshots.length);
}

async function cwFetchReport(url) {
  const res = await fetch(`/api/claims?url=${encodeURIComponent(url)}`);
  if (res.status === 409) {
    // Nothing on file yet at all: the walk above will fix that, so this is not
    // an error, it is a first visit. An empty report is the honest stand-in.
    return {
      coverage: { captures: 0, analyzedTimestamps: [], first: null, last: null, spanDays: 0 },
      summary: { threads: 0, erased: 0, softened: 0, live: 0, index: 0, band: 'Not read yet', specificErasures: 0, clusters: 0 },
      categories: [], clusters: [], deadlineBuckets: [], survival: [], threads: [],
      url,
    };
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not analyze that record.');
  return data.report;
}

function cwFail(message) {
  el('cwProgress').hidden = true;
  el('cwError').hidden = false;
  el('cwError').textContent = message;
}

// ---------------------------------------------------------------- render

function cwRender(url, report, snapshotCount) {
  const s = report.summary;

  if (!report.threads.length) {
    el('cwEmpty').hidden = false;
    el('cwEmptyTitle').textContent =
      s.band === 'Not read yet' ? 'This record has not been read yet' : 'No promises found on this record';
    el('cwEmptyText').textContent =
      `Palimpsest read ${fmt.format(report.coverage.captures)} captures of ${url}, spanning ` +
      `${report.coverage.first ? `${dateOf(report.coverage.first)} to ${dateOf(report.coverage.last)}` : 'no dates at all'}, ` +
      `and found no sentence that made a commitment this analysis can hold to a date. ` +
      `That is a result, not a failure: plenty of pages never promise anything measurable, and ` +
      `this one is being read for what it said, not for what its industry says.`;
    return;
  }

  el('cwReportSection').hidden = false;
  cwRenderVerdict(url, report, snapshotCount);
  cwRenderCluster(report);
  cwRenderRibbons(report);
  cwRenderDossiers(report);
  cwRenderDeadlines(report);
  cwRenderSurvival(report);
  cwRenderCategories(report);
  cwRenderCoverage(url, report, snapshotCount);
}

function cwRenderVerdict(url, report, snapshotCount) {
  const s = report.summary;
  el('cwIndex').textContent = s.index;
  el('cwBand').textContent = s.band;

  const perYear = report.coverage.spanDays ? (report.coverage.spanDays / 365) : 1;
  el('cwVerdictNote').textContent =
    `${s.threads} distinct claims on this record${s.specificErasures ? `, ${s.specificErasures} of them carrying a number or a deadline that are no longer being made` : ''}. ` +
    `${s.erased} were withdrawn, ${s.softened ? `${s.softened} were softened while staying on the page, ` : ''}${s.live} are still being made. ` +
    `The record covers ${fmt.format(report.coverage.captures)} captures over ${perYear < 1 ? 'less than a year' : `${perYear.toFixed(perYear < 10 ? 1 : 0)} years`}.`;

  const stats = [
    ['Claims tracked', fmt.format(s.threads)],
    ['Withdrawn', fmt.format(s.erased)],
    ['Still standing', fmt.format(s.live)],
    ['With a number or date', fmt.format(s.quantified)],
    ['Named a deadline', fmt.format(s.withDeadline)],
    ['Erasures with a number or date', fmt.format(s.specificErasures)],
  ];
  if (s.clusters) stats.push(['Claims dropped in one edit', fmt.format(s.largestCluster)]);
  el('cwStats').innerHTML = stats.map(([label, value]) => `
    <div class="cw-stat">
      <span class="cw-stat-value mono">${value}</span>
      <span class="cw-stat-label">${escapeHtml(label)}</span>
    </div>`).join('');
}

function cwRenderCluster(report) {
  const biggest = (report.clusters || [])[0];
  if (!biggest || biggest.count < 3) { el('cwCluster').hidden = true; return; }
  el('cwCluster').hidden = false;
  el('cwCluster').innerHTML = `
    <span class="cw-cluster-eyebrow">One edit, ${escapeHtml(String(biggest.count))} promises</span>
    <p class="cw-cluster-lead">
      ${escapeHtml(String(biggest.count))} claims left this page in the same capture, all around
      ${escapeHtml(dateOf(biggest.ts))}. A record where promises go one at a time is a page changing
      its mind. A record where they go together is a page being rewritten.
    </p>
    <ul class="cw-cluster-list">
      ${biggest.texts.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}
    </ul>`;
}

function cwRenderRibbons(report) {
  const start = timeOf(report.coverage.first);
  // The axis runs to the furthest deadline on the record, not just to the last
  // capture. A 2030 promise withdrawn in 2025 has five years of runway left,
  // and the only way to see that is to draw the runway.
  let end = timeOf(report.coverage.last);
  for (const t of report.threads) {
    if (t.deadline && t.deadline.year) {
      const at = new Date(t.deadline.year + 1, 0, 1).getTime();
      if (at > end) end = at;
    }
  }
  const span = Math.max(1, end - start);
  const pct = (t) => Math.max(0, Math.min(100, ((t - start) / span) * 100));

  const shown = report.threads.slice(0, 16);
  el('cwRibbons').innerHTML = shown.map((t) => {
    const from = pct(timeOf(t.firstSeen));
    const to = pct(timeOf(t.lastSeen));
    const width = Math.max(0.6, to - from);
    const dead = t.deadline && t.deadline.year ? new Date(t.deadline.year + 1, 0, 1).getTime() : null;
    const deadPct = dead ? pct(dead) : null;
    const gapFrom = t.erasure ? pct(timeOf(t.erasure.erasedAt)) : to;

    const marks = [];
    if (t.erasure) marks.push(`<span class="cw-mark is-erased" style="left:${gapFrom}%" title="Withdrawn by ${escapeHtml(dateOf(t.erasure.erasedAt))}"></span>`);
    if (deadPct !== null) {
      marks.push(`<span class="cw-mark is-deadline" style="left:${deadPct}%" title="Its own deadline: ${escapeHtml(String(t.deadline.year))}">
        <b>${escapeHtml(String(t.deadline.year))}</b></span>`);
    }
    const gaps = (t.absenceWindows || []).map((w) => {
      const a = pct(timeOf(w.from));
      return `<span class="cw-gapmark" style="left:${Math.max(from, a)}%; width:${Math.max(0.4, Math.min(to, pct(100)) - Math.max(from, a))}%"></span>`;
    }).join('');

    const status = t.status === 'erased' ? 'withdrawn' : t.status === 'softened' ? 'softened' : 'still said';
    const foot = [
      `first said ${escapeHtml(dateOf(t.firstSeen))}`,
      `last said ${escapeHtml(dateOf(t.lastSeen))}`,
      t.erasure ? `gone by ${escapeHtml(dateOf(t.erasure.erasedAt))}` : null,
      t.monthsBeforeDeadline !== null ? `${escapeHtml(humanMonths(t.monthsBeforeDeadline))} before its own deadline` : null,
    ].filter(Boolean).join(' · ');

    return `
    <div class="cw-ribbon">
      <div class="cw-ribbon-top">
        <span class="cw-score-badge" title="Withdrawal score, 0 to 100">${escapeHtml(String(t.score))}</span>
        <span class="cw-cat is-${escapeHtml(t.category)}">${escapeHtml(CATEGORY_LABELS[t.category] || t.category)}</span>
        <p class="cw-claim-text" title="${escapeHtml(t.text)}">${escapeHtml(t.text)}</p>
        <span class="cw-status is-${escapeHtml(t.status)}">${escapeHtml(status)}</span>
      </div>
      <div class="cw-track">
        <span class="cw-track-axis"></span>
        <span class="cw-span" style="left:${from}%; width:${width}%"></span>
        ${t.erasure ? `<span class="cw-abs" style="left:${gapFrom}%; width:${Math.max(0.6, 100 - gapFrom)}%"></span>` : ''}
        ${gaps}
        ${marks.join('')}
      </div>
      <div class="cw-ribbon-foot">${foot}</div>
    </div>`;
  }).join('');
}

function cwRenderDossiers(report) {
  const erased = report.threads.filter((t) => t.erasure).slice(0, 8);
  if (!erased.length) {
    el('cwDossiers').innerHTML = '<p class="cw-muted">Nothing was withdrawn on this record. Every claim it made is still being made.</p>';
    return;
  }
  el('cwDossiers').innerHTML = erased.map((t) => {
    const distance = t.monthsBeforeDeadline !== null
      ? `${humanMonths(t.monthsBeforeDeadline)} before its own ${t.deadline.year} deadline`
      : 'no deadline attached to it';
    const rows = [
      ['First said', dateOf(t.firstSeen)],
      ['Last said', dateOf(t.lastSeen)],
      ['Gone by', dateOf(t.erasure.erasedAt)],
      ['Left the page for', `${fmt.format(t.erasure.absentCaptures)} captures · ${fmt.format(t.erasure.absentDays)} days`],
      ['Its countdown', distance],
      ['Seen', `${fmt.format(t.sightings)} times`],
    ];
    const variants = (t.variants || []).slice(0, 8).map((v) => `
      <li><span class="cw-variant-date mono">${escapeHtml(shortDate(v.ts))}</span>
      <span class="cw-variant-text">${escapeHtml(v.text)}</span>
      <span class="cw-variant-strength mono">${escapeHtml(String(v.strength))}</span></li>`).join('');

    return `
    <article class="cw-dossier">
      <header class="cw-dossier-head">
        <span class="cw-cat is-${escapeHtml(t.category)}">${escapeHtml(CATEGORY_LABELS[t.category] || t.category)}</span>
        <span class="cw-dossier-score" title="Withdrawal score, 0 to 100">${escapeHtml(String(t.score))}</span>
      </header>
      <blockquote class="cw-quote">${escapeHtml(t.text)}</blockquote>
      <dl class="cw-facts">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
      </dl>
      ${t.replacedBy ? `<p class="cw-replaced"><span>What replaced it</span>${escapeHtml(t.replacedBy.text)}</p>` : ''}
      ${variants ? `<details class="cw-variants"><summary>Every wording it used (${fmt.format((t.variants || []).length)})</summary><ul>${variants}</ul></details>` : ''}
    </article>`;
  }).join('');
}

function cwRenderDeadlines(report) {
  const buckets = report.deadlineBuckets || [];
  const peak = Math.max(1, ...buckets.map((b) => b.count));
  const emphasis = (label) => /Within 2 years|After its own deadline/.test(label) ? ' is-close' : '';
  el('cwDeadlineChart').innerHTML = buckets.map((b) => `
    <div class="cw-bar-row">
      <span class="cw-bar-label">${escapeHtml(b.label)}</span>
      <div class="cw-bar-track"><div class="cw-bar-fill${emphasis(b.label)}" style="width:${Math.round((b.count / peak) * 100)}%"></div></div>
      <span class="cw-bar-count mono">${fmt.format(b.count)}</span>
    </div>`).join('') +
    `<p class="cw-panel-note">Of ${fmt.format(report.summary.erased)} withdrawn claims, ${fmt.format(buckets.find((b) => /Within 2 years/.test(b.label))?.count || 0)} were dropped inside the last two years of their own countdown.</p>`;
}

function cwRenderSurvival(report) {
  const points = (report.survival || []).filter((p) => p.share !== null);
  if (points.length < 3) {
    el('cwSurvivalChart').innerHTML =
      '<p class="cw-muted">Not enough claims on this record to draw this curve honestly. A survival rate over one or two promises is arithmetic, not evidence.</p>';
    el('cwSurvivalNote').textContent = '';
    return;
  }
  const W = 560, H = 190, PAD_L = 38, PAD_B = 26, PAD_T = 12;
  const maxM = Math.max(...points.map((p) => p.months));
  const x = (m) => PAD_L + (m / Math.max(1, maxM)) * (W - PAD_L - 12);
  const y = (v) => PAD_T + (1 - v) * (H - PAD_T - PAD_B);

  // One path per continuous run: a gap in the evidence is a gap in the line,
  // not a point at zero.
  let path = '', run = [];
  const segs = [];
  for (const p of report.survival) {
    if (p.share === null) { if (run.length) segs.push(run); run = []; continue; }
    run.push(p);
  }
  if (run.length) segs.push(run);
  path = segs.map((seg) => `M ${seg.map((p) => `${x(p.months).toFixed(1)} ${y(p.share).toFixed(1)}`).join(' L ')}`).join(' ');

  const dots = points.map((p) => `<circle cx="${x(p.months).toFixed(1)}" cy="${y(p.share).toFixed(1)}" r="3.2" class="cw-dot">
      <title>${Math.round(p.share * 100)}% of ${p.eligible} promises were still being made ${p.months} months in</title></circle>`).join('');
  const grid = [0, 0.5, 1].map((v) => `<line x1="${PAD_L}" x2="${W - 12}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="cw-grid"/>
      <text x="${PAD_L - 8}" y="${(y(v) + 4).toFixed(1)}" class="cw-axis" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const ticks = [];
  for (let m = 0; m <= maxM; m += 24) ticks.push(`<text x="${x(m).toFixed(1)}" y="${H - 8}" class="cw-axis" text-anchor="middle">${m / 12}y</text>`);

  el('cwSurvivalChart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="cw-svg" role="img" aria-label="Share of promises still being made over time">
      ${grid}${ticks.join('')}
      <path d="${path}" class="cw-line"/>
      ${dots}
    </svg>`;
  const last = points[points.length - 1];
  el('cwSurvivalNote').textContent =
    `Each point counts only the promises first made before that horizon, and is drawn only where at least three were alive to count. ` +
    `At ${Math.round(last.months / 12)} years, ${Math.round(last.share * 100)}% of ${last.eligible} promises were still being made on this page.`;
}

function cwRenderCategories(report) {
  const cats = report.categories || [];
  if (!cats.length) { el('cwCategories').innerHTML = '<p class="cw-muted">No claims were found on this record.</p>'; return; }
  const peak = Math.max(...cats.map((c) => c.total));
  el('cwCategories').innerHTML = cats.map((c) => {
    const w = (n) => `${Math.round((n / peak) * 100)}%`;
    return `
    <div class="cw-cat-row">
      <span class="cw-cat-name">${escapeHtml(c.label)}</span>
      <div class="cw-cat-track">
        <span class="cw-cat-seg is-live" style="width:${w(c.live)}"></span>
        <span class="cw-cat-seg is-softened" style="width:${w(c.softened)}"></span>
        <span class="cw-cat-seg is-erased" style="width:${w(c.erased)}"></span>
      </div>
      <span class="cw-cat-figures mono">${fmt.format(c.total)} · ${fmt.format(c.erased)} withdrawn</span>
    </div>`;
  }).join('') + `
    <p class="cw-legend">
      <span class="cw-legend-key is-live"></span> still said
      <span class="cw-legend-key is-softened"></span> softened
      <span class="cw-legend-key is-erased"></span> withdrawn
    </p>`;
}

function cwRenderCoverage(url, report, snapshotCount) {
  const c = report.coverage;
  const partial = snapshotCount && c.captures < snapshotCount;
  el('cwCoverage').textContent =
    `This report read ${fmt.format(c.captures)} captures on file for ${url}` +
    (c.first ? `, from ${dateOf(c.first)} to ${dateOf(c.last)}. ` : '. ') +
    (partial
      ? `The Archive holds ${fmt.format(snapshotCount)} captures of this address, so the rest have not been read yet. `
      : 'That is the whole record. ') +
    `Its confidence is ${report.summary.confidence || 'low'}, which is a statement about how much record there was to read, not about how honest the site is. ` +
    `Every claim below is one of the sentences this analysis could hold to a date. A page can hold promises this method cannot see, and can drop them without appearing here.`;
}

// ---------------------------------------------------------------- wiring

el('cwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  cwRun(el('cwInput').value);
});

document.querySelectorAll('.example-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    el('cwInput').value = chip.dataset.url;
    cwRun(chip.dataset.url);
  });
});

const initial = new URL(location.href).searchParams.get('url');
if (initial) {
  el('cwInput').value = initial;
  cwRun(initial);
}
