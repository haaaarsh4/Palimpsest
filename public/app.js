// public/app.js
// No framework here on purpose, this is a focused enough UI that vanilla
// DOM code stays readable, and it keeps the whole app to one dependency-free
// static bundle.

const state = {
  url: null,
  snapshots: [],       // [{timestamp, original, date}] ascending by date
  fromIndex: null,
  toIndex: null,
  currentDiff: null,   // { oldHtml, newHtml, changes, counts }
  // Which kinds of change the reader is looking at, as the three counts
  // above the panes read them: 'added', 'removed', 'changed'. Empty means
  // all of them, which is where a comparison opens and where Show all
  // returns to.
  kindFilter: new Set(),
  notesTimer: null,
  subpageComparison: null, // { old, new } archived page addresses, when the
                           // panes were last compared as open subpages
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- URL form
el('urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = el('urlInput').value.trim();
  if (!raw) return;
  await loadSite(raw);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const url = chip.dataset.url;
    el('urlInput').value = url;
    await loadSite(url);
  });
});

// The two links in the top bar carry over whatever address is already typed,
// so the reader never has to enter the same site twice. Their hrefs are kept
// current while they type, not just on the click, so either of them can still
// be opened in a new tab like any other link.
const navCtas = [
  { el: el('claimsCta'), page: '/claims' },
  { el: el('settlementCta'), page: '/settlement' },
].filter((cta) => cta.el);
function syncNavLinks() {
  const typed = el('urlInput').value.trim();
  const query = typed ? `?url=${encodeURIComponent(typed)}` : '';
  for (const cta of navCtas) cta.el.href = cta.page + query;
}
el('urlInput')?.addEventListener('input', syncNavLinks);

async function loadSite(raw, opts = {}) {
  setError(null);
  el('timelineSection').hidden = true;
  el('workspace').hidden = true;
  paneOldNav.reset();
  paneNewNav.reset();
  state.currentDiff = null;

  el('traceBtn').disabled = true;
  el('traceBtnText').textContent = 'Tracing\u2026';
  el('siteLoading').hidden = false;

  // A cold trace can spend a minute against a slow Archive, and a bare
  // spinner for that long reads as stuck. So the row narrates: elapsed
  // seconds always, plus the walk's live page and capture count while the
  // server is still reading the index — the same staged shape as the
  // progress on the other reading pages.
  // The label flexes and ellipsizes on narrow screens while the seconds stay
  // pinned at the row's end, so the count is never the part that gets cut.
  const traceLabel = document.querySelector('#siteLoading .loading-label') ||
    document.querySelector('#siteLoading span');
  const traceEta = document.querySelector('#siteLoading .loading-eta');
  const traceStart = Date.now();
  const setTrace = (label, s) => {
    if (traceEta) {
      traceLabel.textContent = label;
      traceEta.textContent = ` ${s}s`;
    } else {
      traceLabel.textContent = `${label} ${s}s`;
    }
  };
  const traceTimer = setInterval(() => {
    const s = Math.round((Date.now() - traceStart) / 1000);
    setTrace(`Pulling the archive history for this address\u2026`, s);
    fetch(`/api/snapshots-progress?url=${encodeURIComponent(raw)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.progress && d.progress.rows > 0) {
          setTrace(
            `Reading the Archive's index\u2026 page ${d.progress.page} \u00b7 ` +
            `${d.progress.rows.toLocaleString()} captures so far`,
            s
          );
        }
      })
      .catch(() => { /* the trace itself is the answer; this is garnish */ });
  }, 1000);

  try {
    const res = await fetch(`/api/snapshots?url=${encodeURIComponent(raw)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    if (!data.snapshots.length) {
      setError("The Wayback Machine doesn't have any snapshots for that address yet.");
      return;
    }

    state.url = data.url;
    state.snapshots = data.snapshots
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    state.fromIndex = 0;
    state.toIndex = state.snapshots.length - 1;

    el('timelineSiteName').textContent = state.url;
    // The record's real size, and the sampled one when they differ. The rail
    // cannot draw 436,339 points, so the server sends a faithful sample (a day
    // of the recent window, a month before it - see sampleSnapshots in
    // server.js); saying "822 recorded changes" for a record of 436,339 would
    // be a plain lie about the evidence behind every number on this page.
    const sampled = Number(data.total || state.snapshots.length);
    state.recordTotal = sampled;
    const spread = `spanning ${formatDate(state.snapshots[0].date)} to ${formatDate(state.snapshots[state.snapshots.length - 1].date)}`;
    el('timelineMeta').textContent = sampled > state.snapshots.length
      ? `${sampled.toLocaleString()} captures on file, ${spread}; the rail shows ${state.snapshots.length.toLocaleString()} of them`
      : `${sampled === 1 ? '1 capture' : sampled.toLocaleString() + ' captures'} on file, ${spread}`;

    el('timelineSection').hidden = false;
    renderTimeline();

    // The range the reader asked for, if they asked for one. It is applied here
    // rather than before the trace because it can only be resolved against the
    // captures that came back, a year nobody archived is not a range, it is a
    // year with nothing in it.
    const narrowed = applyRangeControls();
    if (narrowed) positionHandles();

    // The address is written into this page's own address, so the comparison is
    // a link: the front page, the nameplates and every trace this app hands out
    // point at it. The range and the layout go in as well, but only when the
    // reader actually chose one, a share link should say what is on screen and
    // nothing else.
    try {
      const share = new URL(location.href);
      share.search = '';
      share.searchParams.set('url', state.url);
      if (el('fromYear') && el('fromYear').value) share.searchParams.set('from', el('fromYear').value);
      if (el('toYear') && el('toYear').value) share.searchParams.set('to', el('toYear').value);
      history.replaceState(null, '', share);
    } catch (_) { /* a history this browser will not write is not a failure */ }

    // Instant when this trace was not the reader's own doing — a comparison
    // link opened cold, or an address carried in the query string. There the
    // page loads at the top and the timeline only exists seconds later, so an
    // animated glide reads as the page loading in the wrong spot and then
    // drifting to its place. A reader who pressed Search gets the smooth ride.
    if (!opts.silentScroll) el('timelineSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // A range narrow enough to be a question gets answered: the two captures are
    // put side by side without waiting to be told again. The whole record does
    // not, because there the reader is choosing where to look first. A caller
    // that is going to build a specific pair itself (a comparison link being
    // opened) says so, so the page does not start one comparison and then
    // throw it away for another.
    if (narrowed && !opts.keepHash) await loadDiff();
  } catch (err) {
    const msg = err.message || 'Could not load that site.';
    // A 502 from our own backend (or a dropped connection to it) is the
    // Archive stumbling mid-walk, not a verdict on the address. The walk's
    // own retries already spent half a minute getting here, so one more
    // attempt after a breath usually lands it instead of stranding the
    // reader on an error they must work around by hand.
    if (!opts.retried && /wayback|try again|timed out|failed to fetch|50[234]|429/i.test(msg)) {
      traceSpan.textContent = 'The Archive stumbled \u2014 trying again\u2026';
      await new Promise((r) => setTimeout(r, 2000));
      clearInterval(traceTimer);
      await loadSite(raw, { ...opts, retried: true });
      return;
    }
    setError(msg);
  } finally {
    clearInterval(traceTimer);
    el('traceBtn').disabled = false;
    // The idle label always matches the markup's own ("Search"): renaming it
    // after every trace changed the button's width and shoved the hero form
    // sideways on every load.
    el('traceBtnText').textContent = 'Search';
    el('siteLoading').hidden = true;
  }
}

function setError(msg) {
  const box = el('urlError');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

// ------------------------------------------------- The range, as asked for
//
// Two year fields, either of which may be left on "Any year". They are the same
// two numbers the timeline's handles carry, stated in the coarse form a person
// arrives with, a decade, a year something happened, so they are resolved into
// the nearest captures the record actually has rather than trusted as indices.
//
// Returns whether the range is narrower than the whole record, which is what
// decides whether the comparison opens by itself.
function applyRangeControls() {
  const fromSel = el('fromYear');
  const toSel = el('toYear');
  if (!fromSel || !toSel || !state.snapshots.length) return false;

  const whole = state.snapshots.length - 1;
  const yearOf = (i) => Number(String(state.snapshots[i].date).slice(0, 4));
  const fromYear = Number(fromSel.value) || 0;
  const toYear = Number(toSel.value) || 0;

  let from = 0;
  let to = whole;
  if (fromYear) {
    const i = state.snapshots.findIndex((s) => Number(String(s.date).slice(0, 4)) >= fromYear);
    from = i < 0 ? whole : i;
  }
  if (toYear) {
    for (let i = whole; i >= 0; i--) {
      if (Number(String(state.snapshots[i].date).slice(0, 4)) <= toYear) { to = i; break; }
    }
    if (yearOf(0) > toYear) to = 0;
  }
  if (to < from) to = from;

  state.fromIndex = from;
  state.toIndex = to;
  return !(from === 0 && to === whole);
}

// ---------------------------------------------------------------- Timeline
function renderTimeline() {
  const track = el('timelineTrack');
  const trackWidth = track.clientWidth || 1000;
  const minTime = new Date(state.snapshots[0].date).getTime();
  const maxTime = new Date(state.snapshots[state.snapshots.length - 1].date).getTime();
  const span = Math.max(1, maxTime - minTime);

  const xFor = (i) => {
    const t = new Date(state.snapshots[i].date).getTime();
    return ((t - minTime) / span) * trackWidth;
  };
  state._xFor = xFor;
  state._trackWidth = trackWidth;

  const tickLayer = el('tickLayer');
  tickLayer.innerHTML = '';
  // One tick per capture would be a div per capture: a big record now runs
  // to hundreds of thousands of snapshots, and that many nodes hangs the
  // tab for a bar where neighbouring ticks already overlap. So the ticks
  // are sampled to roughly the track's own pixel width — what the eye can
  // actually see — while the handles below keep addressing every snapshot
  // by its full index. Each tick remembers which snapshot it stands for.
  const n = state.snapshots.length;
  const maxTicks = Math.max(500, Math.min(4000, Math.floor(trackWidth * 2) || 2000));
  const stride = Math.max(1, Math.ceil(n / maxTicks));
  for (let i = 0; i < n; i += stride) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = xFor(i) + 'px';
    tick.dataset.index = String(i);
    tickLayer.appendChild(tick);
  }

  el('earliestLabel').textContent = formatDate(state.snapshots[0].date);
  el('latestLabel').textContent = formatDate(state.snapshots[state.snapshots.length - 1].date);

  positionHandles();
}

function positionHandles() {
  const xFrom = state._xFor(state.fromIndex);
  const xTo = state._xFor(state.toIndex);
  el('handleFrom').style.left = xFrom + 'px';
  el('handleTo').style.left = xTo + 'px';
  el('rangeFill').style.left = xFrom + 'px';
  el('rangeFill').style.width = Math.max(0, xTo - xFrom) + 'px';

  el('fromDate').value = formatDate(state.snapshots[state.fromIndex].date);
  el('toDate').value = formatDate(state.snapshots[state.toIndex].date);

  // Highlight the ticks currently selected as endpoints. Ticks are sampled
  // (see renderTimeline), so they are matched by the snapshot index they
  // stand for rather than by their position among themselves.
  const ticks = el('tickLayer').children;
  Array.from(ticks).forEach((t) => {
    const idx = Number(t.dataset.index);
    t.classList.toggle('tick-hit', idx === state.fromIndex || idx === state.toIndex);
  });

  const distinct = state.fromIndex !== state.toIndex;
  el('compareBtn').disabled = !distinct;
}

function nearestIndexForClientX(clientX) {
  const track = el('timelineTrack');
  const rect = track.getBoundingClientRect();
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  // Binary search: snapshots run oldest-first, so their positions rise with
  // their indices. A linear scan was fine for two thousand snapshots and is
  // a drag-handler jank for two hundred thousand.
  let lo = 0, hi = state.snapshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state._xFor(mid) < x) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(state._xFor(lo - 1) - x) < Math.abs(state._xFor(lo) - x)) best = lo - 1;
  return best;
}

function makeDraggable(handleEl, which) {
  handleEl.addEventListener('pointerdown', (e) => {
    handleEl.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const idx = nearestIndexForClientX(ev.clientX);
      if (which === 'from') {
        state.fromIndex = Math.min(idx, state.toIndex);
      } else {
        state.toIndex = Math.max(idx, state.fromIndex);
      }
      positionHandles();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
makeDraggable(el('handleFrom'), 'from');
makeDraggable(el('handleTo'), 'to');

// The selection dates take typing: same type as the readout, no chrome. A
// typed date snaps to the nearest capture on the record (clamped so From
// never passes To), and anything that is not a real calendar date flashes
// red and falls back. "50 September" fails the month-length check below,
// so it can never become a selection.
const SEL_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8,
  sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
function parseTypedDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let y, m, d;
  let mt = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s) ||
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s) ||
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) {
    if (/[A-Za-z]/.test(mt[1]) && !/[A-Za-z]/.test(mt[2] || '')) { m = SEL_MONTHS[mt[1].toLowerCase()]; d = Number(mt[2]); y = Number(mt[3]); }
    else if (/[A-Za-z]/.test(mt[2] || '')) { d = Number(mt[1]); m = SEL_MONTHS[String(mt[2]).toLowerCase()]; y = Number(mt[3]); }
    else { y = Number(mt[1]); m = Number(mt[2]) - 1; d = Number(mt[3]); }
  } else if (/^\d{4}$/.test(s)) {
    y = Number(s); m = 0; d = 1;
  } else {
    return null;
  }
  if (!Number.isInteger(y) || m === undefined || !Number.isInteger(d)) return null;
  if (m < 0 || m > 11 || y < 1000 || y > 9999) return null;
  if (d < 1 || d > new Date(y, m + 1, 0).getDate()) return null;
  return new Date(y, m, d).getTime();
}
function nearestSnapshotIndex(t) {
  let best = 0, bestDist = Infinity;
  state.snapshots.forEach((s, i) => {
    const dist = Math.abs(new Date(s.date).getTime() - t);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}
function commitTypedDate(which) {
  const input = which === 'from' ? el('fromDate') : el('toDate');
  const t = parseTypedDate(input.value);
  if (t === null || !state.snapshots.length) {
    input.classList.add('invalid');
    setTimeout(() => input.classList.remove('invalid'), 700);
    if (state.snapshots.length) positionHandles();
    return;
  }
  const idx = nearestSnapshotIndex(t);
  if (which === 'from') state.fromIndex = Math.min(idx, state.toIndex);
  else state.toIndex = Math.max(idx, state.fromIndex);
  positionHandles();
}
['from', 'to'].forEach((which) => {
  const input = which === 'from' ? el('fromDate') : el('toDate');
  input.addEventListener('change', () => commitTypedDate(which));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape' && state.snapshots.length) { positionHandles(); input.blur(); }
  });
});

window.addEventListener('resize', () => {
  if (state.snapshots.length) renderTimeline();
});

// ---------------------------------------------------------------- Compare
el('compareBtn').addEventListener('click', loadDiff);

// A comparison is a thing worth sending to someone: two timestamps of one
// address, and nothing else needed to rebuild it. The address carries them
// (`#url=…&from=…&to=…`) so the browser's own Copy link, and the "Copy
// link" button beside the panes, produce something that reopens exactly
// this comparison, with a fresh read from the Archive.
//
// This is also why a comparison survives a reload. `node --watch` restarts
// the server on every edit, and the old address was a bare `/compare?url=…`,
// which reloaded to a snapshot list and a closed workspace, reading as "my
// comparison was lost" rather than "the page reloaded".
function compareHashFor(url, fromTs, toTs) {
  if (!url || !fromTs || !toTs) return '';
  return `#url=${encodeURIComponent(url)}&from=${fromTs}&to=${toTs}`;
}

// A comparison of two *open pages* (the subpage case) is worth sharing too,
// and is a different thing: two full archived addresses rather than two
// timestamps of one address.
function pagesHashFor(oldPage, newPage) {
  if (!oldPage || !newPage) return '';
  return `#old=${encodeURIComponent(oldPage)}&new=${encodeURIComponent(newPage)}`;
}

// "#…" → what comparison it names, or null. Both shapes are read here so one
// handler can serve the hash, the Copy-link button, and a cold page load.
function parseCompareHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const oldPage = (params.get('old') || '').trim();
  const newPage = (params.get('new') || '').trim();
  if (oldPage && newPage) return { kind: 'pages', oldPage, newPage };
  const url = (params.get('url') || '').trim();
  const from = (params.get('from') || '').trim();
  const to = (params.get('to') || '').trim();
  if (!url || !/^\d{14}$/.test(from) || !/^\d{14}$/.test(to)) return null;
  return { kind: 'snapshots', url, from, to };
}

// The site an archived page address belongs to, in the same shape the server's
// own normalizeInputUrl produces, so a pages link knows which record it is
// about (for the timeline, the notes, and the header).
function archivePageSiteUrl(archiveUrl) {
  try {
    const u = new URL(archiveUrl);
    if (u.hostname.toLowerCase() !== 'web.archive.org') return null;
    const m = /^\/web\/\d{14}[a-z_]*\/(.+)$/i.exec(u.pathname);
    if (!m) return null;
    const inner = new URL(decodeURIComponent(m[1]));
    return (inner.host + inner.pathname).replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

function setHash(next) {
  if (!next || location.hash === next) return;
  try {
    history.replaceState(null, '', next);
  } catch (_) { /* file:// or a locked-down context: the comparison still works */ }
}

function writeCompareHash(url, fromTs, toTs) {
  state.subpageComparison = null;
  setHash(compareHashFor(url, fromTs, toTs));
}

// The comparison itself, rebuilt from two timestamps rather than from the
// timeline's indices, so a shared link needs nothing but the snapshot list
// to put the same two captures side by side.
async function runDiffQuery(rawUrl, fromTs, toTs, opts = {}) {
  // The template is up from the click, not from the answer: both panes, their
  // label bars, their address rows and their own veils are on the page while
  // the archive is being read, so pressing Compare opens a comparison that is
  // loading rather than an empty white box. What waits for the answer is only
  // the content, and the veils are what covers it: nothing of the previous
  // comparison stays on screen under a new date, and nothing of this one is
  // invented before it arrives.
  el('workspace').hidden = false;
  el('loadingDiff').hidden = false;
  el('compareBtn').disabled = true;
  el('compareBtn').textContent = 'Comparing\u2026';
  el('comparePagesBtn').disabled = true;
  resetInsightPanel();
  // Before the fetch: a paint check left over from the previous comparison
  // must not take these fresh veils off an empty pane while the new pair is
  // still being read.
  invalidatePaneReveals();
  showPaneLoading('paneOldLoading');
  showPaneLoading('paneNewLoading');
  beginChangeLoading(fromTs, toTs, opts);

  try {
    const res = await fetch(
      `/api/diff?url=${encodeURIComponent(rawUrl)}&from=${fromTs}&to=${toTs}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not build that comparison.');

    const from = { timestamp: fromTs, date: opts.fromDate || timestampToIso(fromTs) };
    const to = { timestamp: toTs, date: opts.toDate || timestampToIso(toTs) };
    state.currentDiff = data;
    el('paneOldDate').textContent = formatDate(from.date);
    el('paneNewDate').textContent = formatDate(to.date);
    // The address each home snapshot was read at, in the same canonical
    // shape the pipeline itself uses, so the address bars agree with how
    // every link in the page resolves.
    paneOldNav.setHome(data.oldHtml, `https://web.archive.org/web/${fromTs}/${state.url}`);
    paneNewNav.setHome(data.newHtml, `https://web.archive.org/web/${toTs}/${state.url}`);

    renderChangeCounts(data.counts);
    renderChangesList(data.changes);
    loadNotes();
    writeCompareHash(state.url, fromTs, toTs);
    // Remember the trace this comparison came from: the home button's
    // second level returns here after COMPARE OPEN PAGES re-homes the
    // panes onto subpages. Stored only on success, beside the hash that
    // names the same pair.
    state.timelineQuery = { url: state.url, fromTs, toTs };
    el('copyLinkBtn').disabled = false;

    if (!opts.silentScroll) el('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setError(err.message);
    hidePaneLoading('paneOldLoading');
    hidePaneLoading('paneNewLoading');
    restoreRunBeforeState();
  } finally {
    el('loadingDiff').hidden = true;
    el('loadingChanges').hidden = true;
    el('compareBtn').disabled = false;
    el('compareBtn').textContent = 'Compare snapshots';
    updateSubpageCompare();
  }
}

// Timestamps arrive as YYYYMMDDhhmmss, which is a date this app can format
// without asking the Archive anything (used when a comparison is rebuilt
// from a shared link, where no snapshot list has been read yet).
function timestampToIso(ts) {
  const s = String(ts || '');
  if (!/^\d{14}$/.test(s)) return new Date().toISOString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
}

// The timeline's Compare button: two indices in the snapshot list, which is
// what dragging the handles produces.
async function loadDiff() {
  const from = state.snapshots[state.fromIndex];
  const to = state.snapshots[state.toIndex];
  if (!from || !to) return;
  await runDiffQuery(state.url, from.timestamp, to.timestamp, { fromDate: from.date, toDate: to.date });
}

// A comparison address, opened cold: read the snapshot list (which is what
// turns a bare address into a record of captures) and then build exactly the
// pair the address names, scrolling to the timeline so the handles agree.
async function applyCompareHash(route, opts = {}) {
  if (!route) return;
  if (state.url !== route.url || !state.snapshots.length) {
    await loadSite(route.url, { keepHash: true, silentScroll: opts.silentScroll });
    if (state.url !== route.url) return; // the address did not resolve
  }
  const iFrom = state.snapshots.findIndex((s) => s.timestamp === route.from);
  const iTo = state.snapshots.findIndex((s) => s.timestamp === route.to);
  if (iFrom < 0 || iTo < 0) {
    setError('That comparison link names captures that are not on this record any more.');
    return;
  }
  state.fromIndex = iFrom;
  state.toIndex = iTo;
  renderTimeline();
  if (!opts.keepHash) writeCompareHash(state.url, route.from, route.to);
  await runDiffQuery(route.url, route.from, route.to, { silentScroll: opts.silentScroll });
}

window.addEventListener('hashchange', () => {
  const route = parseCompareHash(location.hash);
  if (!route) return;
  if (route.kind === 'pages') {
    const showing = state.subpageComparison;
    if (showing && showing.old === route.oldPage && showing.new === route.newPage) return;
    applyPagesRoute(route, { silentScroll: true });
    return;
  }
  // Already showing exactly this pair: nothing to rebuild.
  const from = state.snapshots[state.fromIndex];
  const to = state.snapshots[state.toIndex];
  if (from && to && from.timestamp === route.from && to.timestamp === route.to && state.url === route.url) return;
  applyCompareHash(route, { silentScroll: true });
});

// A comparison-of-pages link, opened or arrived at: read the record for the
// site the older page belongs to (so the timeline and notes agree), then
// rebuild the pair itself.
async function applyPagesRoute(route, opts = {}) {
  const site = archivePageSiteUrl(route.oldPage) || archivePageSiteUrl(route.newPage);
  if (!site) {
    setError('That link does not name two archived pages this can compare.');
    return;
  }
  if (state.url !== site || !state.snapshots.length) {
    await loadSite(site, { keepHash: true, silentScroll: opts.silentScroll });
    if (state.url !== site) return;
  }
  await diffOpenPages(route.oldPage, route.newPage, opts);
}

function showPaneLoading(id) { el(id).classList.remove('hidden'); }
function hidePaneLoading(id) { el(id).classList.add('hidden'); }

// Which render a pane's veil belongs to. Every render (and every new
// comparison request, before the first render lands) bumps the counter; a
// paint check started for an older document may finish later, and it must not
// take the veil off the newer one. This is the blank-screen bug: the initial
// about:blank frame's check ran out its timeout while a cold /api/diff was
// still fetching, hid the veil over two white frames, and the captures only
// arrived seconds later.
function paneRevealSeq(iframe) {
  return (iframe && iframe.__pdiffRevealSeq) || 0;
}
function bumpPaneReveal(iframe) {
  if (!iframe) return 0;
  const next = paneRevealSeq(iframe) + 1;
  try { iframe.__pdiffRevealSeq = next; } catch (_) { return next; }
  return next;
}
function invalidatePaneReveals() {
  ['paneOld', 'paneNew', 'modalFrame'].forEach((id) => {
    try {
      const iframe = el(id);
      if (!iframe) return;
      bumpPaneReveal(iframe);
      // Nothing may take this pane's veil off until the next render has
      // actually written a document into it. A check that started on the
      // blank placeholder (or on the previous comparison) answers a question
      // nobody is asking any more.
      iframe.__pdiffVeilArmed = false;
    } catch (_) { /* pane not on this page */ }
  });
}
function armPaneReveal(iframe) {
  if (!iframe) return;
  try { iframe.__pdiffVeilArmed = true; } catch (_) { /* read-only frame */ }
}

// A pane is shown finished, never assembling.
//
// The snapshot arrives as markup whose pictures, fonts and stylesheets come
// from the archive's cache one at a time, and a page caught in the middle of
// that is what \"nothing renders properly\" looks like: empty tiles, text in
// the wrong font, a header drawn before its bar. So the veil stays up until
// the document is parsed, its stylesheets are applied, its fonts are resolved,
// and every picture on screen has either drawn or given up - not until the
// parse ends, which is when the old gate opened.
//
// The budget is the other half of the promise: one picture the Archive has
// lost must not hold a fifty-picture page hostage, so after the budget the
// pane appears with whatever is there and the reader is never left staring at
// a spinner that will not end.
const PANE_SETTLE_MS = 9000;
// How long the first paint may wait for every picture and font before it
// shows the page anyway. A capture that is styled and laid out is readable;
// a tile still arriving can fill in under the reader instead of holding a
// spinner over the whole snapshot.
const PANE_FIRST_PAINT_MS = 2500;

// A picture the browser gave up on gets one more ask before the pane is shown.
// The Archive answers a cold file slowly (the server retries too, see
// lib/assetCache.js), and almost every broken picture is that: a request that
// timed out once, on a page where every other file came through. The number is
// the whole grace period rather than per picture, so a page whose nine pictures
// all died does not wait nine times as long as a page with one.
const PANE_REPAIR_MS = 4500;
const PANE_RETRY_DELAY_MS = 700;

function paneInViewport(node, win) {
  try {
    const r = node.getBoundingClientRect();
    const vh = win.innerHeight || 0;
    const vw = win.innerWidth || 0;
    return r.bottom > -200 && r.top < vh + 200 && r.right > 0 && r.left < vw;
  } catch (_) {
    return true;
  }
}

// Is this frame showing a real page yet?
//
// A frame that has not been handed its capture is about:blank, and that
// placeholder fires a load event of its own. Treating it as painted took the
// veil off an empty box seconds before the capture was written into it (seen
// at 1.1s on apple.com, veil already gone, the page arriving afterwards), which
// is exactly the "it renders half assembled" the veil exists to prevent. A
// document is usable only once it has a body with something in it.
function paneDocumentUsable(doc) {
  try {
    if (!doc || !doc.documentElement) return false;
    if (doc.readyState === 'loading') return false;
    return !!(doc.body && doc.body.children.length);
  } catch (_) {
    return false;
  }
}

// The picture the page could not draw: a broken glyph with the alt text
// spilled across the design (an iPhone tile's description printed over the
// section title). One more attempt first; anything still undrawable after
// that is left as a quiet blank box of exactly its own size, so the layout is
// the capture's and nothing is printed where the picture belongs.
function retryPictureUrl(src) {
  const value = String(src || '').trim();
  if (!value || /^(data|blob|about):/i.test(value)) return '';
  return value + (value.indexOf('?') === -1 ? '?' : '&') + 'palimpsest-retry=1';
}

function hideUndrawablePicture(img) {
  try {
    img.setAttribute('data-pdiff-unavailable', 'true');
    img.style.setProperty('visibility', 'hidden', 'important');
  } catch (_) {
    // a picture that cannot be marked is still just a missing picture
  }
}

// Resolves once every picture in the document has either drawn or been given
// up on: pending ones are left to the caller's poll, broken ones are retried
// once and then silenced.
function settleBrokenPictures(doc, win) {
  const broken = [];
  try {
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete || img.naturalWidth > 0) return;
      if (img.getAttribute('data-pdiff-unavailable')) return;
      if (img.getAttribute('data-pdiff-retried')) { hideUndrawablePicture(img); return; }
      broken.push(img);
    });
  } catch (_) {
    return Promise.resolve();
  }
  if (!broken.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = broken.length;
    let finished = false;
    const finishAll = () => { if (finished) return; finished = true; resolve(); };
    const done = () => { left -= 1; if (left <= 0) finishAll(); };
    const timer = setTimeout(() => {
      broken.forEach((img) => { if (!img.naturalWidth) hideUndrawablePicture(img); });
      finishAll();
    }, PANE_REPAIR_MS);
    broken.forEach((img) => {
      const retry = retryPictureUrl(img.getAttribute('src') || '');
      if (!retry) { hideUndrawablePicture(img); done(); return; }
      img.setAttribute('data-pdiff-retried', 'true');
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        try {
          if (img.naturalWidth > 0) img.removeAttribute('data-pdiff-unavailable');
          else hideUndrawablePicture(img);
        } catch (_) { /* the picture is what it is */ }
        done();
      };
      try {
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
      } catch (_) { settle(); return; }
      setTimeout(() => {
        try { img.setAttribute('src', retry); } catch (_) { settle(); }
      }, PANE_RETRY_DELAY_MS);
    });
    void win;
    void timer;
  });
}

// The pictures that are not <img> at all. An archived front page paints its
// hero with `background-image`, and a hero that has not arrived is a blank band
// under the headline: the "the image is not rendering" a reader sees. Only what
// is inside the pane's viewport is waited for, because that is what is on
// screen; the rest is a file read long before it is scrolled to.
function paneBackgroundUrls(doc, win) {
  const urls = new Set();
  try {
    const nodes = doc.querySelectorAll('body *');
    let guard = 0;
    for (const node of nodes) {
      if (guard++ > 6000) break;
      if (win && !paneInViewport(node, win)) continue;
      let bg = '';
      try { bg = win.getComputedStyle(node).backgroundImage || ''; } catch (_) { continue; }
      if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
      const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
      let hit = null;
      while ((hit = re.exec(bg)) !== null) {
        const url = hit[1];
        if (url && !/^(data|blob|about):/i.test(url)) urls.add(url);
      }
    }
  } catch (_) {
    // an unreadable page has no backgrounds to wait for
  }
  return Array.from(urls).slice(0, 60);
}

function preloadPaneBackgrounds(doc, win, budgetMs) {
  const urls = paneBackgroundUrls(doc, win);
  if (!urls.length || !win) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = urls.length;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; resolve(true); };
    const timer = setTimeout(finish, Math.max(400, budgetMs));
    urls.forEach((url) => {
      let probe = null;
      try { probe = new win.Image(); } catch (_) { probe = null; }
      if (!probe) { left -= 1; if (left <= 0) finish(); return; }
      const one = () => { clearTimeout(timer); left -= 1; if (left <= 0) finish(); };
      probe.addEventListener('load', one, { once: true });
      probe.addEventListener('error', one, { once: true });
      probe.src = url;
    });
  });
}

