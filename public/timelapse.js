// public/timelapse.js
//
// The timelapse is the third read of the same record the compare view and the
// dashboard already produce. The compare view puts two moments side by side;
// the dashboard aggregates the whole history into charts. This one does
// neither: it plays the entire record back, in order, one capture at a time,
// so the thing you watch is the site itself aging rather than a summary of it.
//
// It covers EVERY snapshot on file. There is no sampling step and no cap, and
// that is correct rather than merely thorough: lib/cdx.js asks the CDX server
// for `collapse=digest`, so every entry in the list is a moment the page
// genuinely changed. There is no filler to skip and nothing to gain by
// picking a subset.
//
// ## Two phases, on purpose
//
// **Phase one retrieves the whole record. Phase two plays it.** Nothing starts
// until everything has arrived, so the film never stutters, never waits, and
// never skips a capture to keep up with a clock.
//
// That ordering is forced by the Archive, not chosen for drama. lib/rateLimiter.js
// serialises every outgoing request to web.archive.org at one per 1.1s across
// the whole process, so a 740-capture record is over thirteen minutes of
// fetching the first time any machine reads it. Fetching on demand would only
// move that wait into the middle of the film, where it is far worse: a
// slideshow that stutters. Paying it once, up front, with an honest progress
// bar, is the better trade.
//
// ## The film fetches nothing itself
//
// public/archiveStore.js owns the one walk of a site's history: every adjacent
// pair of captures, the pages themselves, and what changed at each step. The
// dashboard reads the same record. Whichever opens first pays for it, and the
// other finds it already done - so reading the dashboard first, which is what
// most people do anyway, is exactly what makes the film open instantly.
//
// That is also why the pages live on disk rather than on the heap. Holding 740
// whole archived documents as live strings would be tens of megabytes, enough
// to make the tab stutter and often enough to get it killed. Playback reads one
// page at a time out of the store, with a small ring in front of it so stepping
// back and forth across a few frames does not re-read from disk every time.
//
// Like dashboard.js, this file expects app.js to have run and reuses its
// globals: `state`, `el`, `formatDate`, `escapeHtml`, `injectScrollFix`.

// How long one frame holds the screen at 1x.
const TL_FRAME_MS = 2600;

// The cross-fade between two frames.
const TL_FADE_MS = 420;

// How long a frame may wait to become paintable before it is shown anyway.
// This is the whole difference between a film and a slideshow that stalls: a
// capture is ready when its document is parsed and its stylesheets have landed,
// NOT when every image has arrived. An archived page with a dozen images can
// take seconds to fire `load`, and a beat cannot be that long. Styling is the
// one thing worth a short wait, because an unstyled frame is a page nobody ever
// saw; a late image simply fills in on screen, exactly as it would in a tab.
const TL_READY_MS = 400;

// How far ahead of the playhead the film will look for a frame that is already
// loaded. A capture that is not there yet is dropped, not waited for.
const TL_SKIP = 12;

// How many frames the store is asked for at once. One at a time cannot feed a
// film that shows six frames a second.
const TL_PREFETCH_LANES = 3;

// How long after a frame reaches the screen it is checked for the one failure
// the browser never repairs by itself: a stylesheet whose request died in
// flight is never asked for again, and the frame stays unstyled forever.
const TL_HEAL_MS = 1500;

// A recording is not on a clock. The film has to keep a beat, but a file is
// watched later, frame by frame, and a picture that was still arriving when its
// beat ended would be a claim about that page which is not true. So while the
// film is being recorded, a frame is allowed to wait for its whole self.
const TL_READY_MS_RECORDING = 4000;

// How many documents are kept in memory during playback. Playback reads one at
// a time out of the record store; this ring only exists so stepping back and
// forth across a few frames doesn't re-read from disk each time.
const TL_DOC_RING = 16;

const TL = {
  gen: 0,        // bumped whenever a load is superseded or abandoned
  forUrl: null,
  frames: [],
  index: 0,
  playing: false,
  speed: 1,
  timer: null,
  // When the next beat is due, on the same clock the beats are measured on. A
  // fixed cadence is the whole point of the film: every frame holds for the
  // same length of time, whatever the pages underneath are doing.
  nextAt: 0,
  phase: 'idle', // 'idle' | 'retrieving' | 'ready'
  // Guards the frame on screen: a show that lost the race to a newer one must
  // not swap when it finally arrives.
  showToken: 0,
  // The download. `on` is the recording loop's switch; the rest is what it
  // needs to stop cleanly and hand over a file.
  export: {
    state: 'idle',   // 'idle' | 'card' | 'recording' | 'saved'
    on: false, finishing: false, index: 0, pace: 0.5, raf: 0,
    rec: null, track: null, video: null, chunks: [], mime: '', ext: 'webm',
    done: null, blob: null, url: null, name: '', startedAt: 0,
  },
  ring: new Map(),   // frame index -> html, bounded
  // The store's last word on how far along the reading is, kept so the progress
  // card can be repainted at any moment - including after the film is closed
  // and reopened while the reading is still running.
  progress: { done: 0, total: 0, year: null, etaSeconds: 0 },
};

// ---------------------------------------------------------------- formatting
const tlNum = new Intl.NumberFormat();
const tlFmt = (n) => tlNum.format(n);

function tlTotal() { return TL.frames.length; }