function panePainted(iframe) {
  return new Promise((resolve) => {
    const started = Date.now();
    let repairing = false;
    const expired = () => Date.now() - started > PANE_SETTLE_MS;
    const look = () => {
      let doc = null;
      let win = null;
      try {
        doc = iframe.contentDocument;
        win = iframe.contentWindow;
      } catch (_) { doc = null; }
      if (!paneDocumentUsable(doc)) {
        if (expired()) return resolve(false);
        return setTimeout(look, 80);
      }
      // A stylesheet is applied once the browser exposes its rules. Until
      // then the page is drawn unstyled, which reads as the wrong typeface and
      // a broken layout rather than as a page still loading.
      let styled = true;
      try {
        doc.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
          if (!link.disabled && !link.sheet) styled = false;
        });
      } catch (_) { styled = true; }
      // Every picture the page names, not only the ones in the viewport: a pane
      // that scrolls to a change two screens down must not arrive at an empty
      // tile. The assets are already in this app's cache (see the server's
      // prepareAssets), so this is a file read, not an Archive round trip.
      let drawn = true;
      try {
        doc.querySelectorAll('img').forEach((img) => {
          if (!img.complete) drawn = false;
        });
      } catch (_) { drawn = true; }
      let fonts = true;
      try { if (doc.fonts && doc.fonts.status === 'loading') fonts = false; } catch (_) { fonts = true; }
      // Stylesheets are the one hard requirement: showing a capture before
      // its CSS lands is showing the wrong page. Pictures and fonts get a
      // short grace, then the page is shown with whatever has arrived - a
      // styled, laid-out capture beats a spinner over it, and late files fill
      // in underneath. A document with no body at all still keeps the veil
      // (see above): there is genuinely nothing to show.
      const graceOver = Date.now() - started > PANE_FIRST_PAINT_MS;
      if (!styled || ((!drawn || !fonts) && !graceOver)) {
        if (expired()) return resolve(true);
        return setTimeout(look, 90);
      }
      if (repairing) {
        if (expired()) return resolve(true);
        return setTimeout(look, 120);
      }
      // The page is ready to be seen. Repairs finish in the background: a
      // broken picture is silenced now (so its alt text does not spill over
      // the layout) and retried after the veil is gone, and backgrounds are
      // warmed for the scroll rather than gating the first paint. Waiting on
      // either was the spinner sitting over a finished page for seconds.
      repairing = true;
      const budget = Math.max(600, Math.min(PANE_REPAIR_MS, PANE_SETTLE_MS - (Date.now() - started)));
      try {
        doc.querySelectorAll('img').forEach((img) => {
          if (img.complete && !img.naturalWidth) hideUndrawablePicture(img);
        });
      } catch (_) { /* the layout is still ready */ }
      Promise.resolve()
        .then(() => settleBrokenPictures(doc, win))
        .catch(() => { /* one unrepaired picture never blocks the pane */ });
      Promise.resolve()
        .then(() => preloadPaneBackgrounds(doc, win, budget))
        .catch(() => { /* warming is best effort */ });
      resolve(true);
    };
    look();
  });
}

// Called both when the frame's document is parseable and when it finally
// finishes loading; whichever comes first, the veil only comes down when the
// page is painted. Repeated calls are harmless: hiding a hidden veil is a
// no-op and every call settles on the same document.
function revealPaneWhenPainted(iframe) {
  if (!iframe) return;
  const seq = paneRevealSeq(iframe);
  panePainted(iframe).then((painted) => {
    // No document ever became usable: keep the veil (a render's own 60s
    // backstop still releases it if the capture is truly broken).
    if (painted === false) return;
    // A comparison is still being fetched, or the document this check was
    // made for is gone. Neither result says anything about the pane on screen.
    if (iframe.__pdiffVeilArmed === false) return;
    if (paneRevealSeq(iframe) !== seq) return;
    const hide = () => {
      try {
        if (iframe.__pdiffVeilArmed !== false && paneRevealSeq(iframe) === seq) {
          hidePaneLoading(`${iframe.id}Loading`);
        }
      } catch (_) { /* pane gone */ }
    };
    // Two frames, not zero: hiding the veil and painting the capture are two
    // different jobs, and the veil must not be the thing that paints first.
    // The timer is the backstop for a background tab that gets no frames.
    let done = false;
    const once = () => { if (done) return; done = true; hide(); };
    try { requestAnimationFrame(() => requestAnimationFrame(once)); } catch (_) { once(); }
    setTimeout(once, 350);
  });
}

// The iframe's own load event fires once the archived HTML, its CSS, and
// its images have actually painted, which is the honest signal to hide the
// per-pane spinner (srcdoc assignment itself is instant, but fetching the
// original site's stylesheet and images from web.archive.org takes a beat).
el('paneOld').addEventListener('load', () => { revealPaneWhenPainted(el('paneOld')); clearPaneBadges(el('paneOld')); hydrateBlockedStylesheets(el('paneOld')); warmPaneBackgrounds(el('paneOld')); wirePaneReverseClick(el('paneOld')); syncKindFocus(el('paneOld')); });
el('paneNew').addEventListener('load', () => { revealPaneWhenPainted(el('paneNew')); clearPaneBadges(el('paneNew')); hydrateBlockedStylesheets(el('paneNew')); warmPaneBackgrounds(el('paneNew')); wirePaneReverseClick(el('paneNew')); syncKindFocus(el('paneNew')); });
// The fullscreen pane renders the same home HTML, so it gets the same
// reverse-click behavior (links follow, outlines select-and-scroll), and the
// same switch state: every document a pane paints is a new document, so the
// focused kinds are re-stated on each load rather than set once.
el('modalFrame').addEventListener('load', () => { revealPaneWhenPainted(el('modalFrame')); clearPaneBadges(el('modalFrame')); hydrateBlockedStylesheets(el('modalFrame')); warmPaneBackgrounds(el('modalFrame')); wirePaneReverseClick(el('modalFrame')); syncKindFocus(el('modalFrame')); });

// Clicks inside either pane, wired per document (flagged on the document
// itself) because every navigation, including the panes' back/forward
// wandering onto real archive pages, replaces the document. The rule is:
// a click directly on a link follows it like a browser, immediately, even
// when the link wears a change outline, the outline never swallows the
// click. Only clicks landing on non-link marked content select the change
// and scroll the sidebar, leaving the pane where it is. The toolbar's
// reset still takes the pane home.
// Which snapshot side a pane click belongs to. Leaf ids restart at zero in
// every document, so an id is only meaningful against its own side's end
// of each change (see PdiffSelection.paneChangeIndex). The fullscreen
// modal replays one side's document, so it carries that side along.
function paneSideOf(iframe) {
  try {
    if (iframe.id === 'paneOld') return 'old';
    if (iframe.id === 'paneNew') return 'new';
    if (iframe.id === 'modalFrame') return iframe.dataset && iframe.dataset.pdiffSide === 'old' ? 'old' : 'new';
  } catch (_) { /* fall through */ }
  return null;
}

// Slides a revived carousel to the month a fragment link names (see
// PdiffSelection.slideCarouselTo, which holds the arithmetic and is tested
// without a browser). Kept as a one-line call so a missing helper file, the
// same way showTargetFor is guarded, just leaves the page's own jump alone.
function shiftRevivedCarousel(doc, hash) {
  try {
    if (typeof PdiffSelection !== 'undefined' && PdiffSelection.slideCarouselTo) {
      return !!PdiffSelection.slideCarouselTo(doc, hash);
    }
  } catch (_) { /* fall through: no band moved */ }
  return false;
}

// The same change card the sidebar shows on hover, for the snapshot itself.
// The panes are full of outlined changes with no way to ask what one is: the
// card answers that, with the same words, the same before/after pair and the
// same notes, because it is the same builder (showChangeTooltip).
//
// The card is positioned in the host page, so the element's box inside the
// frame is translated into the host's viewport by the frame's own offset. The
// two are different coordinate systems even though the pane looks like part
// of the page.
let paneHoverTimer = null;
let paneHoverKey = '';

function paneAnchor(iframe, node) {
  const frame = iframe.getBoundingClientRect();
  return {
    getBoundingClientRect() {
      const r = node.getBoundingClientRect();
      return {
        left: frame.left + r.left,
        top: frame.top + r.top,
        right: frame.left + r.right,
        bottom: frame.top + r.bottom,
        width: r.width,
        height: r.height,
      };
    },
  };
}

function paneHoverOver(iframe, target) {
  let marked = null;
  try {
    marked = target && target.closest
      ? target.closest('[data-pdiff-added], [data-pdiff-changed], [data-pdiff-removed]')
      : null;
  } catch (_) {
    marked = null;
  }
  if (!marked) {
    if (paneHoverTimer) { clearTimeout(paneHoverTimer); paneHoverTimer = null; }
    paneHoverKey = '';
    scheduleTooltipHide();
    return;
  }
  const side = paneSideOf(iframe);
  const id = marked.getAttribute('data-pdiff-id');
  const changes = (state.currentDiff && state.currentDiff.changes) || [];
  const idx = (typeof PdiffSelection !== 'undefined' && PdiffSelection.paneChangeIndex)
    ? PdiffSelection.paneChangeIndex(changes, id, side)
    : changes.findIndex((c) => c.oldId === id || c.newId === id);
  if (idx < 0) return;
  const key = `${side || ''}:${id}`;
  // Moving around inside one outlined element keeps the card that is already
  // up; only a different change restarts the wait.
  if (key === paneHoverKey && !el('changeDetailTooltip').hidden) {
    cancelTooltipHide();
    return;
  }
  paneHoverKey = key;
  cancelTooltipHide();
  if (paneHoverTimer) clearTimeout(paneHoverTimer);
  const c = changes[idx];
  // A short wait, so sweeping the pointer across a page of outlines does not
  // strobe cards; the sidebar can be instant because a row is a destination.
  paneHoverTimer = setTimeout(() => {
    paneHoverTimer = null;
    try { showChangeTooltip(c, paneAnchor(iframe, marked)); } catch (_) { /* pane still works */ }
  }, 240);
}

function wirePaneReverseClick(iframe) {
  let doc = null;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return;
  }
  if (!doc || doc.__pdiffReverseWired) return;
  doc.__pdiffReverseWired = true;
  doc.addEventListener('mouseover', (e) => { try { paneHoverOver(iframe, e.target); } catch (_) { /* hover is optional */ } });
  // Leaving the frame, or scrolling its page, takes the card away: it is
  // pinned to a box that has just moved or vanished.
  doc.addEventListener('mouseleave', () => { if (paneHoverTimer) { clearTimeout(paneHoverTimer); paneHoverTimer = null; } paneHoverKey = ''; scheduleTooltipHide(); });
  doc.addEventListener('scroll', () => scheduleTooltipHide(), true);
  doc.addEventListener('click', (e) => {
    scheduleTooltipHide();
    // New-tab gestures always pass through untouched.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    let link = null;
    let marked = null;
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      link = t.closest('a[href], area[href]');
      marked = t.closest('[data-pdiff-removed], [data-pdiff-added], [data-pdiff-changed]');
    } catch (_) {
      return;
    }
    // A click on the outline frame itself selects the change instead of
    // following the link: the ring is drawn inside the element's box, so
    // frame clicks hit the link and would otherwise always navigate.
    // This runs before any navigation decision on purpose, so new-tab
    // links (target="_blank", named windows, _top/_parent, or a base
    // target) behave exactly like plain ones: the frame selects, the
    // content navigates in-pane. The panes run sandboxed without popups,
    // so letting a new-tab link take its native path would die silently;
    // every navigable target below is preventDefaulted and routed through
    // the pane controller instead, which is what keeps it in the same tab.
    let edgeSelect = false;
    try {
      const markedLink = link ? link.closest('[data-pdiff-removed],[data-pdiff-added],[data-pdiff-changed]') : null;
      if (markedLink === link && typeof PdiffSelection !== 'undefined') {
        edgeSelect = PdiffSelection.isEdgeClick(link.getClientRects(), e.clientX, e.clientY, 6);
      }
    } catch (_) {
      edgeSelect = false;
    }
    if (link && typeof PdiffNav !== 'undefined' && PdiffNav.isNavigableUrl(link.href)) {
      // A click directly on a link goes to the page, immediately, like a
      // browser. The outline around the link never swallows the click: only
      // clicks landing on non-link marked content, or on the frame itself,
      // select the change.
      let samePageFrag = false;
      try {
        const docUrl = iframe.contentDocument ? iframe.contentDocument.URL : '';
        samePageFrag = !!link.hash && docUrl.split('#')[0] === link.href.split('#')[0];
      } catch (_) {
        samePageFrag = false;
      }
      // Read off the attribute, not the resolved address: in a srcdoc pane
      // the document is `about:srcdoc` and a bare `#Sep` resolves into the
      // archive's full URL, so the comparison above never matched and the
      // pane followed the fragment out to a fresh capture (see
      // PdiffNav.isSamePageFragment).
      let rawHref = '';
      try { rawHref = link.getAttribute('href') || ''; } catch (_) { rawHref = ''; }
      const hashOnly = !!(typeof PdiffNav !== 'undefined' && PdiffNav.isSamePageFragment && PdiffNav.isSamePageFragment(rawHref));
      if (hashOnly) {
        // A month strip under a carousel: slide the band, stay on the page.
        const name = (PdiffNav.fragmentName && PdiffNav.fragmentName(rawHref)) || '';
        let moved = false;
        try { moved = shiftRevivedCarousel(doc, name); } catch (_) { moved = false; }
        if (moved) {
          // Paging the band is the page's own interaction, not a change
          // being selected: the sidebar and its light are left alone.
          e.preventDefault();
          return;
        }
        // Any other fragment names a spot on this page: the browser's own
        // jump is right, and following it as a link would reload the pane.
        return;
      }        if (samePageFrag) return; // in-page anchor: native scroll, no reload
      if (!edgeSelect) {
        e.preventDefault();
        selectRowForMarked(marked, paneSideOf(iframe)); // the sidebar tracks what was followed
        const ctl = paneControllers[iframe.id];
        if (ctl) ctl.navigate(link.href);
        else {
          try { iframe.contentWindow.location.href = link.href; } catch (_) { /* unreachable */ }
        }
        return;
      }
    }
    if (!marked) return;
    if (link && !edgeSelect) return; // mailto: and other non-page links: leave to the browser
    // The outline itself (or any non-link content inside it): select the
    // change and scroll the sidebar to it. The pane stays put.
    e.preventDefault();
    const id = marked.getAttribute('data-pdiff-id');
    const changes = (state.currentDiff && state.currentDiff.changes) || [];
    const side = paneSideOf(iframe);
    // Side-aware on purpose: ids restart per document, so an either-end
    // match from the wrong pane lights up an unrelated change that happens
    // to share the number (a removed link for an image click). No match
    // here means the click hit unmarked content, never a reason to guess.
    const idx = (typeof PdiffSelection !== 'undefined' && PdiffSelection.paneChangeIndex)
      ? PdiffSelection.paneChangeIndex(changes, id, side)
      : changes.findIndex((c) => c.oldId === id || c.newId === id);
    if (idx < 0) return;
    // Reaching for a change the switches had hidden brings the filter back to
    // the whole record, so the row this click selects is on screen.
    const clicked = changes[idx];
    if (clicked && state.kindFilter.size && !state.kindFilter.has(clicked.type)) clearChangeKindFilter();
    const row = el('changesList').children[idx];
    clearSelection();
    if (marked.ownerDocument === iframe.contentDocument) {
      if (iframe.id === 'paneOld') selectedOldTarget = marked;
      else selectedNewTarget = marked;
      highlightInPane(marked);
    }
    // The same element on the other side lights up too: a changed pair is
    // two ends of one change, and lighting only the clicked end reads as
    // if the other snapshot had nothing to show. The row-click helper does
    // the finding (visible twin and all); the other pane scrolls but is
    // never navigated away by this.
    try {
      const c = changes[idx];
      const otherSide = side === 'old' ? 'new' : 'old';
      // The modal replays one side with no counterpart pane: lighting the
      // clicked end is the whole selection there.
      const otherIframe = (iframe.id === 'paneOld' || iframe.id === 'paneNew')
        ? document.getElementById(iframe.id === 'paneOld' ? 'paneNew' : 'paneOld')
        : null;
      if (c && otherIframe) {
        // A pane the reader collapsed stays collapsed: lighting the
        // clicked end is the whole selection there.
        const collapsed = collapsedPanes();
        const otherHidden = (otherSide === 'old' && collapsed.hideOld) ||
          (otherSide === 'new' && collapsed.hideNew);
        if (!otherHidden) {
          const t = selectInPane(otherIframe, c, otherSide);
          if (t) {
            if (otherSide === 'new') selectedNewTarget = t;
            else selectedOldTarget = t;
          }
        }
      }
    } catch (_) { /* clicked side already lit; the other keeps its state */ }
    if (row) {
      selectedRowEl = row;
      row.classList.add('selected');
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

// Now that archived pages render with their real links intact, clicking one
// navigates the iframe away to an actual page on web.archive.org, same as
// clicking a link anywhere. This controller gives each pane a tiny
// browser-style toolbar for that: back, forward, refresh, and home.
//
// These used to drive the iframe's own history directly
// (`contentWindow.history.back()`), which reads well and fails silently:
// reading `.history` off a cross-origin window throws a SecurityError, and
// the pane is cross-origin exactly when the toolbar matters, after
// following a link out to a real archive page. So every toolbar click died
// in a swallowed exception, and the buttons only ever worked while there
// was nowhere to go back to.
//
// Instead the parent keeps the history (see public/paneNav.js): entries are
// the diffed comparison itself ({ home: true }) or a followed archive URL.
// Every action only ever *writes* to the iframe (srcdoc/src attributes),
// which no origin check forbids, and never reads from it, which is what
// used to throw. Refresh re-applies whatever the stack says is showing  
// a true reload of the current page, not a jump home.
// srcdoc documents are their own separate browsing context, CSS on the
// <iframe> element from the host page (e.g. `.pane-frame { overflow-x:
// hidden }`) has zero effect on scrollbars *inside* that document. If the
// archived page has anything wider than the pane (an old fixed-width
// table, a missing box-sizing reset, a banner, etc.) the inner document
// becomes horizontally scrollable regardless of our outer CSS, which is
// why you can drag a scrollbar into what looks like empty space. The only
// reliable fix is to make the rule live *inside* that document, so we
// inject a tiny style block into the HTML before it ever becomes srcdoc.
// The pane is narrower than the page it holds, and every archived layout
// wider than about 500px therefore runs past its right edge. That edge used
// to be a wall: `overflow-x: hidden` on the root threw the rest of the page
// away, so a change sitting at x=620 in a 514-wide pane could not be seen or
// scrolled to - the row scrolled vertically to the right height and lit
// something permanently out of reach (measured on nytimes.com's 2015 front
// page: three sampled rows, all of them past the right edge). Nothing is
// clipped here now, so the content keeps its own width and the pane can be
// scrolled sideways to it; scrollInnerCentered aims both axes.
//
// `overflow-x: auto` was tried on the roots and is worse: it moves the
// sideways scroll onto <body>, which then takes the overflow away from the
// window, and the pane's own scroll commands (which drive the window) move
// nothing horizontally. Left alone, a page that is wide scrolls the window
// and one that fits shows no bar at all.
function injectScrollFix(html) {
  if (!html) return html;
  const fixStyle =
    '<style>' +
    'img,video,table,iframe,pre{max-width:100%;}' +
    '</style>';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + fixStyle);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + fixStyle);
  }
  return fixStyle + html;
}

const paneControllers = {}; // iframe id -> controller, for the pane click handler below

function createPaneNavController(iframeId, toolbarId) {
  const iframe = el(iframeId);
  const toolbar = el(toolbarId);
  const stack = PdiffNav.createStack();
  let homeHtml = '';
  const btnBack = toolbar.querySelector('[data-action="back"]');
  const btnForward = toolbar.querySelector('[data-action="forward"]');
  const btnRefresh = toolbar.querySelector('[data-action="refresh"]');
  const btnReset = toolbar.querySelector('[data-action="reset"]');

  // srcdoc wins over src while both attributes are present, so each render
  // sets exactly one of them and removes the other; refresh additionally
  // drops the attribute first so the re-assignment is always a real
  // navigation rather than a same-value no-op.
  //
  // Every render shows the pane's loading veil first. A followed archive
  // link can take the better part of a minute (cold capture, redirect
  // chain to another timestamp), and without the veil the click's only
  // visible effect is the sidebar scrolling to the row, which reads as
  // "clicking the link just scrolls the list" when the article is still
  // on its way. The veil hides on the iframe's load event as before; the
  // timeout is only a backstop for a load that never settles.
  // Second level of the home button. COMPARE OPEN PAGES re-homes the panes
  // onto the subpages, which strands the trace that started everything:
  // pressing home then correctly returns to the subpage comparison, and
  // reads as "the button does nothing" to anyone expecting settlement.org.
  // So when the pane is already home on a subpage comparison, home goes
  // one level further up: it re-runs the timeline comparison the trace
  // started from. Returns true when it took the click. The fullscreen
  // modal is exempt, re-running the trace from inside it would yank the
  // comparison out from under the modal.
  function returnToTimelineIfHome() {
    try {
      if (iframeId === 'modalFrame') return false;
      if (typeof state === 'undefined' || typeof runDiffQuery !== 'function') return false;
      const cur = stack.current();
      if (cur && !cur.home) return false;
      if (!state.subpageComparison || !state.timelineQuery || !state.timelineQuery.url) return false;
      const tq = state.timelineQuery;
      runDiffQuery(tq.url, tq.fromTs, tq.toTs);
      return true;
    } catch (_) {
      return false; // fall through to the plain return-to-home below
    }
  }

  // Prepared pages, cached per address for this controller's lifetime: back,
  // forward and refresh re-render from here without another fetch. Only the
  // latest requested page may paint (navSeq), so a slow cold fetch can never
  // overwrite a newer navigation. Declared before render() uses them.
  const preparedCache = new Map(); // url -> srcdoc html
  let navSeq = 0;
  let veilTimer = null;
  function render(entry, force) {
    if (!entry) return;
    // A new document is about to be written. Any paint check still running
    // for the previous one is now answering an obsolete question.
    const mySeq = bumpPaneReveal(iframe);
    armPaneReveal(iframe);
    try {
      const veil = document.getElementById(`${iframeId}Loading`);
      if (veil) veil.classList.remove('hidden');
      if (veilTimer) clearTimeout(veilTimer);
      veilTimer = setTimeout(() => {
        try {
          if (paneRevealSeq(iframe) !== mySeq) return;
          const v = document.getElementById(`${iframeId}Loading`);
          if (v) v.classList.add('hidden');
        } catch (_) { /* gone */ }
      }, 60000);
    } catch (_) { /* headless/test: no DOM */ }
    if (entry.home) {
      navSeq++; // a pending followed-page fetch must not paint over home
      iframe.removeAttribute('src');
      if (force) iframe.removeAttribute('srcdoc');
      iframe.srcdoc = homeHtml;
    } else {
      navSeq++;
      if (force) preparedCache.delete(entry.url);
      renderPreparedUrl(entry.url, navSeq);
    }
    // Wire on parsing, not on load (see wirePaneWhenReady).
    wirePaneWhenReady(iframe);
    syncButtons();
  }

  // Followed pages render through the capture pipeline (prepared, same-origin
  // srcdoc), never as a raw cross-origin load. A raw page is where every
  // round-trip failure came from: clicks there navigate natively past the
  // controller (so "back to the start" never restores the comparison),
  // target="_blank" links die in the sandbox, and no diff markup exists.
  // Prepared pages behave like snapshots, so every click stays intercepted
  // and every return home restores its highlights.
  //
  // The fetch is cached per address, so back, forward and refresh re-render
  // without another round trip, and only the latest request may paint, so a
  // slow cold fetch can never overwrite a newer page. Anything the pipeline
  // refuses (live-web addresses, a failed fetch) falls back to the direct
  // load rather than leaving the pane blank.
  function renderDirectUrl(url, seq) {
    if (seq !== undefined && seq !== navSeq) return;
    try {
      iframe.removeAttribute('srcdoc');
      iframe.removeAttribute('src');
      iframe.src = url;
    } catch (_) { /* pane gone */ }
  }
  function renderPreparedUrl(url, seq) {
    const cached = preparedCache.get(url);
    if (cached) {
      try {
        iframe.removeAttribute('src');
        iframe.removeAttribute('srcdoc');
        iframe.srcdoc = cached;
      } catch (_) { /* pane gone */ }
      return;
    }
    let isArchive = false;
    try { isArchive = /web\.archive\.org\/web\/\d{14}/i.test(String(url || '')); } catch (_) { /* direct */ }
    if (!isArchive || typeof fetch === 'undefined') {
      renderDirectUrl(url, seq);
      return;
    }
    fetch(`/api/page?url=${encodeURIComponent(url)}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (seq !== navSeq) return; // superseded by a newer navigation
        if (!ok || !data || !data.html) { renderDirectUrl(url, seq); return; }
        try {
          const html = injectScrollFix(data.html);
          if (preparedCache.size > 30) {
            const oldest = preparedCache.keys().next();
            if (!oldest.done) preparedCache.delete(oldest.value);
          }
          preparedCache.set(url, html);
          iframe.removeAttribute('src');
          iframe.removeAttribute('srcdoc');
          iframe.srcdoc = html;
        } catch (_) { /* pane gone */ }
      })
      .catch(() => { if (seq === navSeq) renderDirectUrl(url, seq); });
  }

  // The browser-style address bar under this pane's toolbar: what the pane
  // is showing right now. A followed link shows where it went; home (the
  // diffed comparison, which lives in srcdoc and has no address of its own)
  // reads as the snapshot's own archived address. The modal pane has no
  // address bar, so every touch here guards on the element existing.
  let homeUrl = '';
  // Whether this bar shows the full archived address (for copying the
  // exact capture) instead of the page's own address. Flipped by the
  // archive button beside the bar; per pane, and never navigates.
  let showArchive = false;
  function syncUrl() {
    let input = null;
    try {
      input = document.getElementById(`${iframeId}Url`);
    } catch (_) {
      input = null;
    }
    if (!input) return;
    // While typing, the bar belongs to the reader: a render landing
    // mid-keystroke must not blow away what is being written.
    if (document.activeElement === input) return;
    const cur = stack.current();
    const shown = (cur && cur.url) || homeUrl;
    // The bar reads as the page's own address, not the archive's copy of
    // it: PdiffNav.displayUrl strips the /web/<timestamp>/ prefix for
    // display only. The stack keeps the full archived address (that is
    // what actually loads), and the hover title keeps it too, so the
    // exact capture stays one hover away. Typing a new address and
    // pressing Enter still navigates the pane like a browser.
    const display = showArchive
      ? shown
      : (typeof PdiffNav !== 'undefined' && PdiffNav.displayUrl)
        ? PdiffNav.displayUrl(shown)
        : shown;
    input.value = display;
    input.title = shown;
  }

  function syncButtons() {
    if (btnBack) btnBack.disabled = !stack.canBack();
    if (btnForward) btnForward.disabled = !stack.canForward();
    const hasCurrent = !!(homeHtml || (stack.current() && stack.current().url));
    if (btnRefresh) btnRefresh.disabled = !hasCurrent;
    if (btnReset) btnReset.disabled = !homeHtml;
    // The home button is two-level on a subpage comparison: off-home it
    // returns to the subpage comparison; already home, it goes back to
    // the snapshot comparison the trace started from. The title says
    // which one this click performs, so the second level is visible
    // before it is pressed rather than a surprise after.
    try {
      if (btnReset && typeof state !== 'undefined') {
        const cur = stack.current();
        const atHome = !cur || cur.home;
        btnReset.title = (atHome && state.subpageComparison && state.timelineQuery)
          ? 'Back to the snapshot comparison'
          : 'Return to comparison';
      }
    } catch (_) { /* title is decoration; the click still works */ }
    syncUrl();
    updateSubpageCompare();
  }

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.pane-nav-btn');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === 'back') render(stack.back());
    else if (action === 'forward') render(stack.forward());
    else if (action === 'refresh') render(stack.current(), true);
    else if (action === 'reset') {
      // Forced so the return is a real navigation even when the home
      // document was left mutated; two-level when the comparison itself
      // is a subpage (see returnToTimelineIfHome).
      if (!returnToTimelineIfHome()) render(stack.reset(), true);
    }
  });

  // Typing an address and pressing Enter follows it like a browser. A bare
  // host gains its https://; anything that is not an http(s) address
  // (javascript:, mailto:, a fragment) is refused by restoring the bar to
  // what the pane is actually showing.
  function wireAddressBar() {
    let input = null;
    try {
      input = document.getElementById(`${iframeId}Url`);
    } catch (_) {
      return;
    }
    if (!input || input.__pdiffUrlWired) return;
    input.__pdiffUrlWired = true;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      let typed = (input.value || '').trim();
      if (typed && !/^[a-z][a-z0-9+.-]*:/i.test(typed)) typed = `https://${typed}`;
      if (typeof PdiffNav !== 'undefined' && PdiffNav.isNavigableUrl(typed)) {
        input.blur();
        api.navigate(typed);
      }
      syncUrl();
      input.select();
    });
    input.addEventListener('blur', syncUrl);
  }

  // The archive button beside the bar: flipping between the page's own
  // address and the full archived address behind it. Landing on the
  // archived form selects it, so the exact capture is one copy away.
  // The modal pane has no such button; every touch guards on it existing.
  function wireArchiveBtn() {
    let btn = null;
    try {
      btn = document.getElementById(`${iframeId}ArchiveBtn`);
    } catch (_) {
      return;
    }
    if (!btn || btn.__pdiffArchiveWired) return;
    btn.__pdiffArchiveWired = true;
    btn.addEventListener('click', () => {
      showArchive = !showArchive;
      btn.setAttribute('aria-pressed', showArchive ? 'true' : 'false');
      btn.title = showArchive ? 'Show the page address' : 'Show the archived address';
      syncUrl();
      if (showArchive) {
        let input = null;
        try {
          input = document.getElementById(`${iframeId}Url`);
        } catch (_) {
          input = null;
        }
        if (input) {
          input.focus();
          input.select();
        }
      }
    });
  }

  const api = {
    setHome(html, url) {
      homeHtml = injectScrollFix(html);
      if (typeof url === 'string') homeUrl = url;
      // Forced: opening the full-screen frame on a comparison it already
      // held once (close it, open it again) would otherwise re-assign the
      // identical srcdoc, which is a no-op - no load event, so the veil
      // this render just showed would never come down, over an old paint.
      render(stack.reset(), true);
    },
    navigate(url) {
      // Always a real navigation, even to the address already showing:
      // assigning an identical src is a silent no-op, which is exactly how
      // a language toggle or a repeated click reads as "the button is dead".
      // Coming back to the page the comparison started from (EN then FR)
      // restores the comparison itself instead: a plain capture there has
      // no diff markup, which is exactly how the round trip reads as "all
      // the highlights vanished". The capture timestamp is ignored on
      // purpose, the toggle lands on a different capture of the same page.
      try {
        if (homeUrl && typeof PdiffNav !== 'undefined' && PdiffNav.sameArchivePage &&
            PdiffNav.sameArchivePage(url, homeUrl)) {
          render(stack.reset(), true);
          return;
        }
      } catch (_) { /* fall through to the plain navigation below */ }
      stack.pushUrl(url);
      render(stack.current(), true);
    },
    currentUrl() {
      const cur = stack.current();
      return (cur && cur.url) || '';
    },
    homeUrl() {
      return homeUrl;
    },
    reset() {
      homeHtml = '';
      homeUrl = '';
      navSeq++;
      preparedCache.clear();
      iframe.removeAttribute('src');
      iframe.removeAttribute('srcdoc');
      iframe.srcdoc = '';
      stack.reset();
      syncButtons();
    },
    getHome() {
      return homeHtml;
    },
    syncButtons() {
      syncButtons();
    },
  };
  paneControllers[iframeId] = api;
  wireAddressBar();
  wireArchiveBtn();
  syncButtons();
  return api;
}

const paneOldNav = createPaneNavController('paneOld', 'paneOldToolbar');
const paneNewNav = createPaneNavController('paneNew', 'paneNewToolbar');
const modalNav = createPaneNavController('modalFrame', 'modalToolbar');

// ---------------------------------------------------------------- Fullscreen modal
// The pane's click and hover wiring used to wait for the frame's load event,
// and on an archived page that can be a minute away: one picture that never
// finishes holds the whole event. The document is interactive long before
// that, so it is wired as soon as it is parseable; the load listener still
// runs as a second chance (and hydrates the cross-origin stylesheets).
function wirePaneWhenReady(iframe) {
  let tries = 0;
  let parsedAt = 0;
  const tick = () => {
    let doc = null;
    try { doc = iframe.contentDocument; } catch (_) { doc = null; }
    const ready = !!(doc && doc.documentElement && doc.readyState !== 'loading');
    if (ready) {
      wirePaneReverseClick(iframe);
      if (!parsedAt) {
        parsedAt = Date.now();
        // A row can be picked while the snapshot is still parsing. The marks
        // were then placed into a document that did not exist yet (or into
        // the empty placeholder), which leaves the click looking dead and
        // never lit: nothing later in the click's own watch loop can mark a
        // node the first pass never found. So the moment a pane is really
        // there, the selection it is supposed to be showing is staged again.
        restageSelectionForPaneLoad();
      }
      // The veil comes down when the page is painted - parsed, styled, its
      // fonts resolved and the pictures on screen drawn (see panePainted).
      // Handing that question to the same function the load event uses means
      // there is one definition of "ready", and it is the one the reader sees.
      revealPaneWhenPainted(iframe);
      return;
    }
    if (tries++ < 200) setTimeout(tick, 100);
  };
  setTimeout(tick, 0);
}

// Re-stage the selected row's reveals and scroll after a pane's document has
// arrived. Only the click path asks for this (see wirePaneWhenReady): the
// row, the change and the panes are all the reader already chose, so this
// moves nothing that was not already going to move.
function restageSelectionForPaneLoad() {
  try {
    if (!selectedRowEl || !revealedFor || !revealedFor.change) return;
    const c = revealedFor.change;
    const changes = (state.currentDiff && state.currentDiff.changes) || [];
    if (!changes.includes(c)) return;
    applySelectionReveals(c, true);
  } catch (_) { /* best effort: the next click still works */ }
}

function openPaneModal(which) {
  const homeHtml = which === 'old' ? paneOldNav.getHome() : paneNewNav.getHome();
  if (!homeHtml) return;
  try { el('modalFrame').dataset.pdiffSide = which === 'old' ? 'old' : 'new'; } catch (_) { /* selection still works, side-agnostic */ }
  el('modalDateLabel').textContent = (which === 'old' ? el('paneOldDate') : el('paneNewDate')).textContent;
  modalNav.setHome(homeHtml);
  el('paneModal').hidden = false;
  // The frame is inside a container that was hidden a moment ago; the
  // document it is about to parse gets wired as it becomes ready, not only
  // when every archived picture has finished.
  wirePaneWhenReady(el('modalFrame'));
  document.body.style.overflow = 'hidden';
}

function closePaneModal() {
  el('paneModal').hidden = true;
  modalNav.reset();
  document.body.style.overflow = '';
}

el('paneOldExpand').addEventListener('click', () => openPaneModal('old'));
el('paneNewExpand').addEventListener('click', () => openPaneModal('new'));

// Hiding a snapshot to see the other one full width, and the matching
// restore. Only one side can be hidden at a time - picking a side just
// sets which (or clears it back to side-by-side).
//
// Staged so the motion reads as one slow fold: collapsing fades the
// leaving pane's content out first and only then flips the grid (which
// eases wider on its own transition), while expanding flips the grid
// first and lets it ease open. An instant flip of both at once is what
// read as a snap. Rapid toggles cancel the pending flip rather than
// stacking them. Reduced-motion readers get the instant version.
let singlePaneTimer = null;
function singlePaneReduced() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}
// The reader's own hide choice ('old', 'new' or null), set only by the
// hide/restore controls. Toggling a selected row off steps back to this
// arrangement instead of forcing side by side, so a pane the reader
// collapsed stays collapsed. A new comparison clears it (see
// renderChangesList): a new pair starts from a fresh layout.
let manualPane = null;
// `opts.instant` folds (or unfolds) in one step instead of animating. The
// selection path uses it to ask a layout question and answer it in the same
// task: unfold to the pair's width, measure the change there, fold again if
// that is what the answer needs. Nothing is painted between the two, so the
// reader sees the final arrangement only - and no transition is left running
// under the measurement (see .pane-instant in styles.css).
function setSinglePaneView(which, opts) {
  const panes = el('viewerPanes');
  if (singlePaneTimer) { clearTimeout(singlePaneTimer); singlePaneTimer = null; }
  panes.classList.remove('pane-leaving-old', 'pane-leaving-new');
  const instant = !!(opts && opts.instant);
  if (!which || instant || singlePaneReduced()) {
    panes.classList.remove('hide-old', 'hide-new');
    if (which === 'old') panes.classList.add('hide-old');
    else if (which === 'new') panes.classList.add('hide-new');
    return;
  }
  panes.classList.add(which === 'old' ? 'pane-leaving-old' : 'pane-leaving-new');
  singlePaneTimer = setTimeout(() => {
    singlePaneTimer = null;
    try {
      panes.classList.remove('hide-old', 'hide-new', 'pane-leaving-old', 'pane-leaving-new');
      panes.classList.add(which === 'old' ? 'hide-old' : 'hide-new');
    } catch (_) { /* panes gone */ }
  }, 380);
}
// Hiding a pane by hand takes the layout over: the reader's own
// arrangement wins, and the next selection starts from it rather than
// putting the pair back.
function manualPaneView(which) {
  manualPane = which;
  setSinglePaneView(which);
}
el('paneOldHide').addEventListener('click', () => manualPaneView('old'));
el('paneNewHide').addEventListener('click', () => manualPaneView('new'));
el('paneOldRestore').addEventListener('click', () => manualPaneView(null));
el('paneNewRestore').addEventListener('click', () => manualPaneView(null));
el('paneModalClose').addEventListener('click', closePaneModal);
el('paneModalBackdrop').addEventListener('click', closePaneModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('paneModal').hidden) closePaneModal();
});

// ---------------------------------------------------------------- Compare open pages
// After following links inside the snapshots, the changes list describes
// the comparison the panes started from, not the two subpages they show.
// This rebuilds it for exactly what is open: both pages are re-read
// through the capture pipeline, diffed, and adopted as the new comparison
// homes (annotated, outlined, with working back/reset), and the pane
// headers name the subpages instead of the old snapshot dates.
function pageTitleOf(html, fallbackUrl) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const t = (doc.querySelector('title') || {}).textContent || '';
    const clean = t.replace(/\s+/g, ' ').trim();
    if (clean) return truncate(clean, 70);
  } catch (_) { /* fall through to the URL */ }
  try {
    const u = new URL(fallbackUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const name = seg ? decodeURIComponent(seg).replace(/[-_]+/g, ' ') : u.hostname;
    return truncate(name, 70);
  } catch (_) {
    return 'Open pages';
  }
}

function isArchivePageUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return /^https?:$/.test(u.protocol) && u.hostname.toLowerCase() === 'web.archive.org';
  } catch (_) {
    return false;
  }
}

// Enabled only once a pane has wandered off the comparison: with both
// panes home, the open pages ARE the comparison and there is nothing new
// to build. Defensive throughout, this also runs during controller
// construction, before the controllers exist.
function updateSubpageCompare() {
  let btn = null;
  try {
    btn = el('comparePagesBtn');
  } catch (_) {
    return;
  }
  if (!btn) return;
  let active = false;
  try {
    active = !!(
      state.currentDiff &&
      !el('workspace').hidden &&
      (paneOldNav.currentUrl() || paneNewNav.currentUrl())
    );
  } catch (_) {
    active = false;
  }
  btn.disabled = !active;
}

// The work itself, callable with any two archived page addresses (the button
// passes what the panes show; a shared link passes what it names).
async function diffOpenPages(oldPage, newPage, opts = {}) {
  if (!oldPage || !newPage) {
    setError('Open a page in each pane first. There is nothing to compare yet.');
    return;
  }
  if (!isArchivePageUrl(oldPage) || !isArchivePageUrl(newPage)) {
    setError(
      'Only archived pages can be compared. One of the panes is showing the live web ' +
      '(or somewhere else entirely). Please go back to an archived page first.'
    );
    return;
  }
  setError(null);
  const btn = el('comparePagesBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Comparing\u2026';
  invalidatePaneReveals();
  showPaneLoading('paneOldLoading');
  showPaneLoading('paneNewLoading');
  try {
    const res = await fetch(
      `/api/diff-pages?old=${encodeURIComponent(oldPage)}&new=${encodeURIComponent(newPage)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not build that comparison.');
    state.currentDiff = data;
    // The open subpages become the new comparison: re-homed (so their
    // outlines draw and back/reset return to them), re-titled, re-counted.
    // Their stacks start over, the old snapshot homes are one "return to
    // comparison" away via the timeline's Compare button above.
    paneOldNav.setHome(data.oldHtml, oldPage);
    paneNewNav.setHome(data.newHtml, newPage);
    el('paneOldDate').textContent = pageTitleOf(data.oldHtml, oldPage);
    el('paneNewDate').textContent = pageTitleOf(data.newHtml, newPage);
    renderChangeCounts(data.counts);
    renderChangesList(data.changes);
    // This pair is what the address should now say, so a share link (or the
    // Copy link button) sends someone to this comparison rather than to the
    // snapshot pair the timeline still names.
    state.subpageComparison = { old: oldPage, new: newPage };
    setHash(pagesHashFor(oldPage, newPage));
    el('copyLinkBtn').disabled = false;
    if (!opts.silentScroll) el('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setError(err.message);
    hidePaneLoading('paneOldLoading');
    hidePaneLoading('paneNewLoading');
  } finally {
    btn.textContent = originalText;
    updateSubpageCompare();
  }
}

async function compareOpenPages() {
  await diffOpenPages(
    paneOldNav.currentUrl() || paneOldNav.homeUrl(),
    paneNewNav.currentUrl() || paneNewNav.homeUrl()
  );
}
el('comparePagesBtn').addEventListener('click', compareOpenPages);

// ---------------------------------------------------------------- Copy link
// The comparison address is the shareable thing: see compareHashFor above.
// The button copies it with a confirmation in place, and falls back to showing
// it selected if the clipboard is not available (an insecure origin, a browser
// that says no), never a silent click that did nothing.
async function copyComparisonLink() {
  const btn = el('copyLinkBtn');
  if (!state.currentDiff) return;
  // Whichever comparison is on screen: the two open pages, or, when both
  // panes are home, the two snapshots the timeline names. A link that claims
  // to be snapshots while the panes show subpages would be a lie.
  const liveOld = paneOldNav.currentUrl();
  const liveNew = paneNewNav.currentUrl();
  let hash = '';
  if (liveOld || liveNew || state.subpageComparison) {
    const pair = state.subpageComparison || {};
    hash = pagesHashFor(liveOld || pair.old, liveNew || pair.new);
  }
  if (!hash) {
    const from = state.snapshots[state.fromIndex];
    const to = state.snapshots[state.toIndex];
    if (!from || !to) return;
    hash = compareHashFor(state.url, from.timestamp, to.timestamp);
  }
  if (!hash) return;
  const link = `${location.origin}${location.pathname}${hash}`;
  const original = btn.textContent;
  const flash = (text) => {
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 1600);
  };
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(link);
    flash('Link copied');
  } catch (_) {
    try {
      const helper = document.createElement('textarea');
      helper.value = link;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand('copy');
      helper.remove();
      if (ok) { flash('Link copied'); return; }
    } catch (_) { /* fall through to showing it */ }
    // Nothing would copy it: show the address instead, which is still useful
    // and is at least honest about not having copied anything.
    window.prompt('Copy this comparison link:', link);
  }
}
el('copyLinkBtn').addEventListener('click', copyComparisonLink);
// The way back out of the filter, for a reader who pressed the counts and
// then wanted the whole record again.
el('changeFilterClear').addEventListener('click', clearChangeKindFilter);

// The three counts are also the filter, and each one is a switch: pressed,
// only that kind of change is left in the list and lit on the pages; pressed
// again it goes off; with none pressed the reader is looking at the whole
// record, which is where a comparison opens. They are buttons rather than the
// plain spans they used to be because that is the only thing on a page that
// says "this can be narrowed to", and aria-pressed carries the state, so the
// switch is a switch to a screen reader and not a decoration.
//
// A row a switch hides stays in the list, hidden, rather than being thrown
// away: sidebar rows are addressed by index from clicks inside the panes, and
// a list that renumbers itself under those clicks answers the wrong row.
const CHANGE_KINDS = ['added', 'removed', 'changed'];

function renderChangeCounts(counts) {
  el('changeCounts').innerHTML = CHANGE_KINDS
    .map((kind) => `<button type="button" class="change-count" data-kind="${kind}" aria-pressed="false">` +
      `<i class="dot dot-${kind}"></i><b>${counts[kind] || 0}</b> ${kind}</button>`)
    .join('');
  el('changeCounts').querySelectorAll('.change-count').forEach((btn) => {
    btn.addEventListener('click', () => toggleChangeKind(btn.dataset.kind));
  });
  syncKindSwitches();
}

// What is on screen between pressing Compare and the archive answering: the
// pair's own dates on both label bars, nothing left over from the comparison
// that was there a moment ago, and a line in the changes column saying what
// the wait is for. The panes need nothing here: their veils are already up
// (runDiffQuery) and the template around them never left.
let paneDatesBeforeRun = null;
let changesBeforeRun = null;

// A run that never arrives is not a reason to take a working comparison away
// from the reader: the labels name the pair that is really on screen again,
// and the list it had is put back exactly as it was, with the switches still
// where the reader left them. On a first run there is nothing to put back and
// both are simply left empty, which is the honest state for a page that has
// not compared anything yet.
function restoreRunBeforeState() {
  if (paneDatesBeforeRun) {
    el('paneOldDate').textContent = paneDatesBeforeRun.old;
    el('paneNewDate').textContent = paneDatesBeforeRun.next;
    paneDatesBeforeRun = null;
  }
  if (changesBeforeRun) {
    renderChangeCounts(changesBeforeRun.counts || {});
    renderChangesList(changesBeforeRun.changes || []);
    changesBeforeRun = null;
  }
}

function beginChangeLoading(fromTs, toTs, opts) {
  // Kept so a comparison that never arrives can put the labels back: the panes
  // are still showing the previous pair, and a label naming a pair that failed
  // would be describing a comparison nobody is looking at.
  paneDatesBeforeRun = { old: el('paneOldDate').textContent, next: el('paneNewDate').textContent };
  changesBeforeRun = state.currentDiff
    ? { counts: state.currentDiff.counts, changes: state.currentDiff.changes }
    : null;
  el('paneOldDate').textContent = formatDate(opts.fromDate || timestampToIso(fromTs));
  el('paneNewDate').textContent = formatDate(opts.toDate || timestampToIso(toTs));
  el('changeCounts').innerHTML = '';
  el('changesList').innerHTML = '';
  el('noChangesMsg').hidden = true;
  el('changeFilterBar').hidden = true;
  el('loadingChanges').hidden = false;
}

function toggleChangeKind(kind) {
  if (!CHANGE_KINDS.includes(kind)) return;
  if (state.kindFilter.has(kind)) state.kindFilter.delete(kind);
  else state.kindFilter.add(kind);
  applyKindFilter();
}

// Called when a click inside a pane reaches for a change the reader had
// filtered out. Clicking it is the plainest statement that they want to see
// it, so the switch gives way rather than the click lighting up a row that is
// not on screen.
function clearChangeKindFilter() {
  if (!state.kindFilter.size) return false;
  state.kindFilter.clear();
  applyKindFilter();
  return true;
}

// Every row the reader is being shown, and the line that says how many that
// is out of how many. Rows are toggled with `hidden` rather than removed, so
// the row index a pane click resolves to is always the row the click meant.
function applyKindFilter() {
  const changes = (state.currentDiff && state.currentDiff.changes) || [];
  const on = state.kindFilter;
  let shown = 0;
  Array.from(el('changesList').children).forEach((row, i) => {
    const kind = (changes[i] && changes[i].type) || row.dataset.kind || '';
    const visible = !on.size || on.has(kind);
    row.hidden = !visible;
    if (visible) shown += 1;
  });
  syncKindSwitches();
  const bar = el('changeFilterBar');
  bar.hidden = !on.size || !changes.length;
  if (!bar.hidden) el('changeFilterNote').textContent = `Showing ${shown} of ${changes.length} changes`;
  syncKindFocus();
}

function syncKindSwitches() {
  el('changeCounts').querySelectorAll('.change-count').forEach((btn) => {
    const on = state.kindFilter.has(btn.dataset.kind);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? `Stop showing only ${btn.dataset.kind} changes`
      : `Show only ${btn.dataset.kind} changes`;
  });
}

// The same switch, on the pages themselves. A kind that is switched off keeps
// its words and loses its frame: the reader asked to see only the changes they
// chose, and a page still ringed in red for a kind they turned off is the list
// and the page disagreeing about one setting. The rules are written into each
// pane's own document, because a srcdoc frame is its own browsing context and
// no stylesheet of the host page can reach into it. With nothing switched off
// there is no style and no attribute at all, so the marks on the page are
// exactly what they always were.
const KIND_FOCUS_STYLE_ID = 'pdiffKindFocusStyle';
const KIND_FOCUS_ATTR = 'data-pdiff-kind-focus';
function syncKindFocus(only) {
  const frames = only ? [only] : [el('paneOld'), el('paneNew'), el('modalFrame')];
  frames.forEach((iframe) => {
    if (!iframe) return;
    let doc = null;
    try { doc = iframe.contentDocument; } catch (_) { return; }
    if (!doc || !doc.documentElement) return;
    const root = doc.documentElement;
    const existing = doc.getElementById(KIND_FOCUS_STYLE_ID);
    const on = CHANGE_KINDS.filter((kind) => state.kindFilter.has(kind));
    if (!on.length) {
      root.removeAttribute(KIND_FOCUS_ATTR);
      if (existing) existing.remove();
      return;
    }
    root.setAttribute(KIND_FOCUS_ATTR, on.join(' '));
    let style = existing;
    if (!style) {
      style = doc.createElement('style');
      style.id = KIND_FOCUS_STYLE_ID;
      if (doc.head) doc.head.appendChild(style);
      else root.appendChild(style);
    }
    style.textContent = CHANGE_KINDS
      .filter((kind) => !state.kindFilter.has(kind))
      .map((kind) => `html:not([${KIND_FOCUS_ATTR}~="${kind}"]) [data-pdiff-${kind}]` +
        ` { box-shadow: none !important; outline: none !important; cursor: inherit; }`)
      .join('\n');
  });
}

// ---------------------------------------------------------------- Image and textless labels
//
// An <img> carries no text, so the generic before/after rendering had
// nothing to show for it: added and removed images were blank rows, and a
// changed image was a bare "→" with empty strings at both ends. Which is
// exactly backwards, the image is usually what the reader is looking for.
// Every label below names the picture (its description when it has one,
// otherwise the file it points at) so no image row is ever blank or a bare
// arrow again.
//
// Tags with no words to diff: image, video, frame, field, rule. Anything
// added here must also be considered in showChangeTooltip's text-section
// hiding and in compareLeafAppearance's early return.
const TEXTLESS_TAGS = new Set(['img', 'video', 'iframe', 'audio', 'input', 'hr', 'embed', 'source']);

// The file at the end of a URL: "/img/logo-cic-en.png" → "logo-cic-en.png".
// Archive rewrites, queries, and fragments are stripped; a data: URL is an
// inline image, not a file. Never throws on a malformed escape.
function fileNameFromUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^data:/i.test(s)) return 'inline image';
  const noQuery = s.split(/[?#]/)[0];
  const seg = (noQuery.split('/').pop() || '').trim();
  if (!seg) return s.length > 48 ? `${s.slice(0, 48)}\u2026` : s;
  try {
    const decoded = decodeURIComponent(seg);
    return decoded || seg;
  } catch (_) {
    return seg;
  }
}

function attrFromChange(c, name, side) {
  if (side === 'before') {
    if (c.attrsBefore && c.attrsBefore[name] != null) return c.attrsBefore[name];
    const found = (c.attrChanges || []).find((a) => a.name === name);
    return found ? found.before : '';
  }
  if (c.attrsAfter && c.attrsAfter[name] != null) return c.attrsAfter[name];
  const found = (c.attrChanges || []).find((a) => a.name === name);
  return found ? found.after : '';
}

// One side of an image change, as a person would name the picture: its
// description when the author wrote one, otherwise the file it points at,
// otherwise the honest fallback (which only fires when the markup carries
// neither, e.g. a spacer gif with no alt).
function imageSideLabel(c, side) {
  const alt = String(attrFromChange(c, 'alt', side) || '').trim();
  if (alt) return `\u201c${truncate(alt, 60)}\u201d`;
  const src = attrFromChange(c, 'src', side) || attrFromChange(c, 'poster', side);
  const file = fileNameFromUrl(src);
  if (file) return truncate(file, 60);
  const title = String(attrFromChange(c, 'title', side) || '').trim();
  if (title) return `\u201c${truncate(title, 60)}\u201d`;
  return 'Image (no description)';
}

function textlessSideLabel(c, side) {
  const tag = (c.tag || '').toLowerCase();
  if (tag === 'img') return imageSideLabel(c, side);
  if (tag === 'input') {
    const ph = String(attrFromChange(c, 'placeholder', side) || '').trim()
      || String(attrFromChange(c, 'value', side) || '').trim()
      || String(attrFromChange(c, 'name', side) || '').trim();
    if (ph) return `\u201c${truncate(ph, 60)}\u201d`;
    return 'Form field';
  }
  if (tag === 'video' || tag === 'audio' || tag === 'iframe') {
    const src = attrFromChange(c, 'src', side) || attrFromChange(c, 'poster', side);
    const file = fileNameFromUrl(src);
    if (file) return truncate(file, 60);
    const title = String(attrFromChange(c, 'title', side) || '').trim();
    if (title) return `\u201c${truncate(title, 60)}\u201d`;
    return tag === 'iframe' ? 'Embedded page' : 'Media (no description)';
  }
  if (tag === 'hr') return 'Divider line';
  const txt = side === 'before' ? c.before : c.after;
  if (txt && txt.trim()) return truncate(txt.trim(), 90);
  return 'Media';
}

// One plain sentence for an image-only change: what actually differs, or  
// when nothing about the picture differs and only its address moved, that
// fact said out loud. This exists because "image file changed" tells a
// reader nothing, and because the two cases look identical in the panes.
//
// The name family is the useful signal. Two files whose names match once the
// interchangeable parts are dropped (15-years/years, -old/-new, -v2/-v3,
// -2016/-2026) are the same picture re-saved; two names that merely share a
// prefix (logo-ontario / logo-ontario-positive) are not, because the extra
// word names a different picture rather than a version of this one. Crude on
// purpose: it separates "same picture, renamed" from "a different picture"
// without pretending to compare pixels it cannot fetch across origins.
const IMAGE_NAME_NOISE_RE = /^(?:\d+|old|new|final|latest|v\d+)$/;

function imageNameFamily(file) {
  const base = String(file || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  if (!base) return '';
  return base
    .split(/[-_ ]+/)
    .filter((word) => word && !IMAGE_NAME_NOISE_RE.test(word))
    .join('');
}

// 'same', the same picture under a renamed file; 'different', a different
// picture; 'unknown', nothing about the picture changed that this can see.
// A byte-compared pair (same address, different file contents) is always a
// different picture, however the names read.
function imageChangeVerdict(c) {
  if (c && c.imageBytesChanged) return 'different';
  const fileBefore = fileNameFromUrl(attrFromChange(c, 'src', 'before'));
  const fileAfter = fileNameFromUrl(attrFromChange(c, 'src', 'after'));
  const altBefore = String(attrFromChange(c, 'alt', 'before') || '').trim();
  const altAfter = String(attrFromChange(c, 'alt', 'after') || '').trim();
  if (fileBefore && fileAfter && fileBefore !== fileAfter) {
    return imageNameFamily(fileBefore) === imageNameFamily(fileAfter) ? 'same' : 'different';
  }
  if (altBefore !== altAfter) return 'different';
  return 'unknown';
}

const isInlineImageSrc = (v) => /^data:/i.test(String(v == null ? '' : v).trim());

// The max-width a hiding rule is gated on, in px, or null when the rule is
// not width-gated at all (a min-width hiding, for example, which widening
// the stage would never clear). Pure, so the label tests pin it.
function maxWidthLimit(mediaText) {
  const m = /max-width:\s*([\d.]+)\s*(px|em|rem)/i.exec(String(mediaText || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  return unit === 'px' ? n : n * 16;
}

// A size change in words, from the recorded width/height differences. This
// is how an icon ends up rendering at a different size with the same file
// and the same description, which used to read as no change at all.
function dimensionChangeText(c) {
  const pick = (name) => (c.attrChanges || []).find((a) => a.name === name);
  const w = pick('width');
  const h = pick('height');
  if (!w && !h) return '';
  // Measured sizes the server attached (declared, or the file's natural size
  // where undeclared): an undeclared side renders at its natural size, never
  // at "(none)", so the sentence names the exact before number.
  const eff = (name, side) => {
    const s = side === 'before' ? c.sizeBefore : c.sizeAfter;
    if (!s) return null;
    const n = name === 'width' ? s.w : s.h;
    return n == null ? null : n;
  };
  const showBoth = (a, name) => {
    const before = (a.before == null || a.before === '') ? eff(name, 'before') : a.before;
    const after = (a.after == null || a.after === '') ? eff(name, 'after') : a.after;
    const b = before == null ? 'unset' : before;
    const af = after == null ? 'unset' : after;
    // Declared-ness changed but the rendered number did not (undeclared
    // 45 → declared 45): not a change, so it says nothing.
    if (String(b) === String(af)) return null;
    return `${name} ${b} \u2192 ${af}`;
  };
  const show = (a) => (a.after == null ? 'unset' : a.after);
  const measured = (c.sizeBefore || c.sizeAfter) ? true : false;
  const bits = [];
  if (w) bits.push(measured ? showBoth(w, 'width') : `width ${show(w)}`);
  if (h) bits.push(measured ? showBoth(h, 'height') : `height ${show(h)}`);
  const said = bits.filter((b) => b != null);
  if (!said.length) return '';
  const noun = measured ? 'display size' : 'declared display size';
  return `Its ${noun} changed (${said.join(', ')}), so it renders at a different size than before.`;
}

// A width/height row whose rendered number did not move (undeclared 45 →
// declared 45) is noise, not information: true when both ends resolve to
// the same number, via the attribute or the measured sizes. Unknown on
// either end keeps the row, a guess hides nothing.
function sizeRowIsNoop(c, row) {
  if (row.name !== 'width' && row.name !== 'height') return false;
  const num = (side) => {
    const raw = side === 'before' ? row.before : row.after;
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    const s = side === 'before' ? c.sizeBefore : c.sizeAfter;
    const v = s ? (row.name === 'width' ? s.w : s.h) : null;
    return v == null ? null : v;
  };
  const b = num('before'), a = num('after');
  return b != null && a != null && b === a;
}

// The exact number behind a width/height row: the declared attribute when the
// markup has one, otherwise the measured size the server attached (the file's
// natural size where undeclared). Without this the row reads "(none) → 119"
// and hides what the picture actually rendered at before.
function displaySizeValue(c, row, side) {
  const raw = side === 'before' ? row.before : row.after;
  if (raw !== null && raw !== undefined && raw !== '') return String(raw);
  const s = side === 'before' ? c.sizeBefore : c.sizeAfter;
  const n = s ? (row.name === 'width' ? s.w : s.h) : null;
  if (n != null) return `${n} (natural size)`;
  return '(none)';
}

// The sidebar row's second line for an image: the verdict when the file or
// the description tells the story, the real mechanism when it does.
function imageRowSub(c) {
  if (c && c.imageBytesChanged) return 'Same address, different picture. Open the row to see both.';
  const changes = c.attrChanges || [];
  const has = (name) => changes.some((a) => a.name === name);
  const srcBefore = String(attrFromChange(c, 'src', 'before') || '');
  const srcAfter = String(attrFromChange(c, 'src', 'after') || '');
  if (has('data-src') || isInlineImageSrc(srcBefore) || isInlineImageSrc(srcAfter)) {
    return 'Loads differently now. Open the row to see how.';
  }
  if (has('width') || has('height')) return 'New display size. Open the row to see it.';
  const verdict = imageChangeVerdict(c);
  return verdict === 'same'
    ? 'Same picture, re-saved under a new file name'
    : verdict === 'different'
      ? 'A different picture now. Open the row to see both.'
      : 'Same name. Open the row for what changed.';
}

// What the reader is told about an image change, in full. The short verdict
// above is what a sidebar row can fit; this is what the tooltip says.
function describeImageChange(c) {
  if (c && c.imageBytesChanged) {
    const file = fileNameFromUrl(attrFromChange(c, 'src', 'after') || attrFromChange(c, 'src', 'before'));
    return `The picture's address stayed the same${file ? ` (${file})` : ''}, but the file's bytes differ between the snapshots, ` +
      'so this is a different picture, not a re-save. Compare the two thumbnails above to see it.';
  }
  const rawSrcBefore = String(attrFromChange(c, 'src', 'before') || '');
  const rawSrcAfter = String(attrFromChange(c, 'src', 'after') || '');
  const fileBefore = fileNameFromUrl(rawSrcBefore);
  const fileAfter = fileNameFromUrl(rawSrcAfter);
  const altBefore = String(attrFromChange(c, 'alt', 'before') || '').trim();
  const altAfter = String(attrFromChange(c, 'alt', 'after') || '').trim();
  // Lazy-loading swaps first: the address holds a tiny inline placeholder
  // while the real file sits in data-src, so the file names alone hide
  // what happened instead of telling it. With no data-src on either side
  // the inline data IS the picture (embedded, not a placeholder), so it
  // says that instead of naming a "real file" that is really the old one.
  if (isInlineImageSrc(rawSrcBefore) || isInlineImageSrc(rawSrcAfter)) {
    const rawDataBefore = attrFromChange(c, 'data-src', 'before');
    const rawDataAfter = attrFromChange(c, 'data-src', 'after');
    const realOf = (rawSrc, rawDataSrc) => {
      const dataFile = fileNameFromUrl(rawDataSrc);
      if (dataFile) return dataFile;
      return isInlineImageSrc(rawSrc) ? '' : fileNameFromUrl(rawSrc);
    };
    const realBefore = realOf(rawSrcBefore, rawDataBefore);
    const realAfter = realOf(rawSrcAfter, rawDataAfter);
    if (realBefore && realAfter && realBefore !== realAfter) {
      return `This picture loads differently now. Before it was ${realBefore}, now it arrives via ${realAfter}.`;
    }
    const real = realAfter || realBefore;
    if (real && (rawDataBefore || rawDataAfter)) {
      return `This picture now lazy-loads. Its address holds a tiny inline placeholder, and the real file is ${real}.`;
    }
    if (fileBefore && isInlineImageSrc(rawSrcAfter)) {
      return `This picture is now embedded inline (no separate file) instead of loading ${fileBefore}. Compare the two thumbnails above to see it.`;
    }
    if (fileAfter && isInlineImageSrc(rawSrcBefore)) {
      return `This picture used to be embedded inline (no separate file); now it loads ${fileAfter}. Compare the two thumbnails above to see it.`;
    }
    return 'This picture loads differently now. Its address holds a tiny inline placeholder instead of a file.';
  }
  if (fileBefore && fileAfter && fileBefore !== fileAfter) {
    const head = `The picture's file address changed: ${fileBefore} → ${fileAfter}. `;
    if (imageChangeVerdict(c) === 'same') {
      return head +
        'The name is the same picture with one interchangeable part swapped (a number, a year count, an old/new tag, or a version), ' +
        'so this is almost certainly the same picture re-saved under a new name, not a new picture.';
    }
    return head +
      'The two names are not versions of each other, so this is a different picture now. ' +
      'compare the two thumbnails above to see it.';
  }
  if (altBefore !== altAfter) {
    return `Same file (${fileAfter || fileBefore || 'no address'}), but what the page describes the picture as changed: ` +
      `${altBefore ? `\u201c${altBefore}\u201d` : '(no description)'} → ${altAfter ? `\u201c${altAfter}\u201d` : '(no description)'}.`;
  }
  if (fileBefore && fileBefore === fileAfter) {
    const dims = dimensionChangeText(c);
    if (dims) return `Same picture file (${fileBefore}). ${dims}`;
    const otherChanges = (c.attrChanges || []).filter((a) => a.name !== 'src' && a.name !== 'alt');
    if (otherChanges.length) {
      return `The picture itself is unchanged (${fileBefore}). What changed is something else about the element.`;
    }
    return 'Nothing about this picture itself differs between the snapshots. It is listed because something around it moved.';
  }
  return 'Nothing about this picture itself differs between the snapshots. It is listed because something around it moved.';
}

// The sidebar row's second line. Text elements keep the exact rendering
// they always had; textless ones get a label that always names something.
// A changed image with the same description at both ends shows it once  
// "\u201cLogo\u201d → "\u201cLogo\u201d" explains nothing, while a real
// description or file change keeps the arrow, which then means something.
function sidebarTextForChange(c) {
  const tag = (c.tag || '').toLowerCase();
  if (!TEXTLESS_TAGS.has(tag)) {
    if (c.type === 'changed') {
      return `<span class="before">${escapeHtml(truncate(c.before, 60))}</span> &rarr; <span class="after">${escapeHtml(truncate(c.after, 60))}</span>`;
    }
    if (c.type === 'added') {
      return `<span class="after">${escapeHtml(truncate(c.after, 90))}</span>`;
    }
    return `<span class="before">${escapeHtml(truncate(c.before, 90))}</span>`;
  }
  if (c.type === 'added') {
    return `<span class="after">\uD83D\uDDBC ${escapeHtml(textlessSideLabel(c, 'after'))}</span>`;
  }
  if (c.type === 'removed') {
    return `<span class="before">\uD83D\uDDBC ${escapeHtml(textlessSideLabel(c, 'before'))}</span>`;
  }
  const beforeLabel = textlessSideLabel(c, 'before');
  const afterLabel = textlessSideLabel(c, 'after');
  if (beforeLabel === afterLabel) {
    // Same name at both ends: say which kind of change it is, in words a
    // person can act on, instead of "image file changed". Pictures get
    // the mechanism-aware line (lazy-loads, new sizes); other textless
    // elements keep the verdict line.
    let sub;
    if (tag === 'img') {
      sub = imageRowSub(c);
    } else {
      const verdict = imageChangeVerdict(c);
      sub = verdict === 'same'
        ? 'Same picture, re-saved under a new file name'
        : verdict === 'different'
          ? 'A different picture now. Open the row to see both.'
          : 'Same name. Open the row for what changed.';
    }
    return `<span class="after">\uD83D\uDDBC ${escapeHtml(afterLabel)}</span>` +
      `<span class="change-sub">${escapeHtml(sub)}</span>`;
  }
  return `<span class="before">\uD83D\uDDBC ${escapeHtml(beforeLabel)}</span> &rarr; <span class="after">${escapeHtml(afterLabel)}</span>`;
}

function renderChangesList(changes) {
  // A new comparison starts from the reader's side by side: a fold made for
  // the pair just replaced belonged to that pair.
  manualPane = null;
  try { setSinglePaneView(null); } catch (_) { /* panes gone */ }
  clearSelection();
  const list = el('changesList');
  list.innerHTML = '';
  el('noChangesMsg').hidden = changes.length > 0;

  changes.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'change-row';
    li.dataset.kind = c.type;

    const body = document.createElement('div');
    body.className = 'change-body';

    const kind = document.createElement('div');
    kind.className = 'change-kind';
    kind.textContent = `${c.type} \u00b7 <${c.tag}>`;

    const text = document.createElement('p');
    text.className = 'change-text';
    text.innerHTML = sidebarTextForChange(c);

    body.appendChild(kind);
    body.appendChild(text);
    li.appendChild(body);

    li.setAttribute('tabindex', '0');
    // The row remembers its own change, so the detail card can be put back
    // after the pointer has been somewhere else.
    li.__pdiffChange = c;
    li.addEventListener('click', () => jumpToChange(c, li));
    li.addEventListener('mouseenter', () => { cancelTooltipHide(); showChangeTooltip(c, li); });
    li.addEventListener('mouseleave', scheduleTooltipHide);
    li.addEventListener('focus', () => showChangeTooltip(c, li));
    li.addEventListener('blur', scheduleTooltipHide);
    list.appendChild(li);
  });

  // Whatever the reader has switched on above applies to this list too: the
  // switches outlive one comparison, so a reader who asked for removals only
  // is not handed the whole record again by the next pair they open.
  applyKindFilter();
}