function tlHumanSeconds(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 90) return `${Math.round(sec)} sec`;
  const min = sec / 60;
  if (min < 90) return `${min < 10 ? min.toFixed(1) : Math.round(min)} min`;
  const hr = min / 60;
  return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} hr`;
}

function tlRuntime() {
  const n = tlTotal();
  if (!n) return '';
  return tlHumanSeconds((n * TL_FRAME_MS) / TL.speed / 1000);
}

// ---------------------------------------------------------------- ring cache
function tlRingSet(i, html) {
  TL.ring.set(i, html);
  while (TL.ring.size > TL_DOC_RING) {
    const oldest = TL.ring.keys().next().value;
    TL.ring.delete(oldest);
  }
}

function tlRingClear() { TL.ring.clear(); }

// ---------------------------------------------------------------- frames
function tlBuildFrames() {
  const snaps = state.snapshots;
  if (TL.frames.length === snaps.length && TL.forUrl === state.url) return;

  TL.frames = snaps.map((s, i) => ({
    timestamp: s.timestamp,
    date: s.date,
    isFirst: i === 0,
    gapDays: i === 0 ? 0
      : Math.round((new Date(s.date) - new Date(snaps[i - 1].date)) / 86400000),
    counts: null,     // what changed to reach this frame
    total: 0,
    failed: false,    // the Archive could not produce this capture
  }));
}

// One entry per capture, built from the snapshot list alone — no fetch, no
// waiting. That is why the rail and scrubber are complete before phase one
// starts, and why a seek can go anywhere in the record immediately.

// ---------------------------------------------------------------- open / close
el('openTimelapseBtn').addEventListener('click', openTimelapse);
el('tlModalClose').addEventListener('click', closeTimelapse);
el('timelapseBackdrop').addEventListener('click', closeTimelapse);

function openTimelapse() {
  if (!state.snapshots || state.snapshots.length < 2) return;

  el('timelapseModal').hidden = false;
  el('tlSiteName').textContent = state.url;
  document.body.style.overflow = 'hidden';

  const snaps = state.snapshots;
  el('tlFirstDate').textContent = formatDate(snaps[0].date);
  el('tlLastDate').textContent = formatDate(snaps[snaps.length - 1].date);
  el('tlAddress').textContent = state.url;

  tlBuildFrames();
  tlBuildRail();
  tlUpdateSubtitle();

  if (TL.forUrl !== state.url) {
    TL.forUrl = state.url;
    TL.index = 0;
    tlRingClear();
  }

  // Always, including on a reopening. Attaching to a reading that is already
  // running is the store's job, not this file's, so there is no "already
  // running" case to special-case here: either the record is on disk and this
  // resolves at once, or this watches it, and neither can start a second walk.
  startPhaseOne();
}

function closeTimelapse() {
  // A recording is not thrown away because the film was closed: the file is
  // what was asked for, so it is finished and handed over first.
  if (TL.export.state === 'recording') tlExportFinish();
  else if (TL.export.state === 'saved') tlExportRelease();

  el('timelapseModal').hidden = true;
  document.body.style.overflow = '';
  tlSetPlaying(false);
  // Stop listening to the reading. The reading itself carries on — if the
  // dashboard is open it is probably the one driving it — but a closed film
  // should not keep repainting a progress card nobody is looking at.
  TL.gen++;
}

// ---------------------------------------------------------------- phase one
// Waiting on the record. There is nothing to decide here: the store either
// already has this record, in which case this resolves in milliseconds, or it
// is reading it now, in which case this attaches to that same reading and
// watches it. It never starts a second walk of a history someone is already
// walking.
async function startPhaseOne() {
  TL.gen++;
  const myGen = TL.gen;

  TL.phase = 'retrieving';
  TL.progress = { done: 0, total: Math.max(0, tlTotal() - 1), year: null, etaSeconds: 0 };
  tlSetPlaying(false);
  tlShowLoader(true);
  tlPaintLoader();

  const record = await arEnsure(state.url, state.snapshots, (p) => {
    if (TL.gen !== myGen) return;
    TL.progress = {
      done: p.done,
      total: p.total,
      year: p.date ? new Date(p.date).getFullYear() : null,
      etaSeconds: p.etaSeconds,
    };
    tlScaleTicks();
    tlPaintLoader();
  });
  if (TL.gen !== myGen) return;   // superseded by a newer reading

  // The counts describe what changed to reach each capture, so they land on the
  // capture that follows them. The first capture has nothing before it and so
  // has no counts of its own - it is still a frame, and still plays.
  TL.frames.forEach((f, i) => {
    if (record.counts[i]) {
      f.counts = record.counts[i];
      f.total = record.totals[i] || 0;
    }
    f.failed = !record.docs[i];
  });

  tlMarkReady();
  tlScaleTicks();
  tlUpdateSubtitle();
  await tlShowFrame(TL.index);
  tlShowLoader(false);
}

// Handing over from phase one to phase two. This has to actively unlock the
// transport, not merely flip a flag: the play button is disabled while the
// record is incomplete, and if this only set `phase` the button would stay
// disabled forever — a film you can look at but never start, which is exactly
// what happened before this function existed.
function tlMarkReady() {
  TL.phase = 'ready';
  tlSetPlaying(false);   // refreshes the disabled state from the new phase
  tlPreparePaint();
}

// ---------------------------------------------------------------- documents
// Reading one page for playback. The record is on this machine, so this is
// effectively instant — which is the whole reason phase one exists. The ring in
// front of it covers stepping back and forth.
async function tlDocFor(i) {
  const f = TL.frames[i];
  if (!f) return null;
  if (TL.ring.has(i)) return TL.ring.get(i);

  const val = await arDoc(state.url, f.timestamp);
  if (typeof val === 'string' && val.length) {
    tlRingSet(i, val);
    return val;
  }
  return null;
}

// ---------------------------------------------------------------- stage
// The stage is a pool of iframes rather than a pair. Each one holds one
// capture that is already rendered, and the film shows whichever one holds the
// frame it is on. That is where its smoothness comes from: by the time the
// film reaches a capture, the capture arrived in a slot behind the one on
// screen. Two iframes can only ever hold "now" and "next", and an archived
// page takes longer to arrive than a frame lasts — so "next" was still on its
// way every single time it was needed.
const TL_SLOTS = 5;

// How many frames ahead of the playhead must be loaded before Play unlocks.
// This is the promise the film makes: pressing play starts a film, not a
// loading screen.
const TL_RUNWAY = 3;

// One entry per stage slot: { el, index, state, token, timer, done }.
let tlSlots = [];
let tlFrontSlot = null;   // the slot on screen; null until the first frame lands
let tlPrefetching = false;

function tlSlotsInit() {
  if (tlSlots.length) return;
  const viewport = el('tlViewport');
  const seed = [el('tlFrameA'), el('tlFrameB')];
  for (let n = 0; n < TL_SLOTS; n++) {
    let frame = seed[n];
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'tl-frame';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.title = 'Archived snapshot';
      // Ahead of the date card and the counts, so those stay on top of
      // whatever the page underneath is doing.
      viewport.insertBefore(frame, el('tlDateCard'));
    }
    tlSlots.push({ el: frame, index: -1, state: 'empty', token: 0, timer: null, done: null, heal: null });
  }
}

function tlSlotHolding(i) {
  return tlSlots.find((s) => s.index === i && s.state === 'ready') || null;
}

// Which slot takes the next capture? An empty one, otherwise the one holding
// the least useful frame. The slot on screen is never chosen: rewriting it
// would take the current frame away before the next one has arrived, which is
// the blank-stage failure in a different costume.
function tlSlotFor(i) {
  const spare = tlSlots.filter((s) => s !== tlFrontSlot);
  const pool = spare.length ? spare : tlSlots;
  const empty = pool.find((s) => s.state === 'empty');
  if (empty) return empty;
  // A slot that already holds a rendered frame is preferred, because a slot
  // that is mid-load belongs to a capture the film is still going to want. Only
  // when there is nothing else is one taken away from its load.
  const idle = pool.filter((s) => s.state === 'ready');
  const from = idle.length ? idle : pool;
  return from.reduce((a, b) => (Math.abs(b.index - i) > Math.abs(a.index - i) ? b : a));
}

// Scrollbars are hidden inside the frames but scrolling still works. A tall
// archived page grows a scrollbar on one frame and loses it on the next, and
// through hundreds of frames that flicker would be the most visible thing on
// screen — a change the site's owner never made. The compare view keeps its
// scrollbars, because there you are reading the page.
const TL_FRAME_STYLE =
  '<style>html{scrollbar-width:none !important;}' +
  'html::-webkit-scrollbar,body::-webkit-scrollbar{width:0 !important;height:0 !important;}</style>';

// The document transform, and the only one the film applies. injectScrollFix is
// the compare view's, verbatim, so a frame is the same document the compare
// pane writes; the extra rule only hides scrollbars, which flicker from frame
// to frame and are not a change the site's owner ever made.
function tlPrepareFrame(html) {
  let doc = injectScrollFix(html);
  if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head[^>]*>/i, (m) => m + TL_FRAME_STYLE);
  } else {
    doc = TL_FRAME_STYLE + doc;
  }
  return doc;
}

function tlWriteFrame(iframe, doc) {
  // Reassigning an identical srcdoc does not reload the document, so the load
  // event the cross-fade waits on would never fire — and two consecutive
  // captures that render identically is not a rare edge case on a long film.
  if (iframe.srcdoc === doc) return false;
  iframe.srcdoc = doc;
  return true;
}

// Did the frame actually render? A stylesheet or image whose request was
// cancelled in flight counts as absent, and the browser never asks for it
// again — that is how a frame ends up permanently unstyled. Comparing what
// arrived against what the document asked for is the check the compare view
// never needs, because it only ever writes its iframe once.
function tlFrameHealthy(iframe, doc) {
  const d = iframe.contentDocument;
  if (!d || !d.body) return false;
  // Links inside comments are the conditional-comment kind, which no current
  // browser loads, so they must not be counted as expected stylesheets.
  const bare = doc.replace(/<!--[\s\S]*?-->/g, '');
  const wanted = (bare.match(/<link[^>]*rel=["']?stylesheet/gi) || []).length;
  const got = d.styleSheets ? d.styleSheets.length : 0;
  if (wanted && got < wanted) return false;
  const imgs = Array.from(d.images || []);
  const failed = imgs.filter((im) => im.complete && im.naturalWidth === 0).length;
  return failed < 3;
}

function tlSwap(incoming) {
  for (const s of tlSlots) s.el.classList.toggle('is-front', s === incoming);
  tlFrontSlot = incoming;
}

// Load one capture into a slot and say how it went:
//   'ready'   — the slot holds it, rendered
//   'missing' — the capture could not be produced at all
//   'stolen'  — the slot was given another frame while this one loaded
// Everything the film does goes through here — the frame on screen, the
// runway, the frames warmed for later — so there is one loader and one notion
// of what "loaded" means.
function tlStartLoad(slot, i) {
  clearTimeout(slot.timer);
  clearTimeout(slot.heal);
  slot.timer = null;
  slot.heal = null;
  slot.index = i;
  slot.state = 'loading';
  slot.done = tlLoadInto(slot, i);
  return slot.done;
}

// A frame already in a slot is not loaded again, and a frame already loading
// is not started twice: two asks share one load.
function tlEnsureLoaded(i) {
  const ready = tlSlotHolding(i);
  if (ready) return { slot: ready, promise: Promise.resolve('ready') };
  const loading = tlSlots.find((s) => s.index === i && s.state === 'loading');
  if (loading) return { slot: loading, promise: loading.done };
  const slot = tlSlotFor(i);
  if (!slot) return { slot: null, promise: Promise.resolve('missing') };
  return { slot, promise: tlStartLoad(slot, i) };
}

function tlCountStylesheets(doc) {
  // Links inside comments are the conditional-comment kind, which no current
  // browser loads, so they must not be counted as expected stylesheets.
  const bare = doc.replace(/<!--[\s\S]*?-->/g, '');
  return (bare.match(/<link[^>]*rel=["']?stylesheet/gi) || []).length;
}

// Resolve as soon as the frame can be painted: the document is parsed and the
// stylesheets it asked for have been applied. Images are deliberately not part
// of this, and neither is the load event. See TL_READY_MS.
function tlWaitRenderable(slot, prepared, token) {
  const wanted = tlCountStylesheets(prepared);
  return new Promise((resolve) => {
    let poll = null, cap = null, settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(poll);
      clearTimeout(cap);
      resolve(outcome);
    };
    const recording = TL.export.state === 'recording';
    cap = setTimeout(() => finish('ready'), recording ? TL_READY_MS_RECORDING : TL_READY_MS);
    const check = () => {
      if (settled) return;
      if (slot.token !== token) { finish('stolen'); return; }
      const d = slot.el.contentDocument;
      const parsed = !!(d && d.body && d.readyState !== 'loading');
      const styled = !wanted || (d.styleSheets ? d.styleSheets.length : 0) >= wanted;
      const whole = !recording || tlFrameHealthy(slot.el, prepared);
      if (parsed && styled && whole) { finish('ready'); return; }
      poll = setTimeout(check, 40);
    };
    check();
  });
}

// One quiet look, after the frame is on screen, for the failure the browser
// never repairs by itself: a stylesheet whose request was cancelled in flight is
// never asked for again, and that frame stays unstyled forever. A frame that is
// already on screen is worth one reload, and only one.
function tlHealLater(slot, prepared, token) {
  clearTimeout(slot.heal);
  slot.heal = setTimeout(() => {
    if (slot.token !== token || slot.state !== 'ready') return;
    if (tlFrameHealthy(slot.el, prepared)) return;
    // The rewrite changes the document by a trailing comment rather than
    // clearing it first. Clearing would navigate the iframe to an empty page,
    // and a blank frame can reach the stage that way; a changed srcdoc is a
    // plain second navigation, and what it paints is the capture.
    slot.el.srcdoc = prepared + '<!-- palimpsest: reload -->';
  }, TL_HEAL_MS);
}

async function tlLoadInto(slot, i) {
  const token = ++slot.token;

  const doc = await tlDocFor(i);
  if (slot.token !== token) return 'stolen';   // the slot was given another capture
  if (!doc) {
    slot.state = 'empty';
    slot.index = -1;
    return 'missing';
  }

  const prepared = tlPrepareFrame(doc);
  if (!tlWriteFrame(slot.el, prepared)) {
    // This slot already holds this exact document, so it is rendered already —
    // a seek back and forth over one capture.
    slot.state = 'ready';
    return 'ready';
  }

  const outcome = await tlWaitRenderable(slot, prepared, token);
  if (outcome === 'stolen') return 'stolen';

  slot.state = 'ready';
  tlHealLater(slot, prepared, token);
  return 'ready';
}

// Warm the frames ahead of the playhead for as long as the pool has room. This
// is what turns "the next capture" into a promise instead of a hope.
function tlPrefetch() {
  if (tlPrefetching || TL.phase !== 'ready') return;

  const queue = [];
  for (let k = 1; k <= TL_SLOTS - 1; k++) {
    const i = TL.index + k;
    if (i >= tlTotal()) break;
    if (!tlSlots.some((s) => s.index === i)) queue.push(i);
  }
  if (!queue.length) { tlPreparePaint(); return; }

  tlPrefetching = true;

  // Slots are claimed synchronously, before any loading starts, so two lanes
  // can never be handed the same one. Then they load together: one frame at a
  // time cannot feed a film that shows six frames a second.
  const jobs = [];
  for (const i of queue) {
    if (jobs.length >= TL_PREFETCH_LANES) break;
    const slot = tlSlotFor(i);
    if (!slot) break;
    slot.index = i;
    slot.state = 'loading';
    jobs.push(tlStartLoad(slot, i));
  }

  Promise.all(jobs)
    .catch(() => {})
    .then(() => {
      tlPrefetching = false;
      tlPreparePaint();
      // A running film never lets the pipeline run dry: whatever was just
      // loaded is now on the same slots the next beats will read from.
      if (TL.playing) tlPrefetch();
    });
}

// The runway: the frames just ahead of the playhead, loaded.
function tlRunwayReady() {
  const need = Math.min(TL_RUNWAY, tlTotal() - 1 - TL.index);
  if (need <= 0) return true;
  for (let k = 1; k <= need; k++) if (!tlSlotHolding(TL.index + k)) return false;
  return true;
}

// The transport's state in one place. A dark Play button is only acceptable
// when it is dark for a stated reason: the record is not here yet, or the
// frames ahead of it are not loaded yet.
function tlPaintTransport() {
  const btn = el('tlPlay');
  const waiting = !TL.playing && TL.phase === 'ready' && !tlRunwayReady();
  btn.classList.toggle('is-playing', TL.playing);
  btn.disabled = TL.phase !== 'ready' || waiting;
  btn.title = TL.playing ? 'Pause' : (waiting ? 'Loading the frames ahead\u2026' : 'Play');
  btn.setAttribute('aria-label', TL.playing ? 'Pause the timelapse' : 'Play the timelapse');
  el('tlDownloadBtn').disabled = TL.phase !== 'ready';
}

// The runway, stated. A status line rather than a dialog: how many of the
// frames just ahead are loaded, gone the moment they are, so the only thing
// between you and Play is a screen that is already full.
function tlPreparePaint() {
  const row = el('tlPrepare');
  const total = tlTotal();
  if (!total) { row.hidden = true; tlPaintTransport(); return; }

  const need = Math.max(1, Math.min(TL_RUNWAY, total - 1 - TL.index));
  let have = 0;
  for (let k = 1; k <= need; k++) if (tlSlotHolding(TL.index + k)) have++;

  const ready = TL.phase === 'ready' && have >= need;
  const filming = TL.export.state === 'recording' || TL.export.state === 'saved';
  row.hidden = ready || TL.playing || filming || TL.phase !== 'ready';
  el('tlPrepareLabel').textContent =
    `Loading the frames ahead \u00b7 ${tlFmt(have)} of ${tlFmt(need)}`;
  el('tlPrepareFill').style.width = `${Math.round((have / need) * 100)}%`;
  tlPaintTransport();
}

// Paint a frame. The date always lands first, so a caption is never waiting on
// a picture.
//
// The picture lands only once it has loaded. There is deliberately no path
// that shows a document before it renders: writing a document into an iframe
// and showing it in the same breath is what put unstyled pages on screen, and
// the compare view has never had that failure because it writes one document
// into one iframe and leaves it alone. Here that guarantee belongs to the
// loader, and the pool is what keeps the wait off the screen.
async function tlShowFrame(i) {
  const frame = TL.frames[i];
  if (!frame) return;
  tlSlotsInit();

  const token = ++TL.showToken;
  tlPaintDate(frame, i);

  const { slot, promise } = tlEnsureLoaded(i);
  if (!slot) return;

  // With nothing on screen yet there is no previous capture to hold it, so the
  // status light explains the wait rather than a blank stage.
  if (!tlFrontSlot) tlShowBuffer(true, 'opening the capture\u2026');

  const outcome = await promise;
  if (token !== TL.showToken) return;   // a newer frame took over
  if (outcome === 'stolen') return;     // the slot moved on; its new frame owns it

  if (outcome === 'ready') {
    tlSwap(slot);
    tlShowBuffer(false);
    tlPrefetch();
    return;
  }

  // Nothing arrived for this capture. Say so on the stage instead of leaving
  // the previous frame up under a caption that claims to be this one.
  for (const s of tlSlots) s.el.classList.remove('is-front');
  tlFrontSlot = null;
  tlShowBuffer(true, frame.failed
    ? 'that capture is unavailable, stepping past it'
    : 'reading from your machine\u2026');
}

function tlPaintDate(frame, i) {
  el('tlDate').textContent = formatDate(frame.date);

  let gap;
  if (i === 0) {
    gap = 'the first capture on file';
  } else if (frame.gapDays < 1) {
    gap = 'another capture the same day';
  } else {
    gap = `${tlFmt(frame.gapDays)} day${frame.gapDays === 1 ? '' : 's'} since the previous capture`;
  }
  el('tlDateGap').textContent = gap;

  const c = frame.counts;
  el('tlDelta').innerHTML = !c
    ? ''
    : `<span class="tl-delta-fig is-added"><b>+${tlFmt(c.added)}</b></span>` +
      `<span class="tl-delta-fig is-removed"><b>&minus;${tlFmt(c.removed)}</b></span>` +
      `<span class="tl-delta-fig is-changed"><b>~${tlFmt(c.changed)}</b></span>`;
}

// ---------------------------------------------------------------- subtitle
function tlUpdateSubtitle() {
  const n = tlTotal();
  if (!n) return;
  if (TL.phase === 'ready') {
    el('tlSubtitle').textContent =
      `${tlFmt(n)} capture${n === 1 ? '' : 's'} \u00b7 about ${tlRuntime()} at ${TL.speed}\u00d7`;
    return;
  }
  el('tlSubtitle').textContent =
    `${tlFmt(n)} capture${n === 1 ? '' : 's'} \u00b7 retrieving \u2026`;
}

// ---------------------------------------------------------------- rail
// One tick per capture, every capture, at its real position in calendar time.
// Not evenly spaced: the width between two ticks IS the gap the crawler left,
// and evening it out would claim a continuity the archive can't back up.
let tlTickEls = [];

function tlBuildRail() {
  const wrap = el('tlRail');
  const frames = TL.frames;
  if (!frames.length) return;

  const minT = new Date(state.snapshots[0].date).getTime();
  const maxT = new Date(state.snapshots[state.snapshots.length - 1].date).getTime();
  const span = Math.max(1, maxT - minT);
  const W = wrap.clientWidth || 800;
  const spacing = W / Math.max(1, frames.length);
  const w = Math.max(1, Math.min(3, Math.floor(spacing * 0.8)));

  wrap.style.setProperty('--tl-tick-w', `${w}px`);
  el('tlRailTicks').innerHTML = frames.map((f, i) => {
    const x = ((new Date(f.date).getTime() - minT) / span) * W;
    return `<button type="button" class="tl-tick" data-i="${i}" style="left:${x}px"
      title="${escapeHtml(formatDate(f.date))}"></button>`;
  }).join('');

  tlTickEls = Array.from(el('tlRailTicks').children);
  tlScaleTicks();
  tlPaintRailHead();
}

// Tick height is the size of the change that produced that capture. During
// phase one these arrive progressively, so the rail visibly builds itself —
// which is also the only honest thing to do, since we genuinely don't know the
// numbers for a capture we haven't retrieved yet.
function tlScaleTicks() {
  const frames = TL.frames;
  const peak = Math.max(1, ...frames.map((f) => f.total));
  for (let i = 0; i < tlTickEls.length; i++) {
    const f = frames[i];
    if (!f) continue;
    const known = !!f.counts;
    const h = known ? Math.max(14, (f.total / peak) * 100) : (f.isFirst ? 16 : 10);
    const tick = tlTickEls[i];
    if (!tick) continue;
    if (tick.style.height !== h + '%') tick.style.height = h + '%';
    tick.classList.toggle('is-known', known);
  }
}

function tlPaintRailHead() {
  const frames = TL.frames;
  const wrap = el('tlRail');
  if (!frames.length) return;

  const minT = new Date(state.snapshots[0].date).getTime();
  const maxT = new Date(state.snapshots[state.snapshots.length - 1].date).getTime();
  const span = Math.max(1, maxT - minT);
  const W = wrap.clientWidth || 800;
  const x = ((new Date(frames[TL.index].date).getTime() - minT) / span) * W;

  el('tlRailFill').style.width = Math.max(0, x) + 'px';
  el('tlRailHead').style.left = x + 'px';
  el('tlCounter').textContent = `${tlFmt(TL.index + 1)} / ${tlFmt(frames.length)}`;
}

let tlResizeTimer = null;
window.addEventListener('resize', () => {
  if (el('timelapseModal').hidden) return;
  clearTimeout(tlResizeTimer);
  tlResizeTimer = setTimeout(() => { tlBuildRail(); }, 140);
});

el('tlRailTicks').addEventListener('click', (e) => {
  const tick = e.target.closest('.tl-tick');
  if (!tick) return;
  tlSetPlaying(false);
  tlSeek(parseInt(tick.dataset.i, 10));
});

el('tlRail').addEventListener('pointerdown', (e) => {
  if (!tlTotal()) return;
  const rail = el('tlRail');
  rail.setPointerCapture(e.pointerId);
  const seekToEvent = (ev) => {
    const rect = rail.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - rect.left, 0), rect.width);
    tlSeek(tlIndexForX(x, rect.width));
  };
  seekToEvent(e);
  const onMove = (ev) => seekToEvent(ev);
  const onUp = () => {
    rail.releasePointerCapture(e.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

function tlIndexForX(x, width) {
  const minT = new Date(state.snapshots[0].date).getTime();
  const maxT = new Date(state.snapshots[state.snapshots.length - 1].date).getTime();
  const span = Math.max(1, maxT - minT);
  const t = minT + (x / Math.max(1, width)) * span;
  let best = 0, bestDist = Infinity;
  TL.frames.forEach((f, i) => {
    const d = Math.abs(new Date(f.date).getTime() - t);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// ---------------------------------------------------------------- playback
// Playback only ever runs once phase one is complete, so every document below
// is a local read. Nothing here waits on a network.
// Returns when the frame is on screen. Playback and the download both pace
// themselves on that, rather than on a timer that knows nothing about whether
// the capture has arrived.
function tlSeek(i) {
  const n = tlTotal();
  if (!n) return Promise.resolve();
  const next = Math.min(Math.max(i, 0), n - 1);
  TL.index = next;
  const shown = tlShowFrame(next);
  tlPaintRailHead();
  tlPrefetch();
  tlPreparePaint();
  return shown;
}

function tlSetPlaying(on) {
  TL.playing = !!on;
  clearTimeout(TL.timer);
  TL.timer = null;
  TL.nextAt = 0;

  // Play is meaningless until the record is here and the frames ahead of it
  // are loaded. tlPaintTransport is the one place that decides how the button
  // reads, so the reason it is dark can never drift from the truth.
  tlPaintTransport();

  if (TL.playing) tlScheduleNext();
}

// The film runs on a clock, and the clock is the same for every frame. The beat
// is measured from the beat before it rather than from the moment the last
// frame finished, so nothing a frame does can stretch the one after it.
function tlScheduleNext() {
  clearTimeout(TL.timer);
  if (!TL.playing) return;
  const period = TL_FRAME_MS / TL.speed;
  const now = performance.now();
  TL.nextAt = (TL.nextAt && TL.nextAt > now - period) ? TL.nextAt + period : now + period;
  TL.timer = setTimeout(tlAdvance, Math.max(0, TL.nextAt - now));
}

// One beat of the film. This never awaits anything: a capture that is loaded is
// shown, a capture that is not is dropped, and the picture on screen simply
// holds for that beat. Waiting is what made one frame take a minute — a page
// that had to come from the Archive could hold the whole film while it arrived,
// and a film that stops is not a film.
//
// Dropping is not the same as skipping the work: whatever was dropped is still
// being loaded behind the playhead by the prefetcher, so a film that lost
// frames to the network catches up as soon as the pages land.
function tlAdvance() {
  if (!TL.playing) return;
  const n = tlTotal();
  if (!n) { tlSetPlaying(false); return; }

  if (TL.index >= n - 1) {
    // End of the record: stop on the last frame rather than looping. A looping
    // timelapse is a screensaver; this is meant to be watched once through.
    tlSetPlaying(false);
    return;
  }

  // The next beat is scheduled before this one is presented. Painting a capture
  // is what blocks the main thread — parsing a whole archived page takes real
  // time — and a timer set on the far side of that work would be late by it,
  // which is how a film ends up with one long frame followed by a short one.
  tlScheduleNext();

  // The nearest frame that is actually loaded, within one beat's worth of
  // looking. Frames in between were not ready in time, so they are dropped.
  const limit = Math.min(n - 1, TL.index + TL_SKIP);
  let target = -1;
  for (let i = TL.index + 1; i <= limit; i++) {
    if (tlSlotHolding(i)) { target = i; break; }
  }

  if (target >= 0) {
    TL.index = target;
    tlSwap(tlSlotHolding(target));
    tlPaintDate(TL.frames[target], target);
    tlShowBuffer(false);
  } else {
    // Nothing ahead has arrived yet. The picture stays exactly as it is and the
    // playhead moves past the wait, so the film keeps its rhythm instead of
    // stopping on a frame that may never come.
    TL.index = limit;
  }

  tlPaintRailHead();
  tlPrefetch();
}

el('tlPlay').addEventListener('click', () => {
  if (TL.phase !== 'ready') return;
  if (!TL.playing && TL.index >= tlTotal() - 1) {
    TL.index = 0;
    tlPaintRailHead();
    tlShowFrame(0);
  }
  tlSetPlaying(!TL.playing);
});

el('tlRestart').addEventListener('click', () => {
  if (TL.phase !== 'ready') return;
  tlSeek(0);
  if (TL.playing) tlScheduleNext();
});

document.querySelectorAll('.tl-speed').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tl-speed').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    TL.speed = parseFloat(btn.dataset.speed) || 1;
    tlUpdateSubtitle();
    TL.nextAt = 0;   // a new pace is a new clock
    if (TL.playing) tlScheduleNext();
  });
});

// Space plays and pauses, the arrows step frame by frame — the same three keys
// a video player would use, because that is what this is.
document.addEventListener('keydown', (e) => {
  if (el('timelapseModal').hidden) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) return;

  if (e.key === 'Escape') { closeTimelapse(); return; }
  if (e.key === ' ') {
    e.preventDefault();
    if (TL.phase === 'ready') el('tlPlay').click();
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    tlSetPlaying(false);
    tlSeek(TL.index + 1);
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    tlSetPlaying(false);
    tlSeek(TL.index - 1);
  }
});

// ---------------------------------------------------------------- status
function tlShowLoader(on) {
  el('tlLoader').hidden = !on;
}

// The progress card. A wait this long has to be legible: what it is doing,
// how far along, and how much is left, or it is indistinguishable from a hang.
// Every number here is the store's, not this file's — if the dashboard is what
// started the reading, this card is reporting on someone else's progress and
// is right to do so.
function tlPaintLoader() {
  const n = tlTotal();
  const { done, total, year, etaSeconds } = TL.progress;
  const steps = total || Math.max(0, n - 1);
  const pct = steps ? Math.min(100, Math.round((done / steps) * 100)) : 0;

  el('tlLoaderText').textContent = `Retrieving capture ${tlFmt(done + 1)} of ${tlFmt(n)}`;
  el('tlLoadFill').style.width = pct + '%';

  let sub;
  if (!done) {
    sub = 'Reaching for the Internet Archive\u2026';
  } else if (done >= steps) {
    sub = 'Filing the last pages\u2026';
  } else {
    sub = `${pct}% \u00b7 now covering ${year || 'the record'} \u00b7 about ${tlHumanSeconds(etaSeconds)} left`;
  }
  el('tlLoadSub').textContent = sub;
}

// A small status light rather than a screen-covering panel. It only ever
// appears for a capture that genuinely could not be retrieved; in normal
// playback it is never seen, because phase one has already finished.
function tlShowBuffer(on, text) {
  // The status light sits inside the frame, so anything it says while the film
  // is being recorded would end up in the file. A recording watches a film
  // whose frames are already loaded; it has nothing to announce.
  if (on && TL.export.state === 'recording') on = false;
  el('tlBuffer').hidden = !on;
  if (on && text) el('tlBufferText').textContent = text;
}

// Start from a known state: nothing playing, and the transport locked until
// phase one hands over a complete record.
tlSetPlaying(false);
tlPaintExportHud();

// ---------------------------------------------------------------- download
// The film can be kept. What this records is the film itself — the same stage,
// the same captures, the date card and the counts in frame — because the only
// honest way to export a page the browser rendered is to film the screen it
// was rendered on. Nothing is re-rendered for the file, so nothing in the file
// can disagree with what was on screen.
//
// The pace is seconds per capture, not a frame rate. One capture is one still
// moment of a site's life, and holding it long enough to read is the point.
const TL_EXPORT_PACES = [0.25, 0.5, 1];

function tlSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tlClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tlBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function tlExportEstimate() { return tlHumanSeconds(tlTotal() * TL.export.pace); }

function tlExportOpen() {
  if (TL.phase !== 'ready' || !tlTotal() || TL.export.state === 'recording') return;
  tlSetPlaying(false);
  TL.export.state = 'card';
  tlPaintExportCard();
  el('tlExport').hidden = false;
}

function tlExportCloseCard() {
  el('tlExport').hidden = true;
  if (TL.export.state === 'card') TL.export.state = 'idle';
}

function tlPaintExportCard() {
  const total = tlTotal();
  el('tlExportTitle').textContent =
    total === 1 ? 'One capture, as a video' : `${tlFmt(total)} captures, as a video`;
  el('tlExportSub').textContent =
    'One still moment per capture, with the date and the counts in frame. ' +
    'Each is held for the beat below, once it has loaded. ' +
    'The browser records this tab while the film plays it, so leave this tab in front.';
  for (const btn of document.querySelectorAll('.tl-export-pace')) {
    btn.classList.toggle('is-active', parseFloat(btn.dataset.pace) === TL.export.pace);
  }
  el('tlExportTime').textContent = `\u2248 ${tlExportEstimate()}`;
  el('tlExportNote').textContent =
    'When the browser asks what to share, choose \u201cThis tab\u201d.';
}

// Record the film. The stream is this tab; the crop is the stage, so the file
// holds the browser window, the page, the date card and the counts, and not
// the transport that drove them.
async function tlExportStart() {
  const total = tlTotal();
  if (TL.phase !== 'ready' || !total || TL.export.state === 'recording') return;
  tlSetPlaying(false);

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    });
  } catch (_) {
    el('tlExportNote').textContent =
      'Nothing was recorded. Sharing this tab was declined.';
    return;
  }

  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  video.className = 'tl-export-video';
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  document.body.appendChild(video);
  try { await video.play(); } catch (_) {}

  // The state flips to recording before the crop is measured, because that
  // flip is what swaps the transport for the recording row — and that swap
  // changes the stage's height. The crop has to measure the stage the film is
  // about to be shown in, not the one it was shown in while the download was
  // still a card.
  Object.assign(TL.export, {
    state: 'recording', on: true, finishing: false, rec: null, track, video,
    chunks: [], mime: '', ext: 'webm', index: 0, startedAt: 0,
  });
  tlExportCloseCard();
  tlPaintExportHud();

  const rect = document.querySelector('.tl-stage').getBoundingClientRect();
  const map = video.videoWidth ? video.videoWidth / window.innerWidth : 1;
  const sourceX = rect.left * map;
  const sourceY = rect.top * map;
  const sourceW = Math.max(2, rect.width * map);
  const sourceH = Math.max(2, rect.height * map);
  const width = Math.max(2, Math.round(Math.min(1920, sourceW)));
  const height = Math.max(2, Math.round((width / sourceW) * sourceH));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  // The container, named after the container — not after the codec string,
  // which starts with "video/mp4;codecs=..." and is what the file is.
  const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
  const rec = new MediaRecorder(
    canvas.captureStream(30),
    mime ? { mimeType: mime, videoBitsPerSecond: 12000000 } : undefined,
  );
  TL.export.rec = rec;
  TL.export.mime = mime;
  TL.export.ext = ext;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) TL.export.chunks.push(e.data); };
  TL.export.done = new Promise((resolve) => { rec.onstop = resolve; });
  track.addEventListener('ended', tlExportFinish);

  // The first capture goes up before the recording starts, so the file opens
  // on the beginning of the record rather than on whatever was on screen.
  await tlSeek(0);
  await tlSleep(260);

  let tick = 0;
  const draw = () => {
    if (!TL.export.on) return;
    try { ctx.drawImage(video, sourceX, sourceY, sourceW, sourceH, 0, 0, width, height); } catch (_) {}
    if (tick++ % 30 === 0) tlPaintExportHud();
    TL.export.raf = requestAnimationFrame(draw);
  };
  draw();
  // The clock starts with the file, not with the click: everything before this
  // point is the first capture being put on screen, and counting it would make
  // the row's elapsed time describe the preparation rather than the recording.
  TL.export.startedAt = Date.now();
  rec.start(1000);

  // Every capture, in order, each held for the chosen beat. The frame is
  // awaited first, so the file never contains a page that has not arrived.
  const paceMs = TL.export.pace * 1000;
  for (let i = 0; i < total; i++) {
    if (!TL.export.on) break;
    TL.export.index = i;
    tlPaintExportHud();
    await tlSeek(i);
    if (!TL.export.on) break;
    await tlSleep(paceMs);
  }
  tlExportFinish();
}

// Stop, close the file, hand it over. Safe to call from anywhere: the sharing
// track ending, the stop button, or the film closing.
async function tlExportFinish() {
  if (TL.export.state !== 'recording' || TL.export.finishing) return;
  TL.export.finishing = true;
  TL.export.on = false;
  cancelAnimationFrame(TL.export.raf);

  const { rec, track, done, chunks, mime, ext } = TL.export;
  if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} }
  if (done) await done;
  if (track) track.stop();
  if (TL.export.video) { TL.export.video.srcObject = null; TL.export.video.remove(); }

  const blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  TL.export.blob = blob;
  TL.export.finishing = false;

  if (!blob.size) {
    TL.export.state = 'idle';
    tlPaintExportCard();
    el('tlExportNote').textContent =
      'Nothing was recorded. The share ended before the film started.';
    el('tlExport').hidden = false;
    tlPaintExportHud();
    return;
  }

  const first = TL.frames[0] ? TL.frames[0].date.slice(0, 10) : 'film';
  const slug = state.url.replace(/[^a-z0-9.]+/gi, '-');
  TL.export.name = `palimpsest-${slug}-${first}-${tlTotal()}-captures.${ext}`;
  TL.export.url = URL.createObjectURL(blob);
  TL.export.state = 'saved';
  tlExportSave();
  tlPaintExportHud();
}

// The click that is the download, kept callable so the saved row can hand the
// file over again without recording it a second time.
function tlExportSave() {
  if (!TL.export.url) return;
  const a = document.createElement('a');
  a.href = TL.export.url;
  a.download = TL.export.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function tlExportRelease() {
  if (TL.export.url) URL.revokeObjectURL(TL.export.url);
  TL.export.url = null;
  TL.export.blob = null;
  TL.export.chunks = [];
  if (TL.export.state === 'saved') TL.export.state = 'idle';
  tlPaintExportHud();
}

// The recording row, which replaces the transport while a file is being made.
// It sits below the stage on purpose: it is outside the crop, so it can never
// end up in the file it is describing.
function tlPaintExportHud() {
  const st = TL.export.state;
  const busy = st === 'recording';
  const saved = st === 'saved';
  const taken = busy || saved;

  el('tlRailWrap').hidden = taken;
  el('tlControls').hidden = taken;
  el('tlRecording').hidden = !taken;

  if (busy) {
    const total = tlTotal();
    const elapsed = TL.export.startedAt ? (Date.now() - TL.export.startedAt) / 1000 : 0;
    // The remaining time is measured from this recording's own rate, not from
    // the chosen pace: a capture that has to arrive from the Archive takes
    // longer than its beat, and a countdown that ignored that would promise a
    // file that is minutes shorter than the one being made.
    const per = TL.export.index > 0 ? elapsed / TL.export.index : TL.export.pace;
    const left = Math.max(0, (total - TL.export.index) * per);
    el('tlRecDot').hidden = false;
    el('tlRecLabel').textContent =
      `Recording capture ${tlFmt(Math.min(TL.export.index + 1, total))} of ${tlFmt(total)}`;
    el('tlRecTime').textContent = `${tlClock(elapsed)} \u00b7 \u2248${tlHumanSeconds(left)} left`;
    el('tlRecAction').textContent = 'Stop & save';
    el('tlRecDone').hidden = true;
  } else if (saved) {
    el('tlRecDot').hidden = true;
    el('tlRecLabel').textContent =
      `Saved ${TL.export.name} \u00b7 ${tlBytes(TL.export.blob ? TL.export.blob.size : 0)}`;
    el('tlRecTime').textContent = '';
    el('tlRecAction').textContent = 'Download again';
    el('tlRecDone').hidden = false;
  } else {
    el('tlRecDot').hidden = true;
    el('tlRecLabel').textContent = '';
    el('tlRecTime').textContent = '';
    el('tlRecAction').textContent = 'Stop & save';
    el('tlRecDone').hidden = true;
  }
  tlPreparePaint();
}

el('tlDownloadBtn').addEventListener('click', tlExportOpen);
el('tlExportCancel').addEventListener('click', tlExportCloseCard);
el('tlExportStart').addEventListener('click', tlExportStart);
document.querySelectorAll('.tl-export-pace').forEach((btn) => {
  btn.addEventListener('click', () => {
    TL.export.pace = parseFloat(btn.dataset.pace) || 0.5;
    tlPaintExportCard();
  });
});
el('tlRecAction').addEventListener('click', () => {
  if (TL.export.state === 'recording') tlExportFinish();
  else if (TL.export.state === 'saved') tlExportSave();
});
el('tlRecDone').addEventListener('click', tlExportRelease);