// The list behaves like a listbox: one row at a time is reachable with the
// arrow keys, and Enter (or Space) picks it the same way a click does. A
// record of 349 changes is something a reader walks through, and walking it
// with the mouse means finding the tiny row again after every jump. The keys
// skip rows the switches have filtered out, so what the arrows promise is
// what the reader sees.
function visibleRows() {
  const out = [];
  const list = el('changesList');
  if (!list) return out;
  for (const row of Array.from(list.children)) {
    if (row.hidden || row.style.display === 'none') continue;
    out.push(row);
  }
  return out;
}

function focusChangeRow(row) {
  if (!row) return;
  try { row.focus({ preventScroll: true }); } catch (_) { try { row.focus(); } catch (__) { /* no focus: the click path still works */ } }
  try { row.scrollIntoView({ block: 'nearest' }); } catch (_) { /* list may be gone */ }
}

function wireChangesListKeys() {
  const list = el('changesList');
  if (!list) return;
  list.addEventListener('keydown', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.change-row') : null;
    if (!row) return;
    const rows = visibleRows();
    const at = rows.indexOf(row);
    if (at < 0) return;
    // Moving the keys picks the row it lands on: this list is a record to
    // walk through, and one keypress that both moves and aims is how a
    // reader crosses a hundred changes without hunting for the row again.
    const move = (to) => {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!next) return;
      focusChangeRow(next);
      const idx = Array.prototype.indexOf.call(list.children, next);
      const c = (state.currentDiff && state.currentDiff.changes) || [];
      if (idx >= 0 && c[idx]) jumpToChange(c[idx], next);
    };
    const step = e.key === 'ArrowDown' || e.key === 'j' || e.key === 'n' ? 1
      : (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'p' ? -1 : 0);
    if (step) return move(at + step);
    if (e.key === 'Home') return move(0);
    if (e.key === 'End') return move(rows.length - 1);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const idx = Array.prototype.indexOf.call(list.children, row);
      const c = (state.currentDiff && state.currentDiff.changes) || [];
      if (idx >= 0 && c[idx]) jumpToChange(c[idx], row);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (e.key === 'PageDown') return move(at + 10);
    if (e.key === 'PageUp') return move(at - 10);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireChangesListKeys);
else wireChangesListKeys();

// Tracks whatever is currently marked "selected" so clicking a new change
// clears the old highlight properly instead of leaving multiple things lit
// up at once.
let selectedRowEl = null;
let selectedOldTarget = null;
let selectedNewTarget = null;

// The word "SELECTED" and a frame drawn on the element itself, as inline
// styles. The class-based badge is still there, and on almost every page it
// is what shows. But a page is free to style its own ::after on the same
// element with higher specificity, and archived sites do exactly that: the
// settlement.org carousel's caption arrow is a `content: url(...)` on
// `h3 a::after`, which outranks `.pdiff-selected::after` and replaced the
// word with an arrow picture, and its box-shadow rule outranked the frame.
// Both of those left a picked carousel card looking unpicked. An element
// with its own inline rule cannot be outranked by a stylesheet, so the word
// and the frame are also put there in person, and taken back off on deselect.
// The layer the comparison's own badges are drawn in: a sibling of the
// pane's iframe, in the host page, covering exactly the frame.
//
// It exists because the word "SELECTED" is chrome, not content. Every
// version of it that lived INSIDE the snapshot was at the mercy of a
// stylesheet nobody here wrote - a page's own ::after winning on
// specificity (settlement.org's carousel caption arrow), an ancestor's
// `overflow: hidden` or `transform` clipping it, a menu opened on top
// painting straight over it - and every version that lived inside the
// snapshot also added an element to a document the Archive recorded. A
// layer over the frame has nothing above it but the pane's own toolbar, and
// the snapshot's DOM stays exactly what the crawl captured.
function paneBadgeLayer(iframe) {
  if (!iframe) return null;
  let layer = null;
  try {
    const host = iframe.parentElement;
    if (!host) return null;
    layer = host.querySelector(':scope > .pane-badges');
    if (!layer) {
      layer = iframe.ownerDocument.createElement('div');
      layer.className = 'pane-badges';
      layer.setAttribute('aria-hidden', 'true');
      host.appendChild(layer);
    }
  } catch (_) {
    layer = null;
  }
  return layer;
}

// A pane that navigates paints a new document: the badge of an old pick
// belongs to the page that just went away, and the frame it was pinned to
// (an inline outline on an element in that document) went with it.
function clearPaneBadges(iframe) {
  try {
    const host = iframe && iframe.parentElement;
    const layer = host ? host.querySelector(':scope > .pane-badges') : null;
    if (layer) layer.textContent = '';
  } catch (_) { /* nothing to clear */ }
}

// The word "SELECTED", drawn in the host layer, plus a frame drawn on the
// element itself as an inline outline. Both are taken back off on deselect.
//
// The word is placed from the element's own box, translated into the
// layer's coordinates through the frame's offset (the two are different
// coordinate systems even though the pane looks like one page), and it is
// re-placed on every scroll and pane resize, because a fixed box does not
// follow the element it names.
function paintSelected(target) {
  if (!target) return;
  let doc = null;
  let win = null;
  try {
    doc = target.ownerDocument;
    win = doc ? doc.defaultView : null;
  } catch (_) {
    return;
  }
  if (!doc || !win) return;
  let color = '';
  try { color = String(win.getComputedStyle(target).getPropertyValue('--pdiff-badge') || '').trim(); } catch (_) { color = ''; }
  if (!color) color = '#C0362C';
  // The frame: inline, because a page is free to style its own ::after and
  // box-shadow on the picked element, and archived sites do exactly that
  // (the carousel caption's `h3 a::after` is a `content: url(...)` arrow
  // that outranked the stylesheet badge). An inline rule cannot be outranked.
  const saved = { outline: null, offset: null, hadStyle: true };
  try {
    // Remembered so the deselect puts the element back exactly: restoring the
    // properties one by one leaves an empty style="" behind on a target that
    // had no inline style at all, and the archive's DOM should come back
    // attribute for attribute.
    saved.hadStyle = target.hasAttribute('style');
    saved.outline = target.style.getPropertyValue('outline');
    saved.offset = target.style.getPropertyValue('outline-offset');
    target.style.setProperty('outline', '2px solid ' + color, 'important');
    target.style.setProperty('outline-offset', '-2px', 'important');
  } catch (_) { /* the class frame still stands */ }
  let badge = null;
  let layer = null;
  let iframe = null;
  try { iframe = win.frameElement || null; } catch (_) { iframe = null; }
  try { layer = paneBadgeLayer(iframe); } catch (_) { layer = null; }
  if (layer) {
    try {
      badge = layer.ownerDocument.createElement('div');
      badge.className = 'pane-badge';
      badge.textContent = '\u25cf  SELECTED';
      badge.style.setProperty('--pdiff-badge', color);
      layer.appendChild(badge);
    } catch (_) {
      badge = null; // the frame still marks it
    }
  }
  const place = () => {
    try {
      if (!badge || !badge.isConnected) return;
      const r = target.getBoundingClientRect();
      const fr = iframe ? iframe.getBoundingClientRect() : null;
      const lr = layer.getBoundingClientRect();
      const dx = fr ? fr.left - lr.left : 0;
      const dy = fr ? fr.top - lr.top : 0;
      // Above the box, overlapping its top edge by a few pixels. Near the
      // pane's own top edge there is no room above it, so the word goes just
      // inside the box rather than over the pane's toolbar.
      const paneTop = dy + r.top;
      badge.style.left = Math.round(Math.max(2, dx + r.left)) + 'px';
      if (paneTop < 18) {
        badge.style.transform = 'none';
        badge.style.top = Math.round(Math.max(2, paneTop + 2)) + 'px';
      } else {
        badge.style.transform = 'translateY(-100%)';
        badge.style.top = Math.round(paneTop - 2) + 'px';
      }
    } catch (_) { /* the frame still marks it */ }
  };
  place();
  try {
    // The two things that move the element under a badge pinned to the pane:
    // the snapshot scrolling, and the pane being resized (which is also how a
    // fold restages the page).
    win.addEventListener('scroll', place, { passive: true, capture: true });
    win.addEventListener('resize', place, { passive: true });
  } catch (_) { /* one stale badge position, never a broken click */ }
  try {
    target.__pdiffSelPaint = { saved, badge, place };
  } catch (_) { /* read-only expando: the class frame still stands */ }
}

// Puts every live badge back where its element now is. The pane's own layout
// keeps moving after a click - every archived image that lands reflows the
// page under the scroll - and the watch loop already re-aims the scroll:
// this is the same pass, straightening the word out with it.
function placeSelectedBadges() {
  [selectedOldTarget, selectedNewTarget].forEach((target) => {
    try {
      const paint = target && target.__pdiffSelPaint;
      if (paint && paint.place) paint.place();
    } catch (_) { /* one stuck badge never blocks the other */ }
  });
}

function unpaintSelected(target) {
  if (!target) return;
  let paint = null;
  try {
    paint = target.__pdiffSelPaint || null;
    delete target.__pdiffSelPaint;
  } catch (_) {
    paint = null;
  }
  if (!paint) return;
  try {
    if (paint.badge && paint.badge.parentNode) paint.badge.parentNode.removeChild(paint.badge);
    if (paint.place) {
      const win = target.ownerDocument ? target.ownerDocument.defaultView : null;
      if (win) {
        try { win.removeEventListener('scroll', paint.place, { capture: true }); } catch (_) { /* gone */ }
        try { win.removeEventListener('resize', paint.place); } catch (_) { /* gone */ }
      }
    }
  } catch (_) { /* navigated away since */ }
  const { saved } = paint;
  try {
    if (saved && saved.outline) target.style.setProperty('outline', saved.outline, 'important');
    else target.style.removeProperty('outline');
  } catch (_) { /* pane gone */ }
  try {
    if (saved && saved.offset) target.style.setProperty('outline-offset', saved.offset, 'important');
    else target.style.removeProperty('outline-offset');
  } catch (_) { /* pane gone */ }
  try {
    if (saved && saved.hadStyle === false && !target.getAttribute('style')) target.removeAttribute('style');
  } catch (_) { /* read-only attribute: the empty one is harmless */ }
}

function unhighlightInPane(target) {
  if (!target) return;
  try { unpaintSelected(target); } catch (_) { /* pane gone */ }
  try { target.classList.remove('pdiff-selected'); } catch (_) { /* pane gone */ }
  try { target.classList.remove('pdiff-beacon'); } catch (_) { /* pane gone */ }
}

function clearSelection() {
  // Layout is deliberately untouched here: a fold stays folded across
  // selections until the next selection asks a layout question of its own
  // (see orientStageForSelection). Nothing inside a pane is ever changed by a
  // selection, so there is nothing to put back here either.
  if (selectedRowEl) selectedRowEl.classList.remove('selected');
  unhighlightInPane(selectedOldTarget);
  unhighlightInPane(selectedNewTarget);
  selectedRowEl = null;
  selectedOldTarget = null;
  selectedNewTarget = null;
  revealedFor = null;
  // A menu opened for the picked row closes with it: the snapshot goes back
  // to the state the crawl recorded.
  closeSelectionReveals();
  // The card that described the picked change goes with the selection.
  try { hideChangeTooltip(); } catch (_) { /* no card */ }
  // There is nothing to put back in the snapshots: a selection never opened a
  // container, overrode a rule or inserted a node. The panes are left exactly
  // as the Archive recorded them, which is the one promise a comparison cannot
  // break.
}


// Marks a pane element as the selected change: the persistent ping ring and
// SELECTED badge (see injectDiffStyles) plus a one-shot beacon flash that
// draws the eye to it the moment it is picked, then removes itself. The
// beacon runs on the element whatever its tag, so even replaced elements
// like <img>, which render no ::after badge, still flash.
function highlightInPane(target) {
  if (!target) return;
  target.classList.add('pdiff-selected');
  // The page's own ::after and box-shadow can outrank the class rules (see
  // paintSelected), so the frame is also written inline and the SELECTED
  // word is drawn in the host page, over the frame. Nothing is inserted
  // into the snapshot itself.
  try { paintSelected(target); } catch (_) { /* the class frame still stands */ }
  target.classList.add('pdiff-beacon');
  setTimeout(() => {
    try { target.classList.remove('pdiff-beacon'); } catch (_) { /* navigated away since */ }
  }, 1300);
}

// Lights up a change's sidebar row (and scrolls to it) without touching
// either pane: used when a followed link navigates its pane away, where no
// pane highlight could survive anyway. Side-aware like the click path, so
// following an unmarked link never spotlights an unrelated row that shares
// the number on the other side's numbering.
function selectRowForMarked(marked, side) {
  if (!marked) return;
  const id = marked.getAttribute('data-pdiff-id');
  const changes = (state.currentDiff && state.currentDiff.changes) || [];
  const idx = (typeof PdiffSelection !== 'undefined' && PdiffSelection.paneChangeIndex)
    ? PdiffSelection.paneChangeIndex(changes, id, side || null)
    : changes.findIndex((c) => c.oldId === id || c.newId === id);
  if (idx < 0) return;
  // A change the switches above had hidden is still a change the reader can
  // reach: they clicked it, so the filter steps aside and the row it selects
  // is a row that is on screen.
  const filtered = changes[idx];
  if (filtered && state.kindFilter.size && !state.kindFilter.has(filtered.type)) clearChangeKindFilter();
  const row = el('changesList').children[idx];
  clearSelection();
  if (row) {
    selectedRowEl = row;
    row.classList.add('selected');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// What the live selection was measured against: the arrangement the stage was
// put in for it, and which panes paint the change there. A selection never
// changes a snapshot - no menu is opened, no style overridden, no band slid -
// so this records which pane is on screen to answer for the change, and which
// one a resize has to re-ask about.
let revealedFor = null; // { change, visibleOld, visibleNew }
// Finds a diffed leaf inside a pane's live document without mutating
// anything, used both for the actual "jump and highlight" action and for
// silently asking "is this thing even visible right now," which is a
// different question (a menu item can be perfectly findable in the DOM
// and still be display:none behind a hamburger button at this width).
function findInPane(iframe, dataId) {
  if (!dataId) return null;
  try {
    const doc = iframe.contentDocument;
    if (!doc) return null;
    const selector = `[data-pdiff-id="${dataId}"]`;
    const hit = doc.querySelector(selector);
    if (hit) return hit;
    // A document.querySelector cannot see into a shadow root. The diff is
    // built from the light DOM, so this is a safety net for a page that
    // assembles a marked subtree inside a component - not the usual path.
    return deepQuerySelector(doc, selector);
  } catch (_) {
    return null; // cross-origin safety net, shouldn't happen with srcdoc
  }
}

function deepQuerySelector(root, selector) {
  let all = null;
  try { all = root.querySelectorAll('*'); } catch (_) { return null; }
  for (const el of Array.from(all || [])) {
    if (!el.shadowRoot) continue;
    let hit = null;
    try { hit = el.shadowRoot.querySelector(selector); } catch (_) { hit = null; }
    if (hit) return hit;
    hit = deepQuerySelector(el.shadowRoot, selector);
    if (hit) return hit;
  }
  return null;
}

// A short, readable tag[#id][.class] label for a node, for naming it in
// plain sentences.
function describeNode(node) {
  let label = node.tagName.toLowerCase();
  if (node.id) label += `#${node.id}`;
  else if (node.classList && node.classList.length) label += `.${Array.from(node.classList).slice(0, 2).join('.')}`;
  return label;
}

// Common naming conventions for the kind of container that's hidden by
// design until some interaction reveals it - a dropdown, a mobile drawer,
// a modal, a tab panel, an accordion. This is read straight off the id and
// class names, which are part of the DOM and always readable no matter
// what CORS says about the stylesheet that actually hides it.
const HIDDEN_CONTAINER_PATTERNS = [
  { re: /sub-?nav|dropdown|submenu|flyout|mega-?menu/i, kind: 'a dropdown submenu', action: 'hovering or clicking' },
  { re: /(^|[-_ ])nav(igation)?([-_ ]|$)|primary-menu|main-menu|site-menu/i, kind: 'a navigation menu', action: 'its own menu control' },
  { re: /mobile|hamburger|offcanvas|drawer|burger/i, kind: 'a mobile navigation drawer', action: 'tapping the menu button (usually only at narrow widths)' },
  { re: /modal|dialog|popup|overlay|lightbox/i, kind: 'a modal or popup', action: 'a specific action elsewhere on the page' },
  { re: /tab-?panel|tab-?content/i, kind: 'a tab panel', action: 'selecting its tab' },
  { re: /accordion|collapse|collapsible/i, kind: 'an accordion panel', action: 'expanding it' },
  { re: /tooltip|popover/i, kind: 'a tooltip or popover', action: 'hovering or focusing its trigger' },
];

function classifyHiddenContainer(node) {
  const idClass = `${node.id || ''} ${(node.className && node.className.toString()) || ''}`;
  for (const p of HIDDEN_CONTAINER_PATTERNS) {
    if (p.re.test(idClass)) return p;
  }
  return null;
}

// Most dropdown/submenu markup follows the same shape: a trigger element
// (an <a> or <button> with visible text, like "SERVICES") sitting right
// next to the hidden container as a sibling under the same parent, e.g.
// <li><a>Services</a><ul id="sub-nav">...</ul></li>. Finding that sibling
// means the explanation can name the exact thing to hover or click,
// instead of describing the hiding mechanism in the abstract.
// Only the control that sits IMMEDIATELY before the container counts, the way
// menus are actually written: <a>Services</a><ul>…</ul> under one <li>. Any
// earlier sibling would do too, and that is how a header's "Skip Navigation
// Links" ended up named as the control that opens a services menu - a
// confident sentence about the wrong element is worse than no name at all.
function findTriggerLabel(hiddenNode) {
  let trigger = null;
  try { trigger = hiddenNode.previousElementSibling; } catch (_) { return null; }
  for (let i = 0; trigger && i < 3; i++, trigger = trigger.previousElementSibling) {
    // A control has to SAY it is one: an aria-expanded, an aria-haspopup, or
    // the aria-controls pointing back at this container. Being the element
    // written before the menu is not enough - a header's skip link sits there
    // too, and naming it would be a confident sentence about the wrong thing.
    let declared = false;
    try {
      declared = trigger.hasAttribute('aria-expanded') || trigger.hasAttribute('aria-haspopup');
    } catch (_) { declared = false; }
    if (!declared) continue;
    let text = '';
    try { text = trigger.textContent.replace(/\s+/g, ' ').trim(); } catch (_) { text = ''; }
    if (text) return text.slice(0, 40);
  }
  return null;
}

// Digs into the *actual, live* stylesheets of the rendered snapshot to
// explain why something is invisible. The DOM-structure read (what kind
// of container is this, what's the trigger) never depends on CORS and
// always has something to say. The CSS-rule lookup - including
// stylesheets fetched through our own backend proxy to get past a missing
// CORS header - is layered on top as a confirming detail when it
// succeeds, but the explanation never dead-ends on "couldn't check" as
// its only answer.
async function explainHiddenness(iframe, dataId) {
  const target = findInPane(iframe, dataId);
  if (!target) return null;

  // Exact path first: the reveal engine names the hiding rule, the reveal
  // rule, and the trigger from the live document, with no guessing. The
  // structural reading below stays as the fallback for environments
  // without it.
  if (typeof PdiffReveal !== 'undefined') {
    let doc, win;
    try {
      doc = iframe.contentDocument;
      win = iframe.contentWindow;
    } catch (_) {
      return null;
    }
    if (doc && win) {
      await waitForHydration(iframe);
      const hydrated = hydratedRulesByDoc.get(doc);
      const analysis = PdiffReveal.analyze(doc, target, hydrated ? hydrated.slice() : [], win);
      if (analysis && !analysis.visible) return PdiffReveal.sentence(analysis, '');
      if (analysis && analysis.visible) return null;
    }
  }

  let win, doc;
  try {
    win = iframe.contentWindow;
    doc = iframe.contentDocument;
  } catch (_) {
    return null;
  }

  let hiddenNode = null;
  let node = target;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 14) {
    const cs = win.getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      hiddenNode = node;
      break;
    }
    node = node.parentElement;
    depth++;
  }

  if (!hiddenNode) {
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return 'Renders at zero size. Typical of a screen reader only label, not a breakpoint.';
    }
    return null; // genuinely visible
  }

  const onSelf = hiddenNode === target;
  const where = onSelf ? '' : `Sits inside ${describeNode(hiddenNode)}. `;
  const classified = classifyHiddenContainer(hiddenNode);
  const trigger = findTriggerLabel(hiddenNode);

  let structural;
  if (classified) {
    structural = `${where}${describeNode(hiddenNode)} looks like ${classified.kind} by its name.`;
    structural += trigger ? ` Likely shown by ${classified.action} "${trigger}".` : ` Likely shown by ${classified.action} its trigger element.`;
  } else if (trigger) {
    structural = `${where}Hidden by CSS. A nearby "${trigger}" element may be what reveals it.`;
  } else {
    const inlineStyle = hiddenNode.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(inlineStyle)) {
      structural = `${where}Hidden by an inline style (style="${inlineStyle.trim()}"), not a stylesheet rule. Likely toggled by JavaScript rather than screen width.`;
    } else {
      structural = `${where}Hidden by CSS, most likely revealed by an interaction (click, hover, or focus) rather than by screen width.`;
    }
  }

  await waitForHydration(iframe);
  const rule = findHidingRule(doc, hiddenNode);
  if (rule && rule !== 'blocked') {
    const ruleDesc = `\`${rule.selectorText} { ${rule.declaration} }\``;
    const cond = describeMediaCondition(rule.mediaText);
    structural += cond ? ` Confirmed: hidden by ${ruleDesc}, but only whenever ${cond}.` : ` Confirmed: hidden by ${ruleDesc}, not tied to screen width at all.`;
  }

  return structural.trim();
}

// Cross-origin stylesheets without CORS headers can't be read through
// document.styleSheets at all. That's the browser enforcing it, not
// something a client-side trick can talk its way around directly - so
// instead, right when a pane finishes loading, this finds every
// stylesheet the browser refuses to let us read, fetches its raw text
// through our own backend (a server-to-server request, which CORS has no
// say over at all), and parses that text with the Constructable
// Stylesheets API into a standalone, unattached CSSStyleSheet object. It's
// never adopted into the live page, so there's no risk of re-applying
// styles or shifting cascade order - it exists purely so its rules are
// queryable the normal way.
const cssProxyCache = new Map(); // href -> Promise<string|null>, shared across reloads
const hydratedRulesByDoc = new WeakMap(); // Document -> array of CSSRuleList
const hydrationPromiseByDoc = new WeakMap(); // Document -> Promise, so callers can wait on it
const settledHydrationPromises = new Set(); // promises (by identity) that already landed

function fetchCssViaProxy(href) {
  if (cssProxyCache.has(href)) return cssProxyCache.get(href);
  // One of the panes' own asset addresses needs no proxying, and proxying it
  // is actively wrong: /api/css would ask the Archive for
  // https://web.archive.org/api/asset?..., which is not an address the Archive
  // has, so every routed stylesheet came back 502 and the reading of rules
  // that depends on it gave up. These are same-origin, so a plain read works.
  const self = (() => { try { return location.origin; } catch (_) { return ''; } })();
  const isOurs = self && /^https?:\/\//i.test(String(href)) && String(href).startsWith(self + '/');
  const p = (isOurs ? fetch(href) : fetch(`/api/css?url=${encodeURIComponent(href)}`))
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  cssProxyCache.set(href, p);
  return p;
}

function waitForHydration(iframe) {
  let doc;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return Promise.resolve();
  }
  if (!doc) return Promise.resolve();
  return hydrationPromiseByDoc.get(doc) || Promise.resolve();
}

function hydrateBlockedStylesheets(iframe) {
  let doc;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return;
  }
  if (!doc || typeof CSSStyleSheet === 'undefined') return;

  const promise = (async () => {
    const blockedHrefs = [];
    Array.from(doc.styleSheets || []).forEach((sheet) => {
      try {
        void sheet.cssRules;
      } catch (_) {
        if (sheet.href) blockedHrefs.push(sheet.href);
      }
    });
    if (!blockedHrefs.length) return;

    const texts = await Promise.all(blockedHrefs.map(fetchCssViaProxy));
    const parsed = [];
    texts.forEach((text, i) => {
      if (!text) return;
      // The href rides along: relative url()s inside these rules are only
      // resolvable against the stylesheet they came from (the reveal
      // clones them into an injected style with a different base).
      const href = blockedHrefs[i];
      parseCssText(text).forEach((list) => parsed.push({ list, href }));
    });
    if (parsed.length) hydratedRulesByDoc.set(doc, parsed);
  })();

  hydrationPromiseByDoc.set(doc, promise);
  // Identity-mark the promise when it lands (either way: even an empty or
  // failed hydration is "done"), so a click can tell synchronously whether
  // the rules it stages from are already complete.
  promise.then(
    () => { settledHydrationPromises.add(promise); },
    () => { settledHydrationPromises.add(promise); }
  );
}

// Whether a pane's proxied rules have already landed. True when there is
// nothing to wait for at all (no document, or no blocked sheets), so the
// only false is "rules still arriving".
function isHydrationSettled(iframe) {
  let doc;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return true;
  }
  if (!doc) return true;
  const p = hydrationPromiseByDoc.get(doc);
  if (!p) return true;
  return settledHydrationPromises.has(p);
}

// A proxied stylesheet, parsed into queryable rule lists. A 200KB archived
// sheet does not always survive replaceSync whole: one exotic rule voids
// the entire sheet. Chunked parsing keeps every rule the parser accepts
// instead of losing the sheet to a single bad line.
function parseCssText(text) {
  const out = [];
  const tryParse = (chunk) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(chunk);
      if (sheet.cssRules && sheet.cssRules.length) out.push(sheet.cssRules);
      return true;
    } catch (_) {
      return false;
    }
  };
  if (!text || typeof CSSStyleSheet === 'undefined') return out;
  if (tryParse(text)) return out;
  let batch = '';
  let batches = 0;
  const flush = () => {
    if (batch && batches < 12) {
      batches++;
      tryParse(batch);
    }
    batch = '';
  };
  String(text).split(/(?<=})/).forEach((part) => {
    batch += part;
    if (batch.length > 20000) flush();
  });
  flush();
  return out;
}

// Hover background pictures start loading once the pane's stylesheets are
// readable, not at first reveal: by the time a dropdown opens, its green
// wash is already in the cache instead of arriving a second late.
function warmPaneBackgrounds(iframe) {
  try {
    waitForHydration(iframe).then(() => {
      let doc = null;
      let win = null;
      try {
        doc = iframe.contentDocument;
        win = iframe.contentWindow;
      } catch (_) {
        return;
      }
      if (!doc || !win || typeof PdiffReveal === 'undefined') return;
      const hydrated = hydratedRulesByDoc.get(doc) || [];
      const urls = PdiffReveal.collectBackgroundUrls(doc, hydrated.slice ? hydrated.slice() : hydrated);
      PdiffReveal.warmUrls(win, urls);
    }).catch(() => { /* warming is best effort */ });
  } catch (_) { /* no DOM here */ }
}

function findHidingRule(doc, element) {
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue;
    }
    if (!rules) continue;
    const hit = searchRulesForHidingMatch(rules, element, null);
    if (hit) return hit;
  }

  const hydrated = hydratedRulesByDoc.get(doc);
  if (hydrated) {
    for (const entry of hydrated) {
      const hit = searchRulesForHidingMatch(entry && entry.list ? entry.list : entry, element, null);
      if (hit) return hit;
    }
    return null; // checked everything we could get to, directly or via proxy - genuinely no match
  }

  // Hydration never ran for this document (still in flight, or every
  // blocked stylesheet's fetch failed outright) and at least one
  // stylesheet threw on direct access - can't say more than that.
  let blocked = false;
  for (const sheet of Array.from(doc.styleSheets || [])) {
    try {
      void sheet.cssRules;
    } catch (_) {
      blocked = true;
      break;
    }
  }
  return blocked ? 'blocked' : null;
}

function searchRulesForHidingMatch(rules, element, mediaText) {
  for (const rule of Array.from(rules)) {
    if (rule.type === CSSRule.MEDIA_RULE) {
      const combined = mediaText ? `${mediaText} and ${rule.media.mediaText}` : rule.media.mediaText;
      const hit = searchRulesForHidingMatch(rule.cssRules, element, combined);
      if (hit) return hit;
    } else if (rule.type === CSSRule.STYLE_RULE) {
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch (_) {
        continue; // unsupported/invalid selector text - skip safely
      }
      if (!matches) continue;
      const display = rule.style.getPropertyValue('display');
      const visibility = rule.style.getPropertyValue('visibility');
      if (display === 'none') return { mediaText, selectorText: rule.selectorText, declaration: 'display: none' };
      if (visibility === 'hidden') return { mediaText, selectorText: rule.selectorText, declaration: 'visibility: hidden' };
    }
  }
  return null;
}

function describeMediaCondition(mediaText) {
  if (!mediaText) return null;
  const maxMatch = mediaText.match(/max-width:\s*([\d.]+)(px|em|rem)/i);
  const minMatch = mediaText.match(/min-width:\s*([\d.]+)(px|em|rem)/i);
  if (maxMatch && minMatch) return `the browser width is between ${minMatch[1]}${minMatch[2]} and ${maxMatch[1]}${maxMatch[2]}`;
  if (maxMatch) return `the browser width is ${maxMatch[1]}${maxMatch[2]} or narrower`;
  if (minMatch) return `the browser width is ${minMatch[1]}${minMatch[2]} or wider`;
  return `this condition is met: \`${mediaText}\``;
}

// What changed about a link is classified on the server, not here, and the
// reason is the archive. Every URL in a capture has been rewritten by the
// Wayback Machine to point into its own web path, so the same link arrives as
// two different strings in two captures, a different timestamp in the prefix,
// and often http in one and https in the other. Classifying those as written
// produced the exact opposite of the truth: "same site, but it now points to a
// different page" for a link that never moved. That classification now happens
// where both snapshots' own bases are known and where it can be tested, in
// lib/urlTarget.js, and each changed attribute arrives here with its sentence
// already written.

const APPEARANCE_PROPS = [
  ['color', 'text color'],
  ['background-color', 'background color'],
  ['font-weight', 'font weight'],
  ['font-size', 'font size'],
  ['text-decoration-line', 'underline / strikethrough'],
  ['font-style', 'italic style'],
];

// Compares the two live, rendered elements directly - real computed
// styles from each snapshot's own CSS, not a guess based on class names.
// Replaced elements (an <img>, a video, a field) have no text, so their
// inherited "text color" and "font size" are not something anyone chose
// for them: reporting those as "appearance changed" on a picture of a
// logo is noise that buries the real change (the file moved). Skipped.
function compareLeafAppearance(oldIframe, oldId, newIframe, newId) {
  const oldEl = findInPane(oldIframe, oldId);
  const newEl = findInPane(newIframe, newId);
  if (!oldEl || !newEl) return [];
  try {
    const tag = (newEl.tagName || oldEl.tagName || '').toLowerCase();
    if (TEXTLESS_TAGS.has(tag)) return [];
  } catch (_) { /* fall through to the comparison */ }
  let winOld, winNew;
  try {
    winOld = oldIframe.contentWindow;
    winNew = newIframe.contentWindow;
  } catch (_) {
    return [];
  }
  const csOld = winOld.getComputedStyle(oldEl);
  const csNew = winNew.getComputedStyle(newEl);
  const diffs = [];
  APPEARANCE_PROPS.forEach(([prop, label]) => {
    const a = csOld.getPropertyValue(prop);
    const b = csNew.getPropertyValue(prop);
    if (a && b && a !== b) diffs.push({ label, before: a, after: b });
  });
  return diffs;
}

// The resolved image URL of a live <img> in a pane, for the tooltip's
// side-by-side thumbnails. Reads the live element (whose src the browser
// already resolved against the snapshot's base), never the raw attribute
// text, and returns '' whenever the pane has navigated away since.
function paneImageSrc(iframe, dataId) {
  const t = findInPane(iframe, dataId);
  if (!t || (t.tagName || '').toLowerCase() !== 'img') return '';
  try {
    return t.currentSrc || t.src || '';
  } catch (_) {
    return '';
  }
}

// The image a *change* is about, on one side: the marked element when the
// pane can show it, otherwise the visible copy of a duplicated element. This
// is what makes the Before thumbnail exist at all for a change the diff
// paired against a hidden duplicate of a repeated image.
function paneImageSrcForChange(iframe, change, side, dataId) {
  let t = findInPane(iframe, dataId);
  if (!t || !isDisplayedInPane(t)) {
    const twin = findVisibleEquivalent(iframe, change, side === 'before' ? 'old' : 'new');
    if (twin) t = twin;
  }
  if (!t || (t.tagName || '').toLowerCase() !== 'img') return '';
  try {
    return t.currentSrc || t.src || '';
  } catch (_) {
    return '';
  }
}

// A live element the reader can actually SEE right now. Two ways a marked
// node can be real and invisible: a clipped carousel band (all but one slide
// are laid out off the visible edge), and a page that repeats an element so
// the marked copy sits behind a collapsed panel while an identical copy sits
// in the open. Selected first, so it is read only for a handful of nodes.
function isDisplayedInPane(el) {
  try {
    const win = el.ownerDocument.defaultView;
    if (!win) return true;
    const cs = win.getComputedStyle(el);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
    // Our own reveal animation starts at opacity 0 (pdiffRevealIn 'from'), so
    // a node caught mid-reveal reads opacity 0 while being perfectly on its
    // way in. That is an animation frame, not a hidden element: treating it
    // as hidden is how a selection ended with neither a scroll nor a light.
    let op = Number(cs.opacity);
    if (op === 0) {
      try {
        if (el.classList && (el.classList.contains('pdiff-reveal-in') || el.classList.contains('pdiff-reveal-out'))) op = 1;
      } catch (_) { /* class read failed: keep the measured value */ }
      if (op === 0) return false;
    }
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return false;
    // Inside a clipped band, "has a box" is not enough: a slide parked past
    // the clip edge measures fine and paints nothing. The item is judged
    // against the clip viewport (the stage frame above the band), never
    // the band's own box: the band translates with its own content, so a
    // band-relative check calls even the shown slide parked once the band
    // has slid, and every downstream visibility read goes wrong with it.
    const track = el.closest ? el.closest('.pal-track') : null;
    if (track) {
      let clip = null;
      try {
        let p = track.parentElement;
        let first = null;
        let guard = 0;
        while (p && p.nodeType === 1 && guard++ < 6) {
          if (!first) first = p;
          let ox = '';
          try { ox = win.getComputedStyle(p).overflowX || ''; } catch (_) { ox = ''; }
          if (ox && ox !== 'visible') { clip = p; break; }
          p = p.parentElement;
        }
        if (!clip) clip = first;
      } catch (_) { clip = null; }
      const frame = (clip || track).getBoundingClientRect();
      if (box.right < frame.left - 2 || box.left > frame.right + 2) return false;
    }
    return true;
  } catch (_) {
    return true; // unreadable: assume visible rather than silently skipping
  }
}

// The copy of a change a person can see, when the copy the diff pointed at is
// not it. Matched on what makes it the same element, the file it points at
// for an image, its words for text, so the visible twin of a duplicated
// element is picked, which is what makes selecting a duplicated change light
// something up instead of scrolling to a hidden copy. Visible or null: a
// hidden match is never returned, because every caller reads non-null as
// "there is something on screen" and a hidden node passed off as visible
// is how selections ended scrolling to and lighting things nobody can see.
function findVisibleEquivalent(iframe, change, side) {
  let doc = null;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return null;
  }
  if (!doc) return null;
  const wantTag = (change.tag || '').toLowerCase();
  if (!wantTag) return null;
  const wantFile = fileNameFromUrl(attrFromChange(change, 'src', side));
  const wantText = String(side === 'old' ? change.before : change.after || '').replace(/\s+/g, ' ').trim();
  // Duplicated leaves share tag and text across distinct containers (the
  // desktop nav and the responsive submenu both holding "News"): a
  // text-only match lets every such row resolve to whichever copy is
  // visible first, so two rows light the same box. Duplicates must also
  // live in the same container as the change's stored path (see
  // PdiffSelection.twinAccepts); without a same-container twin there is
  // no twin, and the caller reveals the marked node itself instead.
  const isDup = !!change.duplicate;
  const livePath = (typeof PdiffSelection !== 'undefined' && PdiffSelection.livePathOf)
    ? PdiffSelection.livePathOf
    : null;
  const accepts = (typeof PdiffSelection !== 'undefined' && PdiffSelection.twinAccepts)
    ? PdiffSelection.twinAccepts
    : null;
  for (const el of Array.from(doc.querySelectorAll('[data-pdiff-id]'))) {
    if ((el.tagName || '').toLowerCase() !== wantTag) continue;
    if (wantFile) {
      const file = fileNameFromUrl(el.getAttribute('src') || el.getAttribute('poster') || '');
      if (file !== wantFile) continue;
    } else if (wantText) {
      if (String(el.textContent || '').replace(/\s+/g, ' ').trim() !== wantText) continue;
    } else {
      continue;
    }
    if (isDup && livePath && accepts) {
      let candPath = '';
      try { candPath = livePath(el); } catch (_) { candPath = ''; }
      try {
        if (!accepts(change.path, candPath, true)) continue;
      } catch (_) { /* fall through to the visibility check */ }
    }
    if (isDisplayedInPane(el)) return el;
  }
  return null;
}

// The node a selection should actually show for a found target. A marked
// <option> inside a closed dropdown has no box: scrolling to it moves
// nothing and highlighting it lights nothing, which reads as "clicking the
// row does nothing". Its <select> is shown instead. Pass-through when the
// helper file failed to load, so selection never depends on it.
function showTarget(t) {
  try {
    if (t && typeof PdiffSelection !== 'undefined' && PdiffSelection.showTargetFor) {
      return PdiffSelection.showTargetFor(t) || t;
    }
  } catch (_) { /* fall through to the node itself */ }
  return t;
}

// Which snapshot pane the reader has hidden for a full-width look.
// Selections never touch a hidden pane: it stays hidden, its in-page
// collapsed sections stay shut, and only the visible pane scrolls.
function collapsedPanes() {
  let panes = null;
  try { panes = el('viewerPanes'); } catch (_) { return { hideOld: false, hideNew: false }; }
  if (!panes) return { hideOld: false, hideNew: false };
  return { hideOld: panes.classList.contains('hide-old'), hideNew: panes.classList.contains('hide-new') };
}

// Does this pane show the change *as itself*, at the width it has now?
//
// This is the question a click has to answer before it can decide whether the
// stage is arranged for the change or against it, and it is narrower than
// "the change is in the document":
//
//   - the node has to be there at all (a page that rebuilds itself as it
//     loads may have dropped the marked subtree - see rescueMarkedTarget);
//   - it has to have a real box (a node inside `display: none` measures zero);
//   - and no ancestor may be hiding it, because `visibility: hidden` and
//     `opacity: 0` still produce a perfectly good box. That is exactly the
//     case that matters: a site's desktop navigation at a phone width is
//     `display: none`, and its phone drawer is `display: none` at a desktop
//     width. The same link exists in both, and which one a reader can see is
//     the *width* answering a media query.
function nodeShowsItself(node) {
  if (!node || node.nodeType !== 1) return false;
  let rects = null;
  try { rects = node.getClientRects(); } catch (_) { return false; }
  if (!rects || !rects.length) return false;
  try {
    const box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    const win = node.ownerDocument.defaultView;
    if (!win) return true;
    let n = node;
    // Bounded: a pathological tree must not turn one click into a long walk.
    for (let depth = 0; n && n.nodeType === 1 && depth < 40; n = n.parentElement, depth++) {
      const cs = win.getComputedStyle(n);
      if (!cs) continue;
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      // A zero-opacity ancestor is invisible content, not a hidden element
      // that a reveal would open - unless it is our own reveal animation, which
      // starts at 0 and is on its way in.
      if (Number(cs.opacity) === 0) {
        try {
          if (!(n.classList && (n.classList.contains('pdiff-reveal-in') || n.classList.contains('pdiff-reveal-out')))) return false;
        } catch (_) { return false; }
      }
      if (n === node.ownerDocument.body) break;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function changeShowsInPane(iframe, change, side) {
  const id = side === 'old' ? change.oldId : change.newId;
  if (!id) return false;
  if (nodeShowsItself(findInPane(iframe, id))) return true;
  // The marked node can be hidden while the same thing is painted elsewhere in
  // the same document - a navigation copied into a phone drawer, a link
  // repeated in a footer. A real copy on screen is the change as the page
  // ships it, so it counts, and it is what gets scrolled to and lit.
  try {
    const twin = findVisibleEquivalent(iframe, change, side);
    if (twin && isDisplayedInPane(twin)) return true;
  } catch (_) { /* no twin: the marked node is the whole answer */ }
  return false;
}

// Lays the stage out in an arrangement with no animation, then makes the
// browser resolve both frames at that width. A frame reflows against its new
// width - media queries included - when something asks it for a box, so the
// question asked straight after this one is answered by the layout that will
// be painted, not by the width the pane had a moment ago.
//
// `folded` names the snapshot that is folded AWAY (the argument
// setSinglePaneView takes, the same one the hide buttons pass); null is the
// pair. Giving a snapshot the stage means folding the other one away.
function arrangeStage(folded) {
  const panes = el('viewerPanes');
  panes.classList.add('pane-instant');
  setSinglePaneView(folded === undefined ? null : folded, { instant: true });
  try { document.body.getBoundingClientRect(); } catch (_) { /* nothing to settle */ }
  ['paneOld', 'paneNew'].forEach((id) => {
    try {
      const doc = el(id).contentDocument;
      if (!doc) return;
      if (doc.documentElement) doc.documentElement.getBoundingClientRect();
      if (doc.body) doc.body.getBoundingClientRect();
    } catch (_) { /* a frame that will not answer answers nothing */ }
  });
  return panes;
}

// The width each pane's page is laid out at. A reveal restages the page's own
// rules, and those rules are written per width: the hover that opens a bar's
// dropdown is not the hover that opens the phone menu. So a selection that
// resizes a pane has to perform the interaction again where it ended up (see
// applySelectionReveals).
function paneContentWidths() {
  const out = { old: 0, new: 0 };
  ['old', 'new'].forEach((side) => {
    try {
      const win = el(side === 'old' ? 'paneOld' : 'paneNew').contentWindow;
      out[side] = win ? win.innerWidth : 0;
    } catch (_) {
      out[side] = 0; // a frame that cannot be read has no width to compare
    }
  });
  return out;
}

// What a selection does with a change the page keeps shut.
//
// The answer is the page's own interaction, performed. If the page's rules say
// a menu opens under `li:hover`, the app puts that menu in the state a hover
// puts it in - the hover rules restaged on the opener, the item styled by the
// page's own CSS - and leaves it open while the row stays selected. That is
// the change shown in the dropdown, exactly as a person would have found it.
// A change that only a script could reveal is a different case: nothing is
// forced on screen for it, because a link the capture never painted must not
// appear as if it had been.
//
// So the engine is asked "what does a person do, and on what, to see it?" The
// page's own rules answer that - a `:hover` on a named control, a `.open`
// state class, a viewport width - and the click performs the interaction or
// widens the stage, rather than printing the answer on the card and stopping.
function revealPlanFor(iframe, change, side) {
  const id = side === 'old' ? change.oldId : change.newId;
  if (!id || typeof PdiffReveal === 'undefined' || !iframe) return null;
  let doc = null;
  let win = null;
  try {
    doc = iframe.contentDocument;
    win = iframe.contentWindow;
  } catch (_) { return null; }
  if (!doc || !win || !doc.body) return null;
  const marked = findInPane(iframe, id);
  if (!marked) return null;
  let analysis = null;
  try {
    const hydrated = hydratedRulesByDoc.get(doc);
    analysis = PdiffReveal.analyze(doc, marked, hydrated ? hydrated.slice() : [], win);
  } catch (_) { return null; }
  if (!analysis || analysis.visible) return null;
  const best = analysis.best || null;
  const trigger = (best && best.trigger && best.trigger.node) || null;
  const selector = (best && best.selectorText) || '';
  // The page's rules name an interaction (hover, focus, press, a state
  // class). Only those can be performed; a bare stylesheet hiding with no
  // rule that ever shows it again is not an interaction to restage.
  let interactive = !!(best && (best.interactive || (best.states && best.states.length)));
  // An unconditional hiding ABOVE the rule the engine found can never be
  // lifted by the interaction that rule describes. The 2015 capture's
  // "Activity" link is exactly this: its submenu has a `:hover` rule, but the
  // whole nav copy it sits in is `display: none` with no width in the rule,
  // so hovering opens a box that is still gone - no visitor ever saw it. The
  // engine names the nearest hiding rule only, so the chain above it is
  // checked here and the interaction is dropped as unreachable.
  let blocked = null;
  try {
    const hydrated = hydratedRulesByDoc.get(doc);
    let up = analysis.hiddenNode && analysis.hiddenNode.parentElement;
    let guard = 0;
    while (up && up.nodeType === 1 && up !== doc.body && guard++ < 40) {
      const cs = win.getComputedStyle(up);
      const hidden = !!(cs && (cs.display === 'none' ||
        cs.visibility === 'hidden' || cs.visibility === 'collapse'));
      if (hidden) {
        let rule = null;
        try { rule = PdiffReveal.hidingRule(doc, up, hydrated ? hydrated.slice() : []); } catch (_) { rule = null; }
        if (!rule || !rule.mediaText) {
          blocked = {
            desc: (PdiffReveal.shortDescribe ? PdiffReveal.shortDescribe(up) : String(up.tagName || '').toLowerCase()),
            declaration: (rule && rule.declaration) || (cs.display === 'none' ? 'display: none' : 'visibility: ' + cs.visibility),
          };
          break;
        }
      }
      up = up.parentElement;
    }
  } catch (_) { blocked = null; }
  if (blocked) interactive = false;
  // Nothing the page can do at any width or interaction shows this. It is the
  // leftover hidden markup the snapshot leaves exactly as recorded; the row's
  // card explains it and clicking it is allowed to do nothing.
  const neverShows = !interactive && !analysis.responsive &&
    (!!blocked || !(analysis.candidates && analysis.candidates.length));
  // The verb is the page's own vocabulary, read off the selector: a `:hover`
  // rule is hovered, a `:focus-within` is focused, a state class is clicked.
  let verb = '';
  if (/:hover/i.test(selector)) verb = 'Hover';
  else if (/focus-within|:focus/i.test(selector)) verb = 'Focus';
  else if (/:active/i.test(selector)) verb = 'Press';
  else if (best && best.states && best.states.length) verb = 'Click';
  return {
    analysis,
    selector,
    declarations: (best && best.declarations) || [],
    trigger,
    triggerLabel: (best && best.trigger && best.trigger.label) || '',
    verb,
    interactive,
    blocked,
    neverShows,
    responsive: !!analysis.responsive && !blocked,
    paneWidth: analysis.paneWidth,
  };
}

// The opens a selection owns: the menus it restaged, one per pane, so the
// dropdown can be put back the moment the row is deselected or another row is
// picked. Nothing here outlives the selection.
let activeReveals = [];

function closeSelectionReveals() {
  const receipts = activeReveals;
  activeReveals = [];
  receipts.forEach((receipt) => {
    try { if (receipt && receipt.undo) receipt.undo(true); } catch (_) { /* pane gone */ }
  });
}

// Performs the page's own interaction for one change in one pane, and only
// when the page's rules name one. Returns the element the interaction was
// performed for, or null when the page has no interaction to perform.
function performSelectionReveal(iframe, change, side) {
  if (!iframe || typeof PdiffReveal === 'undefined' || !PdiffReveal.applyReveal) return null;
  let plan = null;
  try { plan = revealPlanFor(iframe, change, side); } catch (_) { plan = null; }
  // No interaction, or one the viewport owns: nothing is restaged here. A
  // viewport hiding gets its wide layout first, and a change no rule of the
  // page ever shows is left exactly as the Archive recorded it (see
  // applySelectionReveals).
  if (!plan || !plan.interactive || plan.responsive) return null;
  let doc = null;
  let win = null;
  try {
    doc = iframe.contentDocument;
    win = iframe.contentWindow;
  } catch (_) { return null; }
  if (!doc || !win) return null;
  let receipt = null;
  try { receipt = PdiffReveal.applyReveal(doc, win, plan.analysis); } catch (_) { receipt = null; }
  if (!receipt) return null;
  activeReveals.push(receipt);
  return (plan.analysis && (plan.analysis.hiddenNode || plan.analysis.target)) || null;
}

// Brings the slide a change lives on into the carousel's window.
//
// A carousel is one picture wide and holds a dozen: the changed image is in
// the document with a real box, parked outside the band's clip, which is
// exactly the state the page itself starts in. Marking the band instead was
// the ugly answer - a selection outline around the whole strip, with the
// picture the reader asked for still nowhere on screen. The band is moved to
// the change's own slide (the page's own arithmetic, see
// PdiffSelection.moveCarouselToNode), so the element marked is the element
// that was diffed. The move is recorded and undone when the row is
// deselected; a slide already in the window is left where the reader found
// it.
function revealCarouselSlide(iframe, change, side) {
  if (!iframe || typeof PdiffSelection === 'undefined' || !PdiffSelection.moveCarouselToNode) return null;
  const id = side === 'old' ? change.oldId : change.newId;
  let node = null;
  try { node = id ? findInPane(iframe, id) : null; } catch (_) { node = null; }
  // The page rewrote the marked subtree away: the same search the scroll path
  // uses still finds the change by its text, file, path or neighbours.
  if (!node) {
    try { node = rescueMarkedTarget(iframe, change, side); } catch (_) { node = null; }
  }
  if (!node || !node.closest) return null;
  let track = null;
  let box = null;
  try {
    track = node.closest('.pal-track');
    box = track ? node.getBoundingClientRect() : null;
  } catch (_) { return null; }
  // No band, no box, or already in the window: nothing to move.
  if (!track || !box || !box.width || !box.height) return null;
  try { if (isDisplayedInPane(node)) return null; } catch (_) { /* move it */ }
  let receipt = null;
  try { receipt = PdiffSelection.moveCarouselToNode(node, { instant: true }); } catch (_) { receipt = null; }
  if (!receipt) return null;
  activeReveals.push(receipt);
  return node;
}

// The menus a selected change lives in, opened the way the page opens them,
// and the carousel band moved to the change's slide, before the stage is
// measured. Nothing is opened for a pane that is folded away, and nothing is
// opened for a change no interaction of the page reveals: that case is simply
// never shown, because no visitor ever saw it either.
function openMenusForSelection(c) {
  closeSelectionReveals();
  if (!c) return;
  let hideOld = false;
  let hideNew = false;
  try { ({ hideOld, hideNew } = collapsedPanes()); } catch (_) { /* both live */ }
  if (!hideOld) {
    performSelectionReveal(el('paneOld'), c, 'old');
    revealCarouselSlide(el('paneOld'), c, 'old');
  }
  if (!hideNew) {
    performSelectionReveal(el('paneNew'), c, 'new');
    revealCarouselSlide(el('paneNew'), c, 'new');
  }
}

// One arrangement, fully settled: the stage is laid out with no animation and
// the frames are reflowed at the width they now have. Returns which snapshots
// paint the change there. Nothing is opened and nothing is overridden: a
// change the page keeps shut is reported as not painted, and the click then
// points at the control that opens it (see revealPlanFor).
//
// `folded` is the snapshot folded away (null = the pair).
function selectionAttempt(folded, c) {
  arrangeStage(folded);
  const visible = { old: false, new: false };
  const { hideOld, hideNew } = collapsedPanes();
  const live = { old: !hideOld, new: !hideNew };
  const carries = { old: !!c.oldId, new: !!c.newId };
  ['old', 'new'].forEach((side) => {
    if (!carries[side] || !live[side]) return;
    const iframe = el(side === 'old' ? 'paneOld' : 'paneNew');
    // Painted here, or not. The answer is read from the page as it is, never
    // made true by opening or restyling anything.
    visible[side] = changeShowsInPane(iframe, c, side);
  });
  return visible;
}

// Which snapshot paints the change, and the arrangement that gets it painted.
//
// A change can be present in a snapshot and painted nowhere: it lives in a
// menu the page ships closed, or in an orientation - a desktop bar the phone
// layout drops - that this pane is not showing. So a click asks the stage, in
// this order:
//
//   1. does the pair paint it? Then nothing is rearranged. This is the rule a
//      re-saved picture taught: a change already on screen never moves the
//      comparison around;
//   2. if not, does the wide layout paint it? Then the other snapshot is
//      folded away and the one holding the change takes the stage - a drawer
//      that only exists wide, or a nav the narrow layout drops, is reached by
//      the width it was designed for, not by forcing anything open;
//   3. if no width paints it either, the pair stays and nothing is forced
//      into view. This is leftover hidden markup - the 2015 settlement.org
//      "Activity" link lives in a nav copy the stylesheet drops at every
//      width, so no visitor ever saw it, and opening it would show the reader
//      a page that never existed. The row still selects and its card explains
//      why there is nothing to see.
//
// A selection rearranges width, and may open a container the page's own rules
// open. It never invents a style for the change and never opens a different
// container near it: the marked node is always the node that was diffed, or
// nothing at all.
//
// `moved` reports whether the stage was rearranged, `fold` which snapshot took
// it. `opts.measure === false` only re-reads the arrangement as it stands: a
// resize re-asks the question at the new width and never rearranges.
function orientStageForSelection(c, opts) {
  const visible = { old: false, new: false };
  const plain = { moved: false, visible, fold: null };
  const measure = !(opts && opts.measure === false);
  const carries = { old: !!c && !!c.oldId, new: !!c && !!c.newId };
  const showsAll = (v) => (!carries.old || v.old) && (!carries.new || v.new);
  const assign = (from) => { visible.old = !!from.old; visible.new = !!from.new; return visible; };
  if (!c) {
    releaseInstant(null);
    return plain;
  }
  // A snapshot the reader folded by hand is their arrangement, not a question,
  // and a restage after a resize only re-reads what is already on screen.
  if (manualPane || !measure) {
    try {
      visible.old = carries.old && changeShowsInPane(el('paneOld'), c, 'old');
      visible.new = carries.new && changeShowsInPane(el('paneNew'), c, 'new');
    } catch (_) { /* a pane that cannot be read paints nothing */ }
    releaseInstant(null);
    return plain;
  }
  // 1: the pair, read as it is.
  let last = { folded: null, visible: selectionAttempt(null, c) };
  if (showsAll(last.visible)) {
    releaseInstant(el('viewerPanes'));
    return plain;
  }
  // 3: only a layout the page itself paints the change in is worth folding
  // for. A menu the page ships shut is shut at every width.
  const other = (side) => (side === 'old' ? 'new' : 'old');
  const wide = { old: false, new: false };
  ['old', 'new'].forEach((side) => {
    if (!carries[side] || last.visible[side]) return;
    last = { folded: other(side), visible: selectionAttempt(other(side), c) };
    wide[side] = !!last.visible[side];
  });
  // The later snapshot answers for the pair when both wide layouts paint the
  // change, and one restore click hands the stage back to both.
  const fold = wide.new ? 'new' : (wide.old ? 'old' : null);
  const wanted = fold ? other(fold) : null;
  // 4 and the settle: the arrangement that wins owns the opens it made.
  if (last.folded !== wanted) last = { folded: wanted, visible: selectionAttempt(wanted, c) };
  assign(last.visible);
  releaseInstant(el('viewerPanes'));
  return { moved: !!fold, visible, fold };
}

// Turns the grid's animation back on for the next arrangement, one frame after
// the measurement above has been taken. Deferred so the layout the browser
// paints is the final one, and never mid-transition.
function releaseInstant(panes) {
  const node = panes || (function () { try { return el('viewerPanes'); } catch (_) { return null; } })();
  if (!node) return;
  try {
    requestAnimationFrame(() => { try { node.classList.remove('pane-instant'); } catch (_) { /* gone */ } });
  } catch (_) {
    try { node.classList.remove('pane-instant'); } catch (_) { /* gone */ }
  }
}

// Centers a node inside its own snapshot pane without moving the outer
// page. Element.scrollIntoView bubbles through every scrollable ancestor
// including the host page, which is how picking a change used to yank the
// whole comparison up or down a few pixels. Scrolling the pane's own
// scroller directly only ever moves that pane.
//
// The scroller is looked up, never assumed: archived pages routinely pin
// <html> at viewport height with overflow hidden, leaving <body> — or an
// inner panel — as the element that actually scrolls. win.scrollTo is a
// silent no-op there, which is how picking a change left both panes parked
// at the top while the element sat hundreds of pixels below them.
function scrollInnerCentered(node, opts) {
  if (!node) return;
  const instant = !!(opts && opts.instant);
  const behavior = instant ? 'instant' : 'smooth';
  const centerMath = (typeof PdiffSelection !== 'undefined' && PdiffSelection.computeCenteredScroll) ||
    ((scrollPos, targetStart, boxStart, targetSize, viewSize) =>
      Math.max(0, scrollPos + (targetStart - boxStart) - Math.max(0, viewSize / 2 - targetSize / 2)));
  const canReach = (typeof PdiffSelection !== 'undefined' && PdiffSelection.canReachScroll) ||
    ((scrollHeight, clientHeight, top) => top <= Math.max(0, scrollHeight - clientHeight) + 1);
  try {
    const doc = node.ownerDocument;
    const win = doc ? doc.defaultView : null;
    let boxes = [];
    try {
      let n = node.parentNode;
      while (n && n !== doc) {
        // Taller than its frame is not enough: overflow:visible boxes (a
        // dropdown spilling out of its nav item) report a huge scrollHeight
        // but take no scroll position, so setting one is a silent no-op that
        // would strand the scroll below the real scroller. Only ancestors
        // that actually clip (auto, scroll or hidden) are candidates, and
        // nearest goes first.
        //
        // Both axes, because a rail scrolls sideways: a card strip wider
        // than its viewport is the only thing that can move a card parked
        // past the right edge, and the vertical-only walk never saw it. A
        // target in such a strip was scrolled to the right row and left
        // hanging off the side of the pane (measured on nytimes.com's 2026
        // homepage, a U.S. section link at x -179).
        if (n.nodeType === 1) {
          let oy = '';
          let ox = '';
          try {
            if (win) {
              const cs = win.getComputedStyle(n);
              oy = cs.overflowY || '';
              ox = cs.overflowX || '';
            }
          } catch (_) { oy = ''; ox = ''; }
          const canY = oy !== 'visible' && n.scrollHeight > n.clientHeight + 1;
          const canX = ox !== 'visible' && n.scrollWidth > n.clientWidth + 1;
          if (canY || canX) boxes.push({ box: n, canY, canX });
        }
        n = n.parentNode;
      }
    } catch (_) { boxes = []; }
    // A nested clipping box (a carousel viewport, a panel) accepts any
    // scrollTo and clamps it to its own small range: handing it a page
    // scroll strands the pane exactly where it was, with the light sitting
    // on something nobody can see. So the nearest box whose range actually
    // reaches the target carries it, never the nearest box regardless.
    for (const entry of boxes) {
      const box = entry.box;
      // The document's own scrolling element is not a box: <html> moves with
      // the window, so its rect top is already -scrollY, and centering against
      // it counts the scroll twice. Measured on apple.com: a pick from a pane
      // already scrolled 4,464px asked for 8,928px — the whole page below the
      // element — so the click "went nowhere" with the light stranded
      // thousands of pixels off screen. The window branch below is that
      // case's scroller.
      //
      // Only that element, though: a <body> that carries the page's own
      // scroll (settlement.org pins <html> at viewport height and lets body
      // scroll its 6,710px of content) keeps a fixed rect top while its
      // scrollTop moves, so it is a box like any other, and skipping it left
      // the pane parked at the top of the page.
      let isDocScroller = false;
      try {
        isDocScroller = box === doc.scrollingElement || box === doc.documentElement;
      } catch (_) { isDocScroller = false; }
      if (isDocScroller) continue;
      const r = node.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      let top = box.scrollTop;
      let left = box.scrollLeft;
      let doY = false;
      let doX = false;
      if (entry.canY) {
        const want = centerMath(box.scrollTop, r.top, br.top, r.height, box.clientHeight);
        if (canReach(box.scrollHeight, box.clientHeight, want)) { top = want; doY = true; }
      }
      if (entry.canX) {
        const want = centerMath(box.scrollLeft, r.left, br.left, r.width, box.clientWidth);
        if (canReach(box.scrollWidth, box.clientWidth, want)) { left = want; doX = true; }
      }
      // Nothing this box can do for either axis: the next one gets its turn.
      if (!doY && !doX) continue;
      let before = 0;
      let beforeX = 0;
      try { before = box.scrollTop; } catch (_) { before = 0; }
      try { beforeX = box.scrollLeft; } catch (_) { beforeX = 0; }
      try { box.scrollTo({ top, left, behavior }); }
      catch (_) { try { box.scrollTop = top; box.scrollLeft = left; } catch (__) { /* pane gone */ } }
      // A box that reports a huge scrollHeight but paints nothing scrollable
      // accepts the scroll and stays exactly where it was (measured on
      // apple.com's 2026 homepage: a wrapper swallowed every attempt while
      // the element sat 1,700px above the pane). The scroll only counts if
      // the pane or the element actually moved; otherwise the next
      // candidate - and finally the window - gets its turn.
      if (!instant) return;
      let after = before;
      let afterX = beforeX;
      let moved = false;
      try { after = box.scrollTop; } catch (_) { after = before; }
      try { afterX = box.scrollLeft; } catch (_) { afterX = beforeX; }
      try {
        const r2 = node.getBoundingClientRect();
        moved = Math.abs(r2.top - r.top) > 2 || Math.abs(r2.left - r.left) > 2;
      } catch (_) { moved = false; }
      if (moved || Math.abs(after - before) > 2 || Math.abs(afterX - beforeX) > 2) return;
    }
    if (doc && win && win.scrollTo) {
      const r = node.getBoundingClientRect();
      const vh = win.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 0;
      const vw = win.innerWidth || (doc.documentElement && doc.documentElement.clientWidth) || 0;
      const top = centerMath(win.scrollY || (doc.documentElement && doc.documentElement.scrollTop) || 0, r.top, 0, r.height, vh);
      const left = centerMath(win.scrollX || (doc.documentElement && doc.documentElement.scrollLeft) || 0, r.left, 0, r.width, vw);
      win.scrollTo({ top, left, behavior });
      if (!instant) return;
      // The window is not always the scroller even when it accepted the
      // call: an archived page that turns its root into an overflow:hidden
      // box (apple.com's 2015 footer does exactly that) parks scrollY at 0
      // and ignores every scrollTo from then on, while <html>.scrollTop
      // still moves. Move the element scrollers in person when the call
      // changed nothing, and stop at the first one that takes.
      let moved = false;
      try {
        const r2 = node.getBoundingClientRect();
        moved = Math.abs(r2.top - r.top) > 2 || Math.abs(r2.left - r.left) > 2;
      } catch (_) { moved = false; }
      if (moved) return;
      for (const scroller of [doc.documentElement, doc.body]) {
        if (!scroller) continue;
        try {
          scroller.scrollTop = top;
          scroller.scrollLeft = left;
        } catch (_) { continue; }
        try {
          const r3 = node.getBoundingClientRect();
          if (Math.abs(r3.top - r.top) > 2 || Math.abs(r3.left - r.left) > 2) return;
        } catch (_) { return; }
      }
      return;
    }
  } catch (_) { /* fall through to scrollIntoView */ }
  try {
    node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } catch (_) {
    try { node.scrollIntoView(); } catch (__) { /* pane gone */ }
  }
  try {
    const ox = window.scrollX || window.pageXOffset || 0;
    const oy = window.scrollY || window.pageYOffset || 0;
    window.scrollTo(ox, oy);
  } catch (_) { /* outer page keeps its place best-effort */ }
}

// A box a reader can actually see the change in: the same test as any box,
// with a floor under it. An empty <a> around a broken archived image keeps a
// 0x17 sliver of a box, and lighting that sliver instead of the card or row
// that holds it is a click that scrolls to and marks nothing visible
// (measured on settlement.org's old social bar: an <a> 0px wide). Whole-box
// fallbacks walk past slivers now; anything the change itself is the direct
// target of is still accepted at any size.
function usableBox(node) {
  try {
    const r = node.getBoundingClientRect();
    return r.width >= 12 && r.height >= 12;
  } catch (_) {
    return false;
  }
}

// Both axes have ink. A zero-width link in a horizontally scrolled rail (or
// a zero-height inline in a collapsed row) is laid out, styled, and paints
// nothing at all: lighting it marks an invisible sliver, which is the same
// dead click as naming nothing. One axis at zero is what tells the scroll
// path to look for the container that holds it instead, so use this - never
// the width-or-height test - for the node the reader is being shown.
function hasFullBox(node) {
  try {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (_) {
    return false;
  }
}

// A box a person can actually read off the screen. Screen-reader-only text
// is everywhere on modern pages (a hidden <h1>, a clipped label span), it
// measures a 1x1 or 0-height box, and a badge on that is a click that lights
// nothing anyone can see. Anything under a few pixels goes up to the region
// that holds it instead, which is the honest answer for text the page never
// shows. Small real things - a 10px icon, a one-line link - stay themselves.
function readableBox(node) {
  try {
    const r = node.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  } catch (_) {
    return false;
  }
}

// Whether a node has any box at all to scroll to. display:none nodes
// measure zero; scrolling to one computes a garbage position out of a zero
// rect and lands the pane somewhere random, which reads as broken. This is
// the only visibility test the scroll path uses: anything with a box can be
// centered usefully, even mid-reveal-animation or visibility:hidden, while a
// boxless node is skipped rather than jumped to blindly.
function hasBoxInPane(node) {
  try {
    if (!node || node.nodeType !== 1) return false;
    const r = node.getBoundingClientRect();
    return !!(r.width || r.height);
  } catch (_) {
    return false;
  }
}

// A node that has a box and still paints nothing: it is laid out past the
// edge of a clipping ancestor that cannot scroll to bring it back. The
// archived page's own scripts do this under a selection — the nav script
// collapses the menu a marked link sits in, and the link keeps its class and
// its badge while measuring 0x0, which is a click that scrolls nowhere and
// lights nothing the reader can see (measured on apple.com: the link
// measured 101x14 when it was picked and 0x0 seven hundred milliseconds
// later).
function isClippedOutOfPane(node) {
  try {
    if (!node || node.nodeType !== 1) return false;
    const doc = node.ownerDocument;
    const win = doc ? doc.defaultView : null;
    const r = node.getBoundingClientRect();
    // A rail that clips past the pane's right edge is not out of reach when
    // the pane itself can scroll sideways to it: the clip moves with the
    // page, so nytimes.com's card rails are opened by the horizontal scroll
    // the pane already has. Only a clip the pane cannot undo counts.
    let vw = 0;
    let vh = 0;
    try {
      vw = win.innerWidth || 0;
      vh = win.innerHeight || 0;
    } catch (_) { vw = 0; vh = 0; }
    let maxX = 0;
    let maxY = 0;
    try {
      const se = doc.scrollingElement || doc.documentElement;
      maxX = Math.max(0, (se.scrollWidth || 0) - vw);
      maxY = Math.max(0, (se.scrollHeight || 0) - vh);
    } catch (_) { maxX = 0; maxY = 0; }
    let curX = 0;
    let curY = 0;
    try {
      curX = win.scrollX || (doc.documentElement && doc.documentElement.scrollLeft) || 0;
      curY = win.scrollY || (doc.documentElement && doc.documentElement.scrollTop) || 0;
    } catch (_) { curX = 0; curY = 0; }
    // The room left in one direction, not just the room to the end: a box
    // above the fold is brought in by scrolling up, and the page parked at
    // the top has none of that room no matter how long it is. Reading the
    // room as "scrollHeight minus what is scrolled" made every box left of
    // the pane look reachable, because a wide page has room to the right.
    const paneRoom = (axis, back) => {
      if (axis === 'x') return back ? curX : Math.max(0, maxX - curX);
      return back ? curY : Math.max(0, maxY - curY);
    };
    // How far the pane must travel to bring *some* of the box in, measured
    // from the near edge: a two-thousand-pixel column below the fold needs
    // only its top brought on screen, not its bottom. A box that already
    // straddles an edge needs no travel at all.
    const edgeNeed = (axis) => {
      const size = axis === 'x' ? r.width : r.height;
      const view = axis === 'x' ? vw : vh;
      const start = axis === 'x' ? r.left : r.top;
      const end = axis === 'x' ? r.right : r.bottom;
      const near = Math.min(6, size);
      if (end <= 0) return { need: -end + near, back: true };
      if (start >= view) return { need: start - view + near, back: false };
      return { need: 0, back: false };
    };
    const paneReaches = (axis) => {
      const { need, back } = edgeNeed(axis);
      return need <= paneRoom(axis, back) + 1;
    };
    // An ancestor that scrolls on that axis, with room in the needed
    // direction, is a way to bring the box in even when the pane is not.
    const scrollerReaches = (axis, need, back) => {
      let a = node.parentNode;
      let depth = 0;
      while (a && a !== doc && depth++ < 80) {
        if (a.nodeType === 1) {
          let ov = '';
          try { ov = win.getComputedStyle(a)[axis === 'x' ? 'overflowX' : 'overflowY'] || ''; } catch (_) { ov = ''; }
          if (ov && ov !== 'visible') {
            const extent = axis === 'x' ? a.scrollWidth : a.scrollHeight;
            const inner = axis === 'x' ? a.clientWidth : a.clientHeight;
            const max = Math.max(0, extent - inner);
            if (max > 0) {
              const pos = axis === 'x' ? a.scrollLeft : a.scrollTop;
              const room = back ? pos : Math.max(0, max - pos);
              if (need <= room + 1) return true;
            }
          }
        }
        a = a.parentNode;
      }
      return false;
    };
    // A box entirely past an edge of the pane, on a side nothing can scroll
    // toward, is out of reach even when no ancestor clips it. nytimes.com's
    // 2026 mini nav is the case: a section link painted at x -179 in a pane
    // parked at x 0, every overflow visible, in a page whose only sideways
    // room is to the right (743px of content in a 514px pane). No scroll and
    // no clip could bring it back, so the bar holding it is what the reader
    // gets - not a badge on a box that is not there.
    if (r.width || r.height) {
      const sides = [
        ['x', r.left < 0 && r.right <= 0],
        ['x', r.left >= vw],
        ['y', r.top < 0 && r.bottom <= 0],
        ['y', r.top >= vh],
      ];
      for (const [axis, beyond] of sides) {
        if (!beyond) continue;
        const { need, back } = edgeNeed(axis);
        if (need <= paneRoom(axis, back) + 1) continue;
        if (scrollerReaches(axis, need, back)) continue;
        return true;
      }
    }
    let n = node.parentNode;
    let guard = 0;
    while (n && n !== doc && guard++ < 60) {
      if (n.nodeType === 1) {
        let oy = '';
        let ox = '';
        try {
          const cs = win.getComputedStyle(n);
          oy = cs.overflowY || '';
          ox = cs.overflowX || '';
        } catch (_) { oy = ''; ox = ''; }
        const clipsY = !!oy && oy !== 'visible';
        const clipsX = !!ox && ox !== 'visible';
        if (clipsY || clipsX) {
          const nr = n.getBoundingClientRect();
          // Only a box that cannot be scrolled to is out of reach: a pane
          // taller than its frame is the ordinary case, and the selection
          // exists to scroll it.
          const reachY = !clipsY || (n.scrollHeight > n.clientHeight + 1 && oy !== 'hidden');
          const reachX = !clipsX || (n.scrollWidth > n.clientWidth + 1 && ox !== 'hidden');
          let outY = clipsY && !reachY && (r.bottom < nr.top + 1 || r.top > nr.bottom - 1);
          let outX = clipsX && !reachX && (r.right < nr.left + 1 || r.left > nr.right - 1);
          if (outY && paneReaches('y')) outY = false;
          if (outX && paneReaches('x')) outX = false;
          if (outY || outX) return true;
        }
      }
      n = n.parentNode;
    }
  } catch (_) { /* unreadable: never claim a node is out of reach */ }
  return false;
}

// The nearest ancestor a reader can actually see: on screen, inside its own
// clippers, with a box to scroll to and mark. This is where a selection falls
// back to when the marked node itself paints nothing (see
// isClippedOutOfPane) — the container that holds it, rather than a badge on a
// zero-box element nobody can see.
function showableAncestorFor(node, anySize) {
  try {
    const doc = node.ownerDocument;
    const win = doc ? doc.defaultView : null;
    let paneW = 0;
    let paneH = 0;
    try {
      paneW = win.innerWidth || (doc.documentElement && doc.documentElement.clientWidth) || 0;
      paneH = win.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 0;
    } catch (_) { paneW = 0; paneH = 0; }
    let n = node.parentNode;
    let guard = 0;
    while (n && n !== doc && guard++ < 80) {
      if (n.nodeType === 1 && n !== doc.body && n !== doc.documentElement &&
          isDisplayedInPane(n) && !isClippedOutOfPane(n)) {
        // A container the size of the whole pane is the page, not the
        // change: naming it marks everything and scrolls nowhere, which is
        // the same dead click as naming nothing at all. A sliver is the
        // other failure: a broken archived image leaves its <picture> at a
        // few pixels wide, and lighting that is a badge on nothing visible.
        // Both are walked past, up to the card or row that actually holds
        // the change.
        let fits = true;
        try {
          const r = n.getBoundingClientRect();
          fits = r.width >= 12 && r.height >= 12;
          // A container the size of the pane is normally the page rather than
          // the change. Unless the change inside it cannot be reached any
          // other way (anySize, see pinnedOffscreen): then the overlay it sits
          // in is the answer, big though it is.
          if (fits && !anySize && paneW && paneH) fits = r.width * r.height < paneW * paneH * 0.75;
        } catch (_) { fits = true; }
        if (fits) return n;
      }
      n = n.parentNode;
    }
  } catch (_) { /* no ancestor to show */ }
  return null;
}

// The change the archived page's own scripts rewrote away. A page that
// hydrates - nytimes.com's 2026 front page is React - replaces the
// server-rendered card it was handed, and every mark in that subtree goes
// with it: `data-pdiff-id` is simply not in the DOM any more, so the click
// finds nothing to scroll to and nothing to mark. The change is still there
// in front of the reader, it just lost its mark, so it is found again by what
// the diff recorded about it: the tag and the text (or the image file), with
// a match inside the same container the stored path names preferred over one
// that merely says the same thing somewhere else on the page.
function rescueMarkedTarget(iframe, change, side) {
  let doc = null;
  try { doc = iframe.contentDocument; } catch (_) { return null; }
  if (!doc || !change) return null;
  const accepts = (typeof PdiffSelection !== 'undefined' && PdiffSelection.twinAccepts)
    ? PdiffSelection.twinAccepts : null;
  const livePath = (typeof PdiffSelection !== 'undefined' && PdiffSelection.livePathOf)
    ? PdiffSelection.livePathOf : null;
  const wantTag = (change.tag || '').toLowerCase();
  const wantText = String(side === 'old' ? change.before : change.after || '').replace(/\s+/g, ' ').trim();
  const wantFile = fileNameFromUrl(attrFromChange(change, 'src', side));
  if (wantTag && (wantText || wantFile)) {
    let list = null;
    try { list = doc.getElementsByTagName(wantTag); } catch (_) { list = null; }
    let fallback = null;
    for (const node of Array.from(list || [])) {
      try {
        if (wantFile) {
          const file = fileNameFromUrl(node.getAttribute('src') || node.getAttribute('poster') || '');
          if (file !== wantFile) continue;
        } else {
          if (String(node.textContent || '').replace(/\s+/g, ' ').trim() !== wantText) continue;
        }
        if (!isDisplayedInPane(node) || !readableBox(node)) continue;
        if (accepts && livePath) {
          let candPath = '';
          try { candPath = livePath(node); } catch (_) { candPath = ''; }
          try { if (accepts(change.path, candPath, true)) return node; } catch (_) { /* keep as a fallback */ }
        }
        if (!fallback) fallback = node;
      } catch (_) { /* one unreadable copy must not stop the search */ }
    }
    if (fallback) return fallback;
  }
  // The words are gone too: a page that rebuilds its own cards from scratch
  // (nytimes.com's 2026 front page is React, and its credits come back with
  // different markup and different text) leaves nothing this change says
  // anywhere in the document. What survives is the shape of where it lived,
  // which the diff recorded as an ancestor path, so the card that holds the
  // change is found by that path and marked. A badge on the card is the
  // honest answer for a change the page has moved on from, and the one thing
  // it must not be is a click that marks nothing at all.
  const byPath = rescueByPath(doc, change);
  if (byPath) return byPath;
  // Even the shape is gone: this change's own card was one of the ones the
  // page rebuilt (a React front page drops the byline cards whose data never
  // arrived, markup, classes and all). The change still has neighbours - the
  // diff records every change in document order - and their marks are still
  // on the page, so the nearest one that shares the most of this change's
  // stored path is where the reader is taken. It is the same region of the
  // page the change lived in, and it is a light the reader can see instead of
  // a dead click.
  return rescueByNeighbour(iframe, change, side);
}

// The nearest change whose mark survived, as the stand-in for one whose own
// card the page rewrote away. Neighbours are walked outward in the diff's
// document order (the change list is in page order) and the one sharing the
// most leading path segments with the missing change wins: a change in the
// same card is the same region of the page, a change ten rows down is merely
// nearby. Only a node that is displayed with a usable box is accepted, so the
// stand-in is something the reader can actually be shown.
function rescueByNeighbour(iframe, change, side) {
  let changes = null;
  try { changes = (state.currentDiff && state.currentDiff.changes) || null; } catch (_) { changes = null; }
  if (!changes || !changes.length) return null;
  const at = changes.indexOf(change);
  if (at < 0) return null;
  const mine = String(change.path || '').split('>').map((s) => s.trim()).filter(Boolean);
  const sharedPrefix = (path) => {
    const other = String(path || '').split('>').map((s) => s.trim()).filter(Boolean);
    let i = 0;
    while (i < mine.length && i < other.length && mine[i] === other[i]) i++;
    return i;
  };
  let best = null;
  let bestDepth = -1;
  for (let d = 1; d <= 40 && d < changes.length; d++) {
    for (const j of [at - d, at + d]) {
      if (j < 0 || j >= changes.length) continue;
      const c = changes[j];
      const id = side === 'old' ? c.oldId : c.newId;
      if (!id) continue;
      let node = null;
      try { node = findInPane(iframe, id); } catch (_) { node = null; }
      if (!node || !isDisplayedInPane(node) || !usableBox(node)) continue;
      const depth = sharedPrefix(c.path);
      if (depth > bestDepth) { bestDepth = depth; best = node; }
      if (bestDepth >= 2) return best;   // the same card: good enough, now
    }
    if (best && d >= 6) break;           // nearby is enough after a handful
  }
  return best;
}

// The ancestor the stored path names, found again in the live document. The
// path is the diff engine's own breadcrumb format - tag[#id][.class1.class2]
// joined by ' > ', outermost first - and it names up to three ancestors of
// the change, so the last segment is the deepest container the change lived
// in. A candidate is accepted when its own tag and discriminating id or class
// are that last segment's and the stored path still ends with the candidate's
// own live ancestors; the first displayed one with a box wins. Returns null
// when the path is missing or nothing in the document answers to it.
function rescueByPath(doc, change) {
  try {
    const stored = String(change.path || '').split('>').map((s) => s.trim()).filter(Boolean);
    if (!stored.length) return null;
    const deepest = stored[stored.length - 1];
    const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(deepest);
    if (!tagMatch) return null;
    const tag = tagMatch[1].toLowerCase();
    const idMatch = /#([^.\s#]+)/.exec(deepest);
    const wantId = idMatch ? idMatch[1].toLowerCase() : '';
    const wantClasses = [];
    if (!wantId) {
      const dot = deepest.indexOf('.');
      if (dot >= 0) {
        deepest.slice(dot + 1).split(/[.]/).forEach((c) => {
          const t = String(c || '').trim().toLowerCase();
          if (t) wantClasses.push(t);
        });
      }
    }
    const outcome = Array.from(doc.getElementsByTagName(tag));
    const livePath = (typeof PdiffSelection !== 'undefined' && PdiffSelection.livePathOf)
      ? PdiffSelection.livePathOf : null;
    // The best matching container, by what it has to offer: on screen and
    // still holding a marked change is the answer; then on screen and
    // holding one; then holding one with a box; then merely on screen. The
    // mark matters because a stored path describes a *shape* - three
    // ancestors of a link - and a nav holds a dozen links with that same
    // shape, so the container with the comparison's own marks inside it is
    // the card the change belongs to and the others are its neighbours.
    // Failing all of that, a display:none container still names where the
    // change lives, and the settle walk answers with the visible bar around
    // it (measured on nytimes.com's Games dropdown: the link's own container
    // is display:none until the menu opens, and the nav item is the light).
    let best = null;
    let bestScore = -1;
    for (const node of outcome) {
      try {
        if (wantId) {
          if (String(node.id || '').toLowerCase() !== wantId) continue;
        } else if (wantClasses.length) {
          const own = [];
          try { Array.from(node.classList || []).slice(0, 2).forEach((c) => own.push(String(c).toLowerCase())); } catch (_) { /* bare tag */ }
          if (!wantClasses.some((c) => own.indexOf(c) >= 0)) continue;
        }
        if (livePath) {
          let live = [];
          try { live = String(livePath(node, Math.max(0, stored.length - 1)) || '').split('>').map((s) => s.trim()).filter(Boolean); } catch (_) { live = []; }
          if (live.length) {
            const tail = stored.slice(Math.max(0, stored.length - 1 - live.length), stored.length - 1);
            if (tail.join(' > ') !== live.join(' > ')) continue;
          }
        }
        const box = hasBoxInPane(node);
        const shown = box && isDisplayedInPane(node);
        const holds = !!node.querySelector('[data-pdiff-id]');
        const score = shown && !isClippedOutOfPane(node) && holds ? 6
          : shown && holds ? 5
            : holds && box ? 4
              : shown ? 3
                : box ? 1 : 0;
        if (score > bestScore) { bestScore = score; best = node; }
      } catch (_) { /* one unreadable candidate must not stop the search */ }
    }
    return best;
  } catch (_) { /* no path to go on */ }
  return null;
}

// A node the pane cannot scroll to: it, or one of its ancestors, is
// position: fixed - which no scroll moves - and its box lies outside the
// pane's viewport. Measured on nytimes.com's 2015 front page: an ad
// interstitial pinned 900px wide over a 514px pane held its "Skip this ad"
// button at x619, and all thirty seconds of corrections moved the page
// underneath it and left the button exactly where it was. The change is
// inside that overlay, so the overlay is what gets lit (see settle below).
function pinnedOffscreen(node) {
  try {
    if (!node || node.nodeType !== 1) return false;
    const doc = node.ownerDocument;
    const win = doc ? doc.defaultView : null;
    if (!win) return false;
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    if (!vw || !vh) return false;
    const r = node.getBoundingClientRect();
    if (r.width || r.height) {
      // Any part on screen and the ordinary rules apply.
      if (r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh) return false;
    }
    let n = node;
    let guard = 0;
    while (n && n.nodeType === 1 && guard++ < 24) {
      let pos = '';
      try { pos = win.getComputedStyle(n).position || ''; } catch (_) { pos = ''; }
      if (pos === 'fixed') return true;
      n = n.parentElement;
    }
  } catch (_) { /* unreadable: never claim a node is pinned */ }
  return false;
}

// The nearest painted element that can carry a change the page keeps hidden.
// A wrapper div is often the closest thing with a box, and its text is a skip
// link, so the light ends up on "Skip Navigation Links" instead of the nav the
// reader was looking at. Real containers are preferred; the box fallbacks in
// scrollTargetFor still answer when there is none.
// Page-level landmarks are deliberately absent: outlining a whole header or
// nav is a stripe across the logo that names nothing, and "where the change
// lives" is already said in words when no control can be marked.
const CARRIER_SELECTOR = 'ul, ol, li, a, button, [role="menuitem"], [role="menu"], [role="menubar"], [aria-haspopup]';
function carrierAncestorFor(node) {
  let up = node ? node.parentElement : null;
  let guard = 0;
  while (up && up.nodeType === 1 && guard++ < 10) {
    try {
      if (up.matches(CARRIER_SELECTOR) && isDisplayedInPane(up)) return up;
    } catch (_) { /* a selector the engine cannot run: keep walking */ }
    up = up.parentElement;
  }
  return null;
}

// The node a pane should actually scroll to and light for a change: the
// marked node itself when it is on screen, otherwise the visible twin (a
// duplicated element parked behind a shut panel while its identical copy
// sits in the open), otherwise the nearest ancestor that IS on screen
// (the shut container itself, e.g. the SERVICES menu item hosting a
// hidden dropdown link), otherwise the marked node again when it at least
// has a box, otherwise null. There is always an answer when one exists: a
// click that lights nothing and moves nothing reads as dead, and the old
// visible-or-nothing gate is exactly how the Events row did that. A hidden
// node itself is never the answer when a displayed ancestor exists:
// scrolling to and lighting something nobody can see is the other way a
// click reads as dead.
function scrollTargetFor(iframe, change, side) {
  const id = side === 'old' ? change.oldId : change.newId;
  let direct = findInPane(iframe, id);
  // The page rewrote the marked subtree away (see rescueMarkedTarget): find
  // the change again by what it says, and treat that node as the marked one
  // from here on - it is the element the reader is looking at.
  if (!direct) {
    const rescued = rescueMarkedTarget(iframe, change, side);
    if (rescued) direct = rescued;
  }
  // The ancestor fallback below answers a node the page itself keeps out of
  // sight: the nearest ancestor that IS on screen - the shut menu holding the
  // link, the collapsed bar holding the label - is where the pane goes, lit as
  // the container the change lives in, without opening anything. A click that
  // lights nothing reads as dead, and a light on the container is the truth
  // about a change the page only paints when the reader opens it there.
  //
  // Whether a wider arrangement paints the change itself is a different
  // question, asked before any of this by orientStageForSelection: when one
  // snapshot paints it wide, the stage is folded to that snapshot and the node
  // does show itself, so the fallback below is not what answers that click.
  // The last word on every candidate below: a node that paints nothing is
  // answered by the nearest ancestor that does.
  const settle = (node) => {
    const t = showTarget(node);
    if (!t || t.nodeType !== 1) return t;
    // Pinned out of reach is the same answer as clipped: the change cannot be
    // brought to the reader, so the overlay holding it is what is shown. Big
    // though it is, it is on screen, and it is where the change lives.
    const pinned = pinnedOffscreen(t);
    if (!pinned && readableBox(t) && !isClippedOutOfPane(t)) return t;
    const up = showableAncestorFor(t, pinned);
    return up || t;
  };
  if (direct && isDisplayedInPane(direct)) return settle(direct);
  try {
    const twin = findVisibleEquivalent(iframe, change, side);
    if (twin && isDisplayedInPane(twin)) return settle(twin);
  } catch (_) { /* fall through to the ancestors */ }
  const plan = (() => {
    try { return revealPlanFor(iframe, change, side); } catch (_) { return null; }
  })();
  // A change inside a container no rule of the page ever shows is leftover
  // hidden markup, and there is no place on screen that is "where it sits".
  // The 2015 settlement.org "Activity" link lives in a nav copy the
  // stylesheet drops at every width: no visitor saw it, so nothing is scrolled
  // to and nothing is lit for it. Forcing that copy open used to paint a page
  // that never existed; the row's card says so instead.
  if (plan && plan.neverShows) return null;
  // The page keeps it shut and the selection has already performed the
  // interaction those rules name. If the target still cannot be shown, the
  // control the page's rules name is the next best painted element that was
  // in the capture. What is never done is marking an unrelated menu near the
  // change: the reader asked for this change, not its neighbour.
  try {
    if (plan && plan.trigger && isDisplayedInPane(plan.trigger)) return settle(plan.trigger);
  } catch (_) { /* no plan: the ancestors below still answer */ }
  // Nothing names an opener: the nearest real container on screen is the
  // answer - a nav, a header, a list item, a control - rather than whatever
  // wrapper happens to be closest (a div whose only text is a skip link).
  try {
    const carrier = carrierAncestorFor(direct);
    if (carrier) return settle(carrier);
  } catch (_) { /* the box loops below still answer */ }
  // Hidden inside a shut container: the nearest ancestor a person can see
  // is where the pane goes, without opening anything. Checked before the
  // box fallbacks because visibility:hidden subtrees still measure boxes.
  if (direct) {
    try {
      const doc = direct.ownerDocument;
      let n = direct.parentNode;
      while (n && n !== doc) {
        if (n.nodeType === 1 && isDisplayedInPane(n) && usableBox(n)) return settle(n);
        n = n.parentNode;
      }
    } catch (_) { /* fall through to the box fallback */ }
  }
  if (direct && hasBoxInPane(direct)) return settle(direct);
  // A node with no box of its own (display:none inside a shut container)
  // still has a place on the page: the nearest ancestor with a box, which
  // is the shut container itself. The pane scrolls there without opening
  // anything, so the reader sees where the change lives.
  if (direct) {
    try {
      const doc = direct.ownerDocument;
      let n = direct.parentNode;
      let anyBox = null;
      while (n && n !== doc) {
        if (n.nodeType === 1 && usableBox(n)) return settle(n);
        if (!anyBox && n.nodeType === 1 && hasBoxInPane(n)) anyBox = n;
        n = n.parentNode;
      }
      if (anyBox) return settle(anyBox);
    } catch (_) { /* no place to scroll to */ }
  }
  return null;
}

// Runs a callback once the snapshot grid has settled: after the next two
// frames normally, or after the hide/show fold finishes when one is in
// flight. Measuring a target mid-fold reads a mid-animation rect and lands
// the scroll rows away from the element once the grid arrives.
function whenPanesSettled(fn, extraDelay) {
  let transitioning = false;
  try {
    const panes = el('viewerPanes');
    transitioning = !!panes && (panes.classList.contains('pane-leaving-old') || panes.classList.contains('pane-leaving-new'));
  } catch (_) { /* panes gone: run now */ }
  const run = () => {
    // A background tab may never get its animation frames, which would park
    // the scroll forever; the timer is the backstop, whichever fires first.
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      try { fn(); } catch (_) { /* one stuck pane never blocks the other */ }
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(go));
      setTimeout(go, 300);
    } catch (_) {
      go();
    }
  };
  if (extraDelay > 0) {
    try {
      setTimeout(run, singlePaneReduced() ? 80 : extraDelay);
    } catch (_) {
      run();
    }
    return;
  }
  if (!transitioning) { run(); return; }
  try {
    setTimeout(run, singlePaneReduced() ? 80 : 450);
  } catch (_) {
    run();
  }
}

function selectInPane(iframe, change, side) {
  // A change parked on another slide of a carousel is brought into the band
  // first, so the picture itself is what gets scrolled to and lit.
  try { revealCarouselSlide(iframe, change, side); } catch (_) { /* one band never blocks the selection */ }
  const target = scrollTargetFor(iframe, change, side);
  if (!target) return null;
  scrollInnerCentered(target, { instant: true });
  highlightInPane(target);
  return target;
}

function jumpToChange(c, rowEl) {
  const alreadySelected = rowEl && rowEl === selectedRowEl;
  clearSelection();
  // Toggling the row off is the explicit step back.
  if (alreadySelected) {
    try { setSinglePaneView(manualPane); } catch (_) { /* panes gone */ }
    return;
  }
  if (rowEl) {
    rowEl.classList.add('selected');
    selectedRowEl = rowEl;
    // No card on a click: the card is a hover's answer. A click lights the row
    // and takes the panes to the change, which is the question being asked
    // with a click (see applySelectionReveals).
  }
  // Selecting starts by clearing the last one (see clearSelection), which took
  // the hover card down with it. If the pointer never left - the ordinary way
  // a row is clicked - the card comes straight back, because it is there
  // because the pointer is there, and for no other reason.
  try {
    if (rowEl && rowEl.matches(':hover')) showChangeTooltip(c, rowEl);
  } catch (_) { /* no card: the row is still selected and the panes still moved */ }
  // One deterministic pass: mark and scroll every pane that paints the change,
  // and put the reason on the pane that does not (see applySelectionReveals).
  applySelectionReveals(c, true);
}


// What a click on a row does to the panes: puts the stage in the arrangement
// where the change is painted (see orientStageForSelection), performs the
// page's own interaction where its rules name one, and then - if the change is
// still unprinted at every width - opens the change's own hidden chain in
// place. The node that gets marked and scrolled to is the node the diff named,
// never a neighbouring menu the change is not inside. Everything opened is
// recorded and put back when the row is deselected. With scroll=false the pass
// only re-reads the arrangement it is already in (a stage that was resized
// under a live selection).
//
// A pane the reader folded by hand (hide-old/hide-new) is never rearranged: it
// stays as they left it, and the visible pane answers for the change.
function applySelectionReveals(c, scroll) {
  if (scroll) {
    unhighlightInPane(selectedOldTarget);
    unhighlightInPane(selectedNewTarget);
    selectedOldTarget = null;
    selectedNewTarget = null;
  }
  const row = selectedRowEl;
  // The page's own menus, opened by the interaction its rules describe. This
  // runs before the stage is measured, so a change inside a dropdown counts as
  // painted and no pane is folded away looking for a width that shows it.
  const widthsBefore = paneContentWidths();
  openMenusForSelection(c);
  // Which arrangement paints the change, and which snapshots paint it there.
  const orientation = orientStageForSelection(c, { measure: !!scroll });
  const visibleNow = (orientation && orientation.visible) || { old: false, new: false };
  const liveSides = () => {
    const { hideOld, hideNew } = collapsedPanes();
    return { old: !hideOld, new: !hideNew };
  };
  const sidesNow = liveSides();
  if (!sidesNow.old && !sidesNow.new) {
    revealedFor = null;
    return;
  }
  // The open above followed the rules of the width the stage had a moment
  // ago. On a responsive page that is the wrong menu once the arrangement has
  // resized a pane: a desktop bar restaged at a phone width lays its items out
  // inline and shoves the page down, instead of the drawer the page itself
  // would open there. So when the width changed, the open is put back and the
  // page's interaction is performed again at the width that won; what each
  // pane paints is then re-read from that layout, and only re-read.
  const widthsAfter = paneContentWidths();
  const resized = ['old', 'new'].some((side) => sidesNow[side] &&
    widthsBefore[side] && widthsAfter[side] !== widthsBefore[side]);
  if (resized) {
    closeSelectionReveals();
    openMenusForSelection(c);
    ['old', 'new'].forEach((side) => {
      if (!sidesNow[side]) return;
      const id = side === 'old' ? c.oldId : c.newId;
      if (!id) return;
      try {
        visibleNow[side] = changeShowsInPane(el(side === 'old' ? 'paneOld' : 'paneNew'), c, side);
      } catch (_) { /* keep the answer measured before the resize */ }
    });
  }
  // No width and no interaction of the page paints it: leftover hidden
  // markup, which is left exactly as the Archive recorded it. Nothing is
  // opened here to make it appear, because no visitor ever saw it - the row
  // still selects, and its card says why there is nothing on screen.
  const stage = () => {
    if (!row || selectedRowEl !== row) return;
    const sides = liveSides();
    if (!sides.old && !sides.new) return;
    revealedFor = {
      change: c,
      visibleOld: !!visibleNow.old,
      visibleNew: !!visibleNow.new,
    };
    if (!scroll) return;
    // Every snapshot that is on screen answers for the change: one that paints
    // it scrolls to the change itself, and one that does not scrolls to the
    // nearest thing it does paint around it - the shut menu holding the link,
    // the collapsed bar holding the label - so the click still moves and shows
    // the reader where the change lives. A folded pane is off screen and has
    // nothing to mark.
    const jobs = [];
    if (sides.new && c.newId) jobs.push({ side: 'new', iframe: el('paneNew'), id: c.newId });
    if (sides.old && c.oldId) jobs.push({ side: 'old', iframe: el('paneOld'), id: c.oldId });
    if (!jobs.length) return;
    // Layout settles on the next frame, so the boxes measured and scrolled
    // against are the ones being painted.
    const run = () => {
      if (!selectedRowEl || !revealedFor || revealedFor.change !== c) return;
      jobs.forEach(({ side, iframe }) => {
        try {
          const s = scrollTargetFor(iframe, c, side);
          if (!s) return;
          scrollInnerCentered(s, { instant: true });
          highlightInPane(s);
          if (side === 'new') {
            if (selectedNewTarget && selectedNewTarget !== s) unhighlightInPane(selectedNewTarget);
            selectedNewTarget = s;
          } else {
            if (selectedOldTarget && selectedOldTarget !== s) unhighlightInPane(selectedOldTarget);
            selectedOldTarget = s;
          }
        } catch (_) { /* one stuck pane never blocks the other */ }
      });
      verifySelectionScrolls(c, jobs);
    };
    whenPanesSettled(run, 0);
  };
  stage();
}


// A reveal is only true at the width it was measured at.
//
// The inline display/visibility a reveal sets is an answer to the page's
// media queries at one viewport width. Resizing the window - or folding a
// snapshot so the other one takes the stage - re-asks those questions, and
// an override left over from the old width is a small-screen drawer opened
// into a desktop layout: a strip of boxes across the header. So when the
// stage's own width changes, the reveal is dropped and restaged at the new
// width. The restage never scrolls: the reader is dragging a window edge,
// not asking to be moved, and a scroll under a resize is motion they did
// not ask for.
let paneWidthTimer = null;
let paneWidthSeen = 0;
function paneStageWidth() {
  let total = 0;
  ['paneOld', 'paneNew'].forEach((id) => {
    try {
      const r = el(id).getBoundingClientRect();
      if (r.width > 0) total += r.width;
    } catch (_) { /* pane gone */ }
  });
  return Math.round(total);
}
function watchPaneWidth() {
  let panes = null;
  try { panes = el('viewerPanes'); } catch (_) { return; }
  if (!panes || typeof ResizeObserver === 'undefined') return;
  paneWidthSeen = paneStageWidth();
  try {
    const ro = new ResizeObserver(() => {
      if (paneWidthTimer) clearTimeout(paneWidthTimer);
      paneWidthTimer = setTimeout(() => {
        paneWidthTimer = null;
        const now = paneStageWidth();
        if (!now || Math.abs(now - paneWidthSeen) < 2) return;
        paneWidthSeen = now;
        if (!revealedFor || !selectedRowEl) return;
        // The pane width is what a media query answers, so a width change is
        // exactly when the answer to "does this pane paint the change" can
        // change. The pass only re-reads; it never scrolls under a resize, and
        // it never rearranges the stage the reader is dragging.
        try { applySelectionReveals(revealedFor.change, false); } catch (_) { /* best effort */ }
      }, 220);
    });
    ro.observe(panes);
  } catch (_) { /* no observer: the next click re-reads anyway */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchPaneWidth);
else watchPaneWidth();

// The scroll behind the highlight, kept honest while the snapshot is still
// arriving. Archived images keep loading (and failing) for many seconds
// after a click, and every one reflows the page under the smooth scroll:
// the scroll lands where the target was, clamps to a range that no longer
// exists, or never advances at all, and the light ends up sitting on
// something nobody can see. So each side is rechecked until its target is
// actually on screen, the selection moves on, or the window below runs
// out. Corrections are instant and always remeasured against the live
// layout; a side the reader scrolls themselves is left alone from that
// moment on (wheel and touch are the reader's hands on the pane, layout
// shifts never fire them).
function verifySelectionScrolls(c, jobs) {
  if (!jobs || !jobs.length) return;
  const inView = (typeof PdiffSelection !== 'undefined' && PdiffSelection.rectInPaneViewport) ||
    ((rect, vw, vh, sliver) => {
      const least = (sliver == null ? 6 : sliver);
      if (!rect || !(rect.width || rect.height)) return false;
      const seenY = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
      const seenX = Math.min(rect.right, vw) - Math.max(rect.left, 0);
      return seenY >= Math.min(least, rect.height) && seenX >= Math.min(least, rect.width);
    });
  // The reader's hands on the pane, marked on the document so the checks
  // below can stand down. Programmatic scrolls (ours, the page's own,
  // anchoring adjustments) never fire these.
  jobs.forEach(({ iframe }) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      try { delete doc.__pdiffUserScrolled; } catch (_) { try { doc.__pdiffUserScrolled = null; } catch (__) {} }
      ['wheel', 'touchstart', 'keydown', 'pointerdown', 'mousedown'].forEach((ev) => {
        try {
          doc.addEventListener(ev, () => { try { doc.__pdiffUserScrolled = true; } catch (_) {} }, { capture: true, passive: true });
        } catch (_) {
          try { doc.addEventListener(ev, () => { try { doc.__pdiffUserScrolled = true; } catch (_) {} }, true); } catch (__) { /* pane gone */ }
        }
      });
    } catch (_) { /* one stuck pane never blocks the other */ }
  });
  // Archived images arrive and fail for many seconds after the click, and
  // each one reflows the page: the window has to outlast that settling, or
  // the last reflow lands after the last check with the badge off screen.
  const deadline = Date.now() + 30000;
  const current = () => {
    try { return !!(selectedRowEl && revealedFor && revealedFor.change === c); } catch (_) { return false; }
  };
  // One pass over both sides: move the light to the node actually being
  // scrolled to, and correct the scroll if the target is not in view.
  // Returns whether any side still looks unsettled, which only decides how
  // soon to look again. Nothing in the page is ever reopened: a change the
  // page keeps out of sight is answered by the fold the stage took to reach
  // the orientation it is painted in, and by the light on the nearest thing
  // the pane does paint around it.
  const aim = (final) => {
    if (!current()) return false;
    let pending = false;
    jobs.forEach(({ side, iframe }) => {
      try {
        if (!selectedRowEl || !revealedFor || revealedFor.change !== c) return;
        // A fold the reader made takes its pane out of the picture: nothing
        // in it is on screen to correct, and re-opening a container inside a
        // hidden pane is work nobody can see.
        try {
          const folded = collapsedPanes();
          if (side === 'new' ? folded.hideNew : folded.hideOld) return;
        } catch (_) { /* unreadable: fall through to the usual checks */ }
        let userTookOver = false;
        try { userTookOver = !!(iframe.contentDocument && iframe.contentDocument.__pdiffUserScrolled); } catch (_) { userTookOver = false; }
        if (userTookOver) return;
        // The marked node is what the click is about. When the archived page
        // has hidden it since the click - its own script can close a menu,
        // collapse a header, or swap a whole bar a moment later - the target
        // falls back to the nearest thing the pane does paint around it (see
        // scrollTargetFor), and nothing is reopened to chase the mark.
        let s = scrollTargetFor(iframe, c, side);
        if (!s || !hasBoxInPane(s) || isClippedOutOfPane(s)) {
          // Nothing in this pane answers to the change: no mark left in the
          // document, and neither its words nor the card it lived in. A
          // click that lit something wrong reads worse than one that lit
          // nothing, so the stale light goes.
          //
          // A light already placed is taken off first. The page's own reflow
          // can shrink the marked node to nothing after the first pass (an
          // archived image that failed, a bar that collapses when its script
          // runs), and a 0×0 selected frame nobody can see is a mark that
          // landed nowhere - the exact thing this branch exists to stop.
          const stale = side === 'new' ? selectedNewTarget : selectedOldTarget;
          if (stale) {
            try { unhighlightInPane(stale); } catch (_) { /* gone already */ }
            if (side === 'new') selectedNewTarget = null;
            else selectedOldTarget = null;
          }
          return;
        }
        let vw = 0, vh = 0;
        try {
          const win = iframe.contentWindow;
          vw = (win && win.innerWidth) || 0;
          vh = (win && win.innerHeight) || 0;
        } catch (_) { return; }
        // The layout this click was measured against can be gone by now, and
        // the node that replaced the marked one is a different element: the
        // light follows the target that is being scrolled to, or the reader
        // is left with a badge on something the page has since collapsed
        // (measured on apple.com: the light sat on a nav link the archived
        // script had hidden, and nothing on screen was marked at all).
        //
        // No light at all is the same case, not a reason to skip: a pane
        // still parsing when the row was clicked (nytimes.com's 2026 front
        // page takes seconds to hydrate) found nothing to scroll to, so the
        // first pass lit nothing and this loop is the only thing that ever
        // will. Waiting for an existing light to have moved left the reader
        // parked on the right place with nothing marked on it.
        //
        // A light that is still in the document, still on screen, and still
        // means this change (it is the target, it holds it, or it sits inside
        // it) is left alone. Moving it on every difference is how a page that
        // nudges its own overlay around - nytimes.com's 2015 ad interstitial
        // shifts a few pixels a second - produced a light that jumped between
        // the button and the box around it on every poll, and a badge that
        // spent more time animating than marking.
        const lit = side === 'new' ? selectedNewTarget : selectedOldTarget;
        let keepLit = false;
        if (lit) {
          try {
            const doc = iframe.contentDocument;
            keepLit = !!(doc && doc.contains(lit)) && inView(lit.getBoundingClientRect(), vw, vh) &&
              !!(lit === s || (lit.contains && lit.contains(s)) || (s.contains && s.contains(lit)));
          } catch (_) { keepLit = false; }
        }
        if (!keepLit) {
          if (lit === s) {
            // Same node, just off screen: nothing to re-light, the scroll
            // below is the whole correction.
          } else if (lit) {
            try { unhighlightInPane(lit); } catch (_) { /* the old light may be gone already */ }
            try { highlightInPane(s); } catch (_) { /* the new light is best effort */ }
            if (side === 'new') selectedNewTarget = s;
            else selectedOldTarget = s;
          } else {
            try { highlightInPane(s); } catch (_) { /* the first light is best effort */ }
            if (side === 'new') selectedNewTarget = s;
            else selectedOldTarget = s;
          }
        }
        let r = null;
        try { r = s.getBoundingClientRect(); } catch (_) { return; }
        if (inView(r, vw, vh)) return;
        if (final) {
          // The window is spent: one last instant correction, measured
          // now, and no reschedule whatever it finds.
          try { scrollInnerCentered(s, { instant: true }); } catch (_) { /* one stuck pane never blocks the other */ }
          return;
        }
        // Still off screen: correct now, every pass. It used to wait for
        // the pane's scroll position to hold still across two polls, on the
        // theory that a smooth scroll was in flight. Every scroll here is
        // instant, so there is nothing to wait for - and while the archived
        // page keeps moving the page under the light (an anchor restored on
        // load, a scroll-linked animation, a rail filling in above it) the
        // position never held still, so the correction never ran at all and
        // the reader spent the whole thirty seconds looking at the gap.
        // Measured on apple.com's 2026 footer: a change lit at y9211 in a
        // 697px pane, corrected zero times, while the page's own script
        // moved the document on every poll.
        try { scrollInnerCentered(s, { instant: true }); } catch (_) { /* one stuck pane never blocks the other */ }
        pending = true;
      } catch (_) { /* one stuck pane never blocks the other */ }
    });
    // The SELECTED word is pinned to the pane, not to the element, so the
    // same pass that corrects the scroll puts it back where the element now
    // is: an image landing above it moves the light AND the word.
    try { placeSelectedBadges(); } catch (_) { /* one stuck badge, never a stuck click */ }
    return pending;
  };
  const check = (final) => {
    if (!current()) return;
    if (!final && Date.now() > deadline) { check(true); return; }
    const pending = aim(final);
    if (!final) {
      // A side that reads as settled is still checked again, more slowly: the
      // archived page keeps arriving for seconds after the click, and one
      // image landing is enough to carry the marked node back off screen, or
      // to collapse the menu it stands in, long after the first check found
      // it in view. Stopping at that first success is how a click ended with
      // the pane parked rows away from the light.
      try { setTimeout(() => check(false), pending ? 500 : 1000); } catch (_) { /* timers gone */ }
    }
  };
  // Layout that arrives *between* two polls is what puts a settled light back
  // off screen: an image lands, a font swaps, a lazy rail fills in, and the
  // element moves a row or two under the scroll. Polling every second can
  // leave the reader looking at the gap for that whole second, so the pane's
  // own layout is watched directly: any size change re-aims once it has been
  // quiet for a beat. Every observer disconnects itself the moment the
  // selection moves on, so clicking through rows does not accumulate them.
  jobs.forEach(({ iframe }) => {
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win || typeof win.ResizeObserver !== 'function') return;
      let quiet = null;
      const ro = new win.ResizeObserver(() => {
        if (!current()) { try { ro.disconnect(); } catch (_) { /* gone */ } return; }
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => {
          quiet = null;
          if (!current()) { try { ro.disconnect(); } catch (_) { /* gone */ } return; }
          try { aim(false); } catch (_) { /* the timed checks still run */ }
        }, 320);
      });
      ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
    } catch (_) { /* no observer: the timed checks still run */ }
  });
  try { setTimeout(check, 650); } catch (_) { /* timers gone */ }
}

// ---------------------------------------------------------------- Change detail modal
// The sidebar list is deliberately compact (truncated, two-line-clamped)
// so a long page's worth of changes stays scannable. That's exactly what
// makes it useless the moment someone actually needs to read one change
// carefully, so hovering a row shows a small tooltip with the complete
// text, a plain explanation of why something like "Etablissement.Org to
// Etablissement.Org" still counts as changed when the words match, and a
// quick note if the element just isn't visible in its pane right now.
const ATTR_LABELS = {
  href: 'link goes to',
  src: 'source',
  alt: 'alt text',
  title: 'title',
  target: 'opens in',
  poster: 'poster image',
  type: 'input type',
  placeholder: 'placeholder',
  value: 'value',
  name: 'name',
};

// Attributes holding a URL. Their raw values are archive rewrites dozens of
// characters long; the file at the end is what a person can actually read.
const URL_ATTRS = new Set([
  'href', 'src', 'poster', 'background', 'action', 'formaction', 'data', 'longdesc', 'cite',
]);

// The label for an attribute, worded for what the element is. "source:
// /web/2026…/logo-cic-en.png" means nothing; "image file: logo-cic-en.png"
// with the full address on hover does.
function attrLabel(name, tag) {
  const t = (tag || '').toLowerCase();
  if (name === 'src') {
    if (t === 'img') return 'image file';
    if (t === 'video') return 'video file';
    if (t === 'audio') return 'audio file';
    if (t === 'iframe') return 'embedded page';
    return 'source';
  }
  if (name === 'alt') return 'description (alt text)';
  if (name === 'poster') return 'preview image';
  return ATTR_LABELS[name] || name;
}

function displayAttrValue(v, name) {
  if (v === null || v === undefined || v === '') return '(none)';
  const s = String(v);
  if (name && URL_ATTRS.has(name) && s.length > 48) {
    const file = fileNameFromUrl(s);
    if (file && file.length < s.length) return file;
  }
  return s;
}

// The full value behind a shortened one, for the hover title. Empty when
// nothing was shortened, so no redundant tooltip.
function attrFullTitle(v, name) {
  const s = v == null ? '' : String(v);
  if (!s || !name || !URL_ATTRS.has(name) || s.length <= 48) return '';
  const file = fileNameFromUrl(s);
  return (file && file.length < s.length) ? s : '';
}
function formatInlineCode(text) { return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>'); }

let tooltipHideTimer = null;
let tooltipToken = 0;
// The card belongs to the pointer. It is what a hover asks for and nothing
// else does: clicking a row is a request to BE SHOWN the change (the panes
// scroll to it and mark it), not a request for a panel that outlives the
// pointer. It was tried the other way - a click pinning the card open, first
// floating over the page and then docked inside the picked row - and a board
// of text appearing under the pointer on every click is not what the list is
// for. So: hover shows it, leaving the row takes it away, a click never opens
// it at all.
function cancelTooltipHide() { if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; } }
function scheduleTooltipHide() {
  tooltipHideTimer = setTimeout(hideChangeTooltip, 150);
}

function showChangeTooltip(c, anchorEl) {
  const tooltip = el('changeDetailTooltip');

  el('changeDetailBadge').textContent = c.type;
  el('changeDetailBadge').className = `change-badge ${c.type}`;
  el('changeDetailTag').textContent = `<${c.tag}>`;
  // What the element IS, in plain words: "changed · <title>" plus two tab
  // texts means nothing until the tooltip says the title is the browser
  // tab's own text rather than words on the page.
  el('changeDetailWhat').textContent =
    (typeof PdiffSelection !== 'undefined')
      ? PdiffSelection.describeElement(c.tag)
      : '';
  el('changeDetailPath').textContent = c.path || '';
  el('changeDetailPath').hidden = !c.path;

  // A wrapper span and a visuallyhidden heading are real changes, but the page
  // never draws them: the click then lights a 1×1 box inside the header (or
  // nothing at all) over text the reader can see, and the card says "A run of
  // text" about a page where the only visible thing is the thing the text
  // describes. Naming the visible element the change lives in is what closes
  // that gap.
  // One analysis per card, shared by both lines: reading every rule of the
  // page three times on a hover is how a tooltip becomes janky.
  const side = c.type === 'added' ? 'new' : 'old';
  // Both sides, once each: the primary one drives the two notes below, and the
  // other decides whether the engine's technical reason adds anything to a
  // change the card already explains as never shown at all.
  const planOf = (which) => {
    try { return revealPlanFor(el(which === 'old' ? 'paneOld' : 'paneNew'), c, which); } catch (_) { return null; }
  };
  const plans = { old: planOf('old'), new: planOf('new') };
  const plan = plans[side];
  paintStandInNote(c, plan);
  // The snapshots keep reflowing for a few seconds after the card opens (every
  // archived picture that lands moves what is under it), and whether a marker
  // has a visible stand-in is a layout answer. Asking again once the page has
  // settled is what keeps a 1×1 span that was briefly measurable from silently
  // dropping the sentence on the card.
  try { setTimeout(() => paintStandInNote(c), 450); } catch (_) { /* no timer: the first answer stands */ }
  paintHowToNote(c, plan);
  try { setTimeout(() => paintHowToNote(c), 450); } catch (_) { /* no timer: the first answer stands */ }

  const pair = el('changeDetailTextPair');
  const beforeBlock = el('changeDetailBefore');
  const afterBlock = el('changeDetailAfter');
  const arrow = el('changeDetailArrow');
  const sameBlock = el('changeDetailSameText');

  // Pictures, video, fields, and rules carry no text: a Before/After pair
  // for them is always "(empty)" versus "(empty)", which is the blank and
  // bare-arrow confusion. Those sections stay hidden here; the media
  // section below says what the picture is instead, in plain words.
  const isTextless = TEXTLESS_TAGS.has((c.tag || '').toLowerCase());
  const mediaSection = el('changeDetailMediaSection');
  const mediaNote = el('changeDetailMediaNote');
  const mediaPreview = el('changeDetailMediaPreview');
  const showMedia = isTextless && (c.tag || '').toLowerCase() === 'img';
  mediaSection.hidden = true;
  let imgFileBoxesShown = false;

  const textIsSame = c.type === 'changed' && c.textChanged === false;

  // When the text hasn't actually changed, showing it twice as a fake
  // before/after just repeats the confusion. Show it once, plainly, and
  // let the sections below do the explaining of what actually did change.
  pair.hidden = textIsSame || isTextless;
  sameBlock.hidden = !textIsSame || isTextless;

  if (showMedia) {
    // What the picture is, in one sentence: its description when the page
    // author wrote one, otherwise the file it points at. Both ends are
    // named when they differ; when only the file moved, the description is
    // said once and the file change gets its own sentence in the link
    // section below, instead of a fake "Logo → Logo" text diff.
    el('changeDetailMediaHeading').textContent =
      c.type === 'added' ? 'The new image'
      : c.type === 'removed' ? 'The removed image'
      : 'The image';
    const altBefore = String(attrFromChange(c, 'alt', 'before') || '').trim();
    const altAfter = String(attrFromChange(c, 'alt', 'after') || '').trim();
    const fileBefore = fileNameFromUrl(attrFromChange(c, 'src', 'before'));
    const fileAfter = fileNameFromUrl(attrFromChange(c, 'src', 'after'));
    const nameOf = (alt, file) =>
      alt ? `\u201c${alt}\u201d${file ? ` (${file})` : ''}` : (file || 'an image with no description');
    // A changed picture is described by what actually differs, not just by
    // what it is: same picture under a new name, a genuinely different
    // picture, or only its description rewritten. See describeImageChange.
    let sentence = '';
    if (c.type === 'added') sentence = `New picture on the page: ${nameOf(altAfter, fileAfter)}.`;
    else if (c.type === 'removed') sentence = `Picture that used to be here: ${nameOf(altBefore, fileBefore)}.`;
    else sentence = describeImageChange(c);
    mediaNote.textContent = sentence;
    // The two file addresses as Before/After boxes in the same red/green
    // language the text changes use, so the picture popup reads like every
    // other popup instead of a bare sentence under bare thumbnails.
    const oldFilesBox = mediaSection.querySelector('.change-media-files');
    if (oldFilesBox) oldFilesBox.remove();
    // Whether the two file addresses stand side by side as red/green boxes
    // below. When they do, they ARE the file story, so the attribute list
    // and the file-destination section leave the file addresses out rather
    // than saying them a second and third time.
    imgFileBoxesShown = !!(fileBefore && fileAfter && fileBefore !== fileAfter);
    if (imgFileBoxesShown) {
      const boxes = document.createElement('div');
      boxes.className = 'change-media-files';
      boxes.innerHTML =
        `<div class="change-detail-block before"><span class="change-detail-label">Before</span><p>${escapeHtml(fileBefore)}</p></div>` +
        `<div class="change-detail-block after"><span class="change-detail-label">After</span><p>${escapeHtml(fileAfter)}</p></div>`;
      mediaSection.insertBefore(boxes, mediaPreview);
    }
    // Side-by-side thumbnails straight from the rendered snapshots, so the
    // change can be *seen*, not just read about. Resolved URLs from the
    // live panes, never the raw attribute text; anything that fails to load
    // hides itself rather than showing a broken-image icon.
    // Both sides, from the live panes, resolved through the same visible-
    // element lookup the selection uses, so a duplicated or clipped image
    // contributes the copy a person can see rather than the hidden one. The
    // caption is the file's own name, which is what makes two same-looking
    // thumbnails legible ("badge-15-years-en.png" vs "badge-years-en.png").
    mediaPreview.innerHTML = '';
    const shots = [];
    if (c.type !== 'added') shots.push({ label: 'Before', side: 'before', iframe: el('paneOld'), id: c.oldId, file: fileBefore });
    if (c.type !== 'removed') shots.push({ label: 'After', side: 'after', iframe: el('paneNew'), id: c.newId, file: fileAfter });
    shots.forEach(({ label, side, iframe, id, file }) => {
      const src = paneImageSrcForChange(iframe, c, side, id);
      if (!src) return;
      const fig = document.createElement('figure');
      fig.className = `change-media-shot ${side}`;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => fig.remove());
      // A picture still arriving stands as a spinner in a reserved box,
      // never as a collapsed line: the frame fades up once it is really
      // here (or at once, when it came out of the cache already loaded).
      const markReady = () => fig.classList.add('is-ready');
      img.addEventListener('load', markReady, { once: true });
      img.src = src;
      if (img.complete && img.naturalWidth) markReady();
      const cap = document.createElement('figcaption');
      const sidePill = document.createElement('span');
      sidePill.className = `shot-side ${String(label).toLowerCase() === 'before' ? 'before' : 'after'}`;
      sidePill.textContent = label;
      cap.appendChild(sidePill);
      if (file) {
        const fname = document.createElement('span');
        fname.className = 'shot-file';
        fname.textContent = file;
        cap.appendChild(fname);
      }
      cap.title = file || '';
      fig.appendChild(img);
      fig.appendChild(cap);
      mediaPreview.appendChild(fig);
    });
    mediaPreview.hidden = mediaPreview.children.length === 0;
    mediaSection.hidden = false;
    // The picture section already says what and where this is, in words.
    // The raw selector path underneath would repeat it in code, so images
    // leave it out and the popup stays readable.
    el('changeDetailPath').hidden = true;
  }

  if (textIsSame) {
    // A leaf that only moved has identical text at both ends, and "changed" with
    // the same words before and after is the most confusing thing this panel can
    // say, so when it moved, the note says so and, when the two snapshots place
    // it somewhere else, where it went.
    const movedNote = !c.moved
      ? ''
      : c.pathBefore && c.path && c.pathBefore !== c.path
        ? `Still on the page, in a different place: it moved from <code>${escapeHtml(c.pathBefore)}</code> ` +
          `to <code>${escapeHtml(c.path)}</code>.`
        : 'Still on the page, just in a different position in the document.';
    sameBlock.innerHTML =
      `<span class="change-detail-label">Text (unchanged)</span><p>${escapeHtml(c.after || '(empty)')}</p>` +
      (movedNote ? `<p class="change-detail-note">${movedNote}</p>` : '');
  } else {
    beforeBlock.hidden = c.type === 'added';
    afterBlock.hidden = c.type === 'removed';
    arrow.hidden = c.type !== 'changed';
    if (!beforeBlock.hidden) {
      // "Removed text" rather than "Before" when there is no after: the
      // question a click asks is "what exactly went away", and the box that
      // holds the answer should say so.
      const label = c.type === 'removed' ? 'Removed text' : 'Before';
      beforeBlock.innerHTML = `<span class="change-detail-label">${label}</span><p>${escapeHtml(c.before || '(empty)')}${c.beforeTruncated ? '\u2026' : ''}</p>`;
    }
    if (!afterBlock.hidden) {
      const label = c.type === 'added' ? 'Added text' : 'After';
      afterBlock.innerHTML = `<span class="change-detail-label">${label}</span><p>${escapeHtml(c.after || '(empty)')}${c.afterTruncated ? '\u2026' : ''}</p>`;
    }
  }

  // ---- attribute changes: a URL that moved is pulled out into the sentence
  // below, since "it goes somewhere different now" deserves more than a raw
  // string diff. Everything else (title, target, alt, etc.) stays in the plain
  // list.
  // A picture's file story, told once: when both ends have a file address it
  // stands as Before/After boxes in the image section (set above), so the
  // attribute list and the file-destination section leave the file addresses
  // out rather than saying them a second and third time.
  const isImgChange = (c.tag || '').toLowerCase() === 'img';
  const urlChanges = c.type === 'changed' && Array.isArray(c.urlChanges) ? c.urlChanges : [];
  const urlNames = new Set(urlChanges.map((u) => u.name));
  let attrRows = [];
  if (c.type === 'changed' && Array.isArray(c.attrChanges)) {
    c.attrChanges.forEach((a) => {
      if (!urlNames.has(a.name)) attrRows.push({ name: a.name, before: a.before, after: a.after, isDiff: true });
    });
  } else if (c.type === 'added' && c.attrsAfter) {
    // The file itself first: it is what an added picture *is*.
    attrRows = Object.entries(c.attrsAfter)
      .sort(([a], [b]) => (URL_ATTRS.has(a) ? -1 : 0) - (URL_ATTRS.has(b) ? -1 : 0))
      .map(([name, after]) => ({ name, after, isDiff: false }));
  } else if (c.type === 'removed' && c.attrsBefore) {
    attrRows = Object.entries(c.attrsBefore)
      .sort(([a], [b]) => (URL_ATTRS.has(a) ? -1 : 0) - (URL_ATTRS.has(b) ? -1 : 0))
      .map(([name, before]) => ({ name, before, isDiff: false }));
  }

  const attrSection = el('changeDetailAttrSection');
  const attrList = el('changeDetailAttrList');
  attrList.innerHTML = '';
  attrSection.hidden = attrRows.length === 0;
  attrRows.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'change-attr-row';
    const titleFor = (v) => {
      const full = attrFullTitle(v, row.name);
      return full ? ` title="${escapeHtml(full)}"` : '';
    };
    // A picture's width/height rows are trivia next to its thumbnails ("WIDTH
    // 74 → HEIGHT 20" tells nothing the two pictures do not), and its file
    // addresses already stand as Before/After boxes when both ends have one.
    // Those rows stay out of a picture's popup; everything else — alt text,
    // titles, targets — still lists.
    if (isImgChange && (row.name === 'width' || row.name === 'height')) return;
    if (isImgChange && imgFileBoxesShown && (row.name === 'src' || row.name === 'srcset' || row.name === 'data-src')) return;
    if (row.isDiff) {
      const isSize = row.name === 'width' || row.name === 'height';
      if (isSize && sizeRowIsNoop(c, row)) return;
      const beforeText = isSize ? displaySizeValue(c, row, 'before') : displayAttrValue(row.before, row.name);
      const afterText = isSize ? displaySizeValue(c, row, 'after') : displayAttrValue(row.after, row.name);
      li.innerHTML =
        `<span class="change-attr-name">${escapeHtml(attrLabel(row.name, c.tag))}</span>` +
        `<span class="change-attr-value before"${titleFor(row.before)}>${escapeHtml(beforeText)}</span>` +
        `<span class="change-attr-sep">&rarr;</span>` +
        `<span class="change-attr-value after"${titleFor(row.after)}>${escapeHtml(afterText)}</span>`;
    } else {
      const val = row.after !== undefined ? row.after : row.before;
      li.innerHTML =
        `<span class="change-attr-name">${escapeHtml(attrLabel(row.name, c.tag))}</span>` +
        `<span class="change-attr-value"${titleFor(val)}>${escapeHtml(displayAttrValue(val, row.name))}</span>`;
    }
    attrList.appendChild(li);
  });

  // ---- link/src destination: the sentence the server wrote about where this
  // now points (domain vs page vs query vs fragment), and the address worth
  // tracing. The traceable address is the *destination*, not the archive's
  // rewrite of it, tracing /web/2016.../http://site/ would ask the Archive
  // about a URL the Archive itself invented, which has no history of its own.
  const linkSection = el('changeDetailLinkSection');
  const linkNote = el('changeDetailLinkNote');
  const traceBtn = el('changeDetailTraceBtn');
  const linkChange = urlChanges[0] || null;
  // A picture whose file moved already says so in the Before/After file
  // boxes of its image section; the destination sentence would repeat them
  // word for word, so pictures leave it out and keep the one telling.
  linkSection.hidden = !linkChange || (isImgChange && imgFileBoxesShown);
  if (linkChange) {
    // The heading used to say "the link" for everything, including a
    // picture whose file moved. Name what actually changed.
    const changedNoun = linkChange.name === 'href'
      ? 'link'
      : (c.tag || '').toLowerCase() === 'img' ? 'picture file' : 'file';
    el('changeDetailLinkHeading').textContent = `About the ${changedNoun}`;
    linkNote.textContent = linkChange.text;
    if (linkChange.traceUrl && linkChange.name === 'href') {
      traceBtn.hidden = false;
      traceBtn.onclick = () => {
        hideChangeTooltip();
        el('urlInput').value = linkChange.traceUrl;
        loadSite(linkChange.traceUrl);
      };
    } else {
      traceBtn.hidden = true;
      traceBtn.onclick = null;
    }
  }

  // ---- appearance diff: compare the two *live rendered* elements
  // directly, real computed styles from each snapshot's own CSS.
  const appearanceSection = el('changeDetailAppearanceSection');
  const appearanceList = el('changeDetailAppearanceList');
  appearanceList.innerHTML = '';
  let appearanceDiffs = [];
  if (c.type === 'changed' && c.oldId && c.newId) {
    appearanceDiffs = compareLeafAppearance(el('paneOld'), c.oldId, el('paneNew'), c.newId);
  }
  appearanceSection.hidden = appearanceDiffs.length === 0;
  appearanceDiffs.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'change-attr-row';
    li.innerHTML =
      `<span class="change-attr-name">${escapeHtml(d.label)}</span>` +
      `<span class="change-attr-value before">${escapeHtml(d.before)}</span>` +
      `<span class="change-attr-sep">&rarr;</span>` +
      `<span class="change-attr-value after">${escapeHtml(d.after)}</span>`;
    appearanceList.appendChild(li);
  });

  // ---- visibility: a real, CSS-grounded reason per side, not a guess.
  // Old and new can be hidden for entirely different reasons, so each
  // gets its own line, labeled, when both apply. This can involve an
  // in-flight fetch (for a stylesheet the browser won't let us read
  // directly), so it's resolved after the rest of the tooltip is already
  // showing, and discarded if the person has moved on to a different row
  // by the time it settles.
  const visList = el('changeDetailVisibilityList');
  visList.innerHTML = '';
  visList.hidden = true;
  const myTooltipToken = ++tooltipToken;

  Promise.all([
    c.oldId ? explainHiddenness(el('paneOld'), c.oldId) : null,
    c.newId ? explainHiddenness(el('paneNew'), c.newId) : null,
  ]).then(([oldReason, newReason]) => {
    if (myTooltipToken !== tooltipToken || tooltip.hidden) return;
    const notes = [];
    // A selection never changes a pane, so the reason a change is not on
    // screen in one of them can be read from the page itself, live: there is
    // no reveal to make it say "visible" a moment later.
    //
    // A side whose change no rule of the page ever shows is already explained
    // in plain words by the "how to see it" line (no visitor saw it, so it
    // stays hidden). The engine's sentence for that case guesses at JavaScript
    // that the page never runs, so it is left out rather than contradicting
    // the line above it.
    const neverShows = (which) => !!(plans[which] && plans[which].neverShows);
    if (oldReason && !neverShows('old')) notes.push({ label: 'Earlier snapshot', reason: oldReason });
    if (newReason && !neverShows('new')) notes.push({ label: 'Later snapshot', reason: newReason });
    visList.hidden = notes.length === 0;
    notes.forEach((n) => {
      const li = document.createElement('li');
      const prefix = (notes.length > 1 || n.performed) ? `<strong>${escapeHtml(n.label)}:</strong> ` : '';
      li.innerHTML = `${prefix}${formatInlineCode(n.reason)}`;
      visList.appendChild(li);
    });
    // The stylesheets the page blocked may have landed by now, which is what
    // turns "no rule found" into the exact hover or click that opens it.
    paintHowToNote(c);
    positionTooltip(tooltip, anchorEl.getBoundingClientRect());
  });

  tooltip.style.visibility = 'hidden';
  tooltip.hidden = false;
  requestAnimationFrame(() => {
    positionTooltip(tooltip, anchorEl.getBoundingClientRect());
    tooltip.style.visibility = '';
  });
}

// Is the change's own node something the page draws?
function changeIsDrawnInPane(c, side) {
  let iframe = null;
  let id = null;
  if (side === 'old' && c.oldId) { iframe = el('paneOld'); id = c.oldId; }
  else if (side === 'new' && c.newId) { iframe = el('paneNew'); id = c.newId; }
  else return true;
  try {
    const win = iframe.contentWindow;
    const node = findInPane(iframe, id);
    return node ? paneNodeIsPainted(node, win) : true;
  } catch (_) {
    return true;
  }
}

// The line that turns "a run of text" into the thing the reader can see.
//
// Three answers, in order: the change is drawn itself (no note needed); it is
// a hidden label whose visible container can be named ("on screen: the Open
// Menu menu item"); or it is hidden with nothing to point at, which is said
// plainly rather than left as a click that appears to do nothing.
function paintStandInNote(c, planArg) {
  const note = el('changeDetailStandIn');
  if (!note || !c) return;
  const side = c.type === 'added' ? 'new' : 'old';
  if (changeIsDrawnInPane(c, side)) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  let plan = planArg;
  if (plan === undefined || plan === null) {
    try { plan = revealPlanFor(el(side === 'old' ? 'paneOld' : 'paneNew'), c, side); } catch (_) { plan = null; }
  }
  // A hiding that answers to the viewport has no visible stand-in to name: the
  // element is simply not painted at this width, and the "how to see it" line
  // already says to widen the pane. Naming the header's first link here read
  // as "on screen: Apple" about a Music link.
  if (plan && plan.responsive) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  // No rule of the page ever shows it: the change is leftover hidden markup,
  // and the first painted ancestor is only the header cell it happens to sit
  // in. Naming that as "where it is on screen" reads as if the page drew it,
  // and the "how to see it" line already explains why there is nothing to
  // see.
  if (plan && plan.neverShows) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  const standIn = visibleStandInFor(c, side);
  if (standIn) {
    const kind = standIn.tag === 'a' ? 'link'
      : standIn.tag === 'li' ? 'menu item'
      : standIn.tag === 'button' ? 'button'
      : 'area';
    note.textContent = standIn.kind === 'inside'
      ? `On screen: the \u201c${standIn.text}\u201d ${kind} it sits in. The change itself is not painted.`
      : `On screen: \u201c${standIn.text}\u201d, the ${kind} the page draws. ` +
        'This text itself is a hidden label, kept for screen readers.';
    note.hidden = false;
    return;
  }
  // When the page's own rules name how to open it, the "how to see it" line
  // says it; two paragraphs both saying "not on screen" is noise.
  if (plan) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  const tag = String(c.tag || 'element').toLowerCase();
  note.textContent =
    `Nothing on screen shows this <${tag}> directly. The page keeps it hidden, ` +
    'so search engines and screen readers still read it; the outline marks where it sits.';
  note.hidden = false;
}

// A short, plain sentence about where the page keeps a hidden change, in the
// page's own vocabulary: a menu that opens on hover is named as such, a
// viewport-dependent hiding is named by its width. The click performs the
// interaction (see openMenusForSelection), so this line describes the page;
// it never instructs the reader to do what the app is already doing.
function paintHowToNote(c, planArg) {
  const note = el('changeDetailHowTo');
  if (!note || !c) return;
  const side = c.type === 'added' ? 'new' : 'old';
  let plan = planArg;
  if (plan === undefined || plan === null) {
    try { plan = revealPlanFor(el(side === 'old' ? 'paneOld' : 'paneNew'), c, side); } catch (_) { plan = null; }
  }
  if (!plan) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  const openedHere = activeReveals.length > 0 && revealedFor && revealedFor.change === c;
  let action = '';
  if (plan.responsive) {
    const width = plan.paneWidth ? `This pane is ${plan.paneWidth}px wide` : 'This pane is narrow';
    action = `The page shows it only at a wider width. ${width}, so the page's own rules hide it here.`;
  } else if (plan.interactive && plan.triggerLabel) {
    action = openedHere
      ? `Open in the page's own \u201c${plan.triggerLabel}\u201d menu, where the change sits.`
      : `The page keeps this in its \u201c${plan.triggerLabel}\u201d menu, which opens on ${String(plan.verb || 'hover').toLowerCase()}.`;
  } else if (plan.interactive) {
    action = 'The page opens this from a control of its own, and the pane is showing it open.';
  } else if (plan.neverShows) {
    const rule = plan.analysis && plan.analysis.hidingRule;
    const where = plan.blocked
      ? `${plan.blocked.desc} { ${plan.blocked.declaration} } hides the box it sits in`
      : (rule ? `${rule.selectorText} { ${rule.declaration} } hides it` : 'the page keeps it hidden');
    action = `No rule of the page ever shows it: ${where}, at every width. ` +
      'It is hidden markup no visitor to the site ever saw, so the snapshot leaves it as the Archive ' +
      'recorded it and clicking the row will not reveal it.';
  } else {
    // Hidden here, but a rule elsewhere in the page can show it: the click is
    // the answer, not an explanation.
    action = 'The page does not paint it at this pane width. The snapshot keeps the change where the page put it.';
  }
  note.textContent = action;
  note.hidden = false;
}

// Is this element something the page actually draws?
//
// Opacity is deliberately not part of the question: a nav link whose label is
// hidden with `opacity: 0` over a sprite icon is still the thing on screen,
// and its text is exactly the name the card needs ("Apple"). What is excluded
// is the invisible: no box, no display, no visibility.
function paneNodeIsPainted(node, win) {
  try {
    if (!node || node.nodeType !== 1) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = win.getComputedStyle(node);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  } catch (_) {
    return false;
  }
}

// The name to put in "on screen this is …": a short, human text, never the
// whole bar a container happens to hold.
function standInLabelFor(node, marked, win) {
  if (!node) return '';
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const short = (value) => {
    const text = clean(value);
    if (!text || text.length > 48 || text.split(' ').length > 7) return '';
    return text;
  };
  // The link or button the marked text lives in is the specific thing the
  // reader sees. Its container usually holds several of them (a menu icon and
  // a close icon in the same <li>), and the container's text would name both.
  // A host the page does not paint is not a name for something on screen: the
  // 2015 header's hidden "Activity" link would otherwise be reported as "on
  // screen: Activity" while nothing of the sort was drawn.
  let host = null;
  try { host = marked && marked.closest ? marked.closest('a, button, [role="button"], label') : null; } catch (_) { host = null; }
  if (host && host !== node && node.contains(host) && paneNodeIsPainted(host, win)) {
    const inner = short(host.getAttribute('aria-label') || host.getAttribute('title') || host.innerText || '');
    if (inner) return inner;
  }
  const named = short(node.getAttribute('aria-label') || node.getAttribute('title') || '');
  if (named) return named;
  // A landmark's own text is the whole bar ("Skip Navigation Links SERVICES
  // FR"), which names a region, not the thing the reader is looking at. Only a
  // leaf-ish control can be introduced by its text.
  const tag = String(node.tagName || '').toUpperCase();
  const nameableByText = /^(A|BUTTON|LABEL|SPAN|LI|EM|STRONG|P|H\d)$/.test(tag);
  if (nameableByText) {
    const own = short(node.innerText || '');
    if (own) return own;
  }
  // A container's own text is the whole bar. The first thing it draws that
  // names itself is the label a person would use, so that is the answer.
  try {
    const inner = node.querySelectorAll('a, button, img, [aria-label], [title]');
    for (const child of inner) {
      if (!paneNodeIsPainted(child, win) && child.tagName !== 'IMG') continue;
      const text = short(child.getAttribute('aria-label') || child.getAttribute('title') || child.innerText || child.getAttribute('alt') || '');
      if (text) return text;
    }
  } catch (_) { /* nothing to name */ }
  return '';
}

// The visible element a hidden marker lives inside: the menu item whose text
// is a screen-reader label, the header whose heading is visuallyhidden. Null
// when the marked node is itself on screen, because then it is its own answer.
function visibleStandInFor(change, side) {
  let iframe = null;
  let id = null;
  if (side === 'old' && change.oldId) { iframe = el('paneOld'); id = change.oldId; }
  else if (side === 'new' && change.newId) { iframe = el('paneNew'); id = change.newId; }
  else return null;
  let doc = null;
  let win = null;
  try {
    doc = iframe.contentDocument;
    win = iframe.contentWindow;
  } catch (_) { return null; }
  if (!doc || !win || !doc.body) return null;
  const node = findInPane(iframe, id);
  if (!node) return null;
  if (paneNodeIsPainted(node, win)) return null;
  let up = node.parentElement;
  let guard = 0;
  while (up && up !== doc.body && guard++ < 10) {
    if (paneNodeIsPainted(up, win)) {
      const text = standInLabelFor(up, node, win);
      if (!text) return null;
      // Two different situations, told apart by what the marked node itself
      // is: a wrapper span whose words the page hides and a control draws (the
      // label case), or a real link/menu item inside a container the page
      // keeps shut (the inside case - the container is on screen, the change
      // is not).
      const ownTag = String(node.tagName || '').toUpperCase();
      const wrapper = /^(SPAN|EM|STRONG|B|I|SMALL)$/.test(ownTag);
      return { tag: String(up.tagName || '').toLowerCase(), text, kind: wrapper ? 'label' : 'inside' };
    }
    up = up.parentElement;
  }
  return null;
}

function positionTooltip(tooltip, anchorRect) {
  const margin = 10;
  const width = tooltip.offsetWidth || 300;
  const height = tooltip.offsetHeight || 160;

  let left = anchorRect.left - width - margin;
  if (left < margin) left = Math.max(margin, Math.min(anchorRect.right + margin, window.innerWidth - width - margin));

  let top = anchorRect.top + anchorRect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideChangeTooltip() {
  el('changeDetailTooltip').hidden = true;
}

el('changeDetailTooltip').addEventListener('mouseenter', cancelTooltipHide);
el('changeDetailTooltip').addEventListener('mouseleave', scheduleTooltipHide);

function truncate(s, n) { return (s || '').length > n ? s.slice(0, n).trim() + '\u2026' : (s || ''); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The comparison is always side by side now: the layout switch is gone and
// its place holds Compare open pages and Copy link instead. No mode to set.

// ---------------------------------------------------------------- Side tabs
const tabs = { changes: el('tabChanges'), notes: el('tabNotes'), insight: el('tabInsight') };
const panels = { changes: el('panelChanges'), notes: el('panelNotes'), insight: el('panelInsight') };
// The card is fixed to the viewport while the row it describes scrolls, so a
// scroll under the pointer takes it away rather than leaving it behind.
el('panelChanges').addEventListener('scroll', () => hideChangeTooltip(), { passive: true });

Object.keys(tabs).forEach((key) => {
  tabs[key].addEventListener('click', () => {
    Object.keys(tabs).forEach((k) => {
      tabs[k].classList.toggle('active', k === key);
      panels[k].hidden = k !== key;
    });
  });
});

// ---------------------------------------------------------------- Notes
//
// Notes are an append-only log per site now: saving always adds a new
// dated card rather than overwriting the last one, and there's always an
// open composer below the list ready for the next entry. Each existing
// card can still be edited or cleared individually, independent of the
// composer. Keyed by the site's URL alone, not by which two dates are
// being compared, so the whole log follows you regardless of date range.
let notesList = [];
let composerDirty = false;

function setComposerDirty(dirty) {
  composerDirty = dirty;
  el('notesSaveBtn').disabled = !dirty;
}

window.addEventListener('beforeunload', (e) => {
  if (!composerDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

function noteDateLabel(note) {
  return `Saved ${formatDate(new Date(note.updatedAt).toISOString())} \u00b7 ${timeAgo(note.updatedAt)}`;
}

async function loadNotes() {
  el('notesStatus').textContent = '';
  el('notesArea').value = '';
  setComposerDirty(false);
  try {
    const res = await fetch(`/api/notes?url=${encodeURIComponent(state.url)}`);
    const data = await res.json();
    notesList = data.notes || [];
  } catch (_) {
    notesList = [];
    el('notesStatus').textContent = "Couldn't load notes for this site just now.";
  }
  renderNotesList();
}

function renderNotesList() {
  const container = el('notesList');
  container.innerHTML = '';
  notesList.forEach((note) => container.appendChild(buildNoteCard(note)));
}

// Each card is self-contained: it knows how to switch itself into an
// inline editor (its own textarea + Save/Cancel) and back into read mode,
// independent of every other card and of the composer at the bottom.
function buildNoteCard(note) {
  const card = document.createElement('div');
  card.className = 'notes-card';

  const renderReadMode = () => {
    card.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'notes-card-header';
    const dateSpan = document.createElement('span');
    dateSpan.className = 'notes-card-date mono';
    dateSpan.textContent = noteDateLabel(note);
    const editBtn = document.createElement('button');
    editBtn.className = 'text-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', renderEditMode);
    header.appendChild(dateSpan);
    header.appendChild(editBtn);

    const body = document.createElement('p');
    body.className = 'notes-card-body';
    body.textContent = note.body;

    card.appendChild(header);
    card.appendChild(body);
  };

  const renderEditMode = () => {
    card.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'notes-area';
    textarea.value = note.body;

    const actions = document.createElement('div');
    actions.className = 'notes-edit-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'text-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', renderReadMode);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-btn notes-save-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      el('notesStatus').textContent = 'Saving\u2026';
      try {
        const res = await fetch(`/api/notes/${note.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: state.url, body: textarea.value }),
        });
        const data = await res.json();
        el('notesStatus').textContent = '';
        if (data.deleted) {
          notesList = notesList.filter((n) => n.id !== note.id);
          renderNotesList();
          return;
        }
        note.body = data.body;
        note.updatedAt = data.updatedAt;
        renderReadMode();
      } catch (_) {
        el('notesStatus').textContent = "Couldn't save just now.";
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    card.appendChild(textarea);
    card.appendChild(actions);
    textarea.focus();
  };

  renderReadMode();
  return card;
}

el('notesArea').addEventListener('input', () => setComposerDirty(el('notesArea').value.trim().length > 0));

el('notesSaveBtn').addEventListener('click', async () => {
  const body = el('notesArea').value;
  if (!body.trim()) return;
  el('notesStatus').textContent = 'Saving\u2026';
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: state.url, body }),
    });
    const note = await res.json();
    notesList.unshift(note); // newest on top, composer always stays below the whole list
    renderNotesList();
    el('notesArea').value = '';
    setComposerDirty(false);
    el('notesStatus').textContent = '';
  } catch (_) {
    el('notesStatus').textContent = "Couldn't save just now.";
  }
});

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- Insight
function resetInsightPanel() {
  el('insightIdle').hidden = false;
  el('insightLoading').hidden = true;
  el('insightResult').hidden = true;
  el('insightError').hidden = true;
}

el('generateInsightBtn').addEventListener('click', () => generateInsight());
el('regenerateInsightBtn').addEventListener('click', () => generateInsight(true));

async function generateInsight() {
  const from = state.snapshots[state.fromIndex];
  const to = state.snapshots[state.toIndex];

  el('insightIdle').hidden = true;
  el('insightResult').hidden = true;
  el('insightError').hidden = true;
  el('insightLoading').hidden = false;

  try {
    const res = await fetch('/api/insight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.url,
        from: from.timestamp,
        to: to.timestamp,
        dateFrom: formatDate(from.date),
        dateTo: formatDate(to.date),
        changes: state.currentDiff.changes,
        counts: state.currentDiff.counts,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not generate an insight.');

    el('insightText').textContent = data.summary;
    el('insightSources').innerHTML = '';
    (data.sources || []).forEach((s) => {
      const a = document.createElement('a');
      a.className = 'insight-source';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title;
      el('insightSources').appendChild(a);
    });

    el('insightLoading').hidden = true;
    el('insightResult').hidden = false;
  } catch (err) {
    el('insightLoading').hidden = true;
    el('insightError').hidden = false;
    el('insightError').textContent = err.message;
  }
}

// ----------------------------------------------------------- Arriving here
//
// The front page's search is a form that GETs this page, so an address, a range
// and a layout can arrive in the query string, and the nameplates on the front
// page and the record card in the film's dark band are links of the same shape.
//
// This is read at the very end of the file on purpose: loadSite reaches into the
// panes, the timeline and the notes panel, so everything it touches has to be
// defined before it can be called. Nothing here runs when the query string is
// empty, which is every visit that begins by typing into the field above: that
// reader gets exactly the page this page has always been.
(function arrivingWithAnAddress() {
  let params;
  try { params = new URL(location.href).searchParams; } catch (_) { return; }
  const target = (params.get('url') || '').trim();
  // A comparison link (`#url=…&from=…&to=…`) is the other way in, and it
  // names the two captures itself. Handled by its own path so the query-string
  // route (which reads ?from=/?to= as *years*, a different thing) never has to
  // know about it.
  const compareRoute = parseCompareHash(location.hash);
  if (!target && !compareRoute) return;

  const start = () => {
    if (compareRoute) {
      if (compareRoute.kind === 'pages') {
        el('urlInput').value = archivePageSiteUrl(compareRoute.oldPage) || '';
        applyPagesRoute(compareRoute, { silentScroll: true });
        return;
      }
      el('urlInput').value = compareRoute.url;
      applyCompareHash(compareRoute, { keepHash: true, silentScroll: true });
      return;
    }
    el('urlInput').value = target;
    const from = params.get('from');
    const to = params.get('to');
    // The year fields are built from the clock by theme.js, which the page
    // loads after this file, so setting a value on them here, at the moment
    // this script runs, sets it on a select with no options yet, and the
    // browser drops it. Measured: arriving with ?from=2016 read back as the
    // whole record. Hence the wait, which is what makes this independent of
    // the order the page happens to load its scripts in.
    if (from && el('fromYear')) el('fromYear').value = String(from);
    if (to && el('toYear')) el('toYear').value = String(to);
    loadSite(target, { silentScroll: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
