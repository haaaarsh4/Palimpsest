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
// ## Three phases, on purpose
//
// **Phase one retrieves the whole record. Phase two renders the frames ahead.
// Phase three plays them.** Nothing starts until the record has arrived, and
// nothing advances until the capture it advances to is complete on screen.
//
// That ordering is forced by the Archive, not chosen for drama. lib/rateLimiter.js
// serialises every outgoing request to web.archive.org at one per 1.1s across
// the whole process, so a 740-capture record is over thirteen minutes of
// fetching the first time any machine reads it. Fetching on demand would only
// move that wait into the middle of the film, where it is far worse: a
// slideshow that stutters. Paying it once, up front, with an honest progress
// bar, is the better trade.
//
// ## A capture is not shown until it is the whole page
//
// The film used to keep a clock and drop whatever the clock outran: a frame was
// declared showable once its document had parsed and its stylesheets had
// landed, and images were allowed to arrive afterwards, on screen. That is fine
// at one frame every two and a half seconds and wrong at sixteen frames a
// second, where a capture that is still pulling its images across is not a
// record of what the site looked like, it is a record of how fast the network
// was. Fixing that is the whole of this file's current design: **a frame is
// shown when it is parsed, styled, decoded, and painted, and only then.**
//
// The cost is paid before the film starts, which is the deal a viewer can see:
// the frames ahead are loaded and rendered while the transport still says so,
// and Play unlocks when the runway at the current pace is complete. Nothing is
// dropped afterwards, ever. A capture that is still arriving holds the previous
// capture on screen and says which one it is waiting for; a capture the Archive
// cannot produce at all is stepped over and named on screen. What never happens
// is a frame that was never finished becoming a frame of the film.
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

// How long a frame may take to become complete before the film gives up on
// waiting for the last of it. This is not a beat and it is not a target: it is
// the point past which something is genuinely broken, and it exists so that one
// page whose request hung cannot stop the film forever. Everything below it is
// waited for without complaint, because a frame that is not finished is not a
// frame of this film.
const TL_PAINT_MAX_MS = 12000;

// How long a frame waits for images that are still in flight once everything
// else about it has settled, before it gives each of them one more chance.
// A request can be accepted by the Archive and then never answered, and the
// browser will not ask a second time by itself: without this, one photograph
// that nobody is ever going to send can hold a frame to the ceiling, and at 16x
// that is a seven second hole in the film. Re-assigning the source is the
// cheapest possible retry and it can only make the frame arrive sooner.
const TL_STRAGGLER_MS = 2500;

// How many frames the store is asked for at once. Each one is a whole archived
// page with its own images, and they are independent requests, so this is the
// width of the pipeline that fills the pool.
//
// This is the number of frames that may be RENDERING at once, and it is not a
// free dial. Every frame is a document, and every document opens every request
// it references at the same moment: eleven of them against an Archive that
// answers each one in a few hundred milliseconds means a queue of three hundred
// requests, and the frame the film needs next waits behind the pictures of a
// frame ten positions away. So while the record is still being warmed the render
// pool is kept narrow, two, and it is only widened to its full width once the
// assets ahead are in the cache, where a frame costs memory reads rather than
// network round trips. TL_WARM_RENDER_LANES is that narrow width.
const TL_PREFETCH_LANES = 10;
const TL_WARM_RENDER_LANES = 2;

// How long after a frame reaches the screen it is checked for the one failure
// the browser never repairs by itself: a stylesheet whose request died in
// flight is never asked for again, and the frame stays unstyled forever. A frame
// that is already on screen is worth one reload, and only one.
const TL_HEAL_MS = 1500;

// How many documents are kept in memory during playback. Playback reads one at
// a time out of the record store; this ring only exists so stepping back and
// forth across a few frames doesn't re-read from disk each time.
const TL_DOC_RING = 16;

// The stage's own fade, as a ceiling. At 1x a cross-fade is the difference
// between a film and a slideshow; at 16x a 420ms dissolve means two captures are
// on the glass at once for most of the run, which is its own version of a frame
// nobody finished. The fade is scaled to the beat below and clamped to this.
const TL_FADE_MAX_MS = 420;
const TL_FADE_MIN_MS = 60;

// Warming the frames past the pool. A captured page is slow for exactly one
// reason: its images have never been fetched, and a photograph that has to come
// across takes seconds. The pool can only hold twelve rendered frames, so
// rendering a frame ahead of that is a dead end, but its pictures do not need a
// document: pulling them into the browser's own cache costs a request and no
// memory, and when that frame does reach a slot the render is the few hundred
// milliseconds it should have been. This is what the pool is standing on at 16x.
//
// The horizon is deep on purpose, deeper than one pass of the film can need.
// A warmed asset is bytes in the browser's own cache rather than a document on
// the heap, so depth costs the Archive a request and costs this tab nothing; and
// once the asset URLs have been rendered down to one per original (see
// tlCanonicalize) the deeper frames are asking for files already asked for. Six
// hundred frames is nearly forty seconds of film at 16x, and it is simply taken.
//
// The lanes are what decides whether the film ever waits. Six while it runs,
// three while it is parked, and ten of one frame's assets in flight together
// inside a lane: a page's pictures are independent requests and its own document
// asks for them that way, so warming them one per lane would be slower than the
// film itself. Every URL is asked for once per session, whatever happens to it,
// and the queue is rebuilt from the playhead as it drains (see tlWarmAhead), so
// no lane is ever spent on a frame the film has already passed.
const TL_WARM_AHEAD = 600;
const TL_WARM_LANES = 3;
const TL_WARM_LANES_PLAYING = 6;
const TL_WARM_PER_FRAME = 80;
// The width of one frame's asset rack: how many of its pictures are in flight
// together. The Archive answers a request it has never served out of cold
// storage and that costs it seconds, so this is chosen to keep a rack full
// without ever looking like a flood, quiet enough to stay welcome, wide enough
// that one slow picture is not one slow lane.
const TL_WARM_FRAME_LANES = 8;
// Every warm request is given a deadline, and that is not a nicety. Warming runs
// in lanes and a lane ends when its request does, so one request that is accepted
// and then never answered would hold its lane, the pass, and every later pass
// with it: the film would spend the rest of the session with warming switched
// off and never say so. A speculative asset that takes longer than this is not
// worth waiting for anyway; if the frame ever needs it, the frame fetches it.
// Long enough to outlast the server's own upstream deadline (20s): a cold asset
// it is fetching right now will be answered to this rack before the rack gives
// up, and the next ask for the same URL is a disk read.
const TL_WARM_TIMEOUT_MS = 25000;

const TL = {
  gen: 0,        // bumped whenever a load is superseded or abandoned
  forUrl: null,
  frames: [],
  index: 0,      // the capture that is ON SCREEN, never one that is still coming
  target: 0,     // the capture the film is working towards (a seek, or the beat)
  playing: false,
  speed: 1,
  timer: null,
  // Every beat carries a token. An advance that was waiting on a capture when
  // the film was paused, seeked or restarted is holding a stale one, and lets
  // go of it instead of moving a film that has already moved on.
  beat: 0,
  // What the film is waiting for, in one place, so the status light and the
  // transport can never disagree with each other about it.
  waiting: null,
  phase: 'idle', // 'idle' | 'retrieving' | 'ready'
  // Guards the frame on screen: a show that lost the race to a newer one must
  // not swap when it finally arrives.
  showToken: 0,
  // The download. `on` is the recording loop's switch; the rest is what it
  // needs to stop cleanly and hand over a file.
  export: {
    state: 'idle',   // 'idle' | 'card' | 'recording' | 'saved'
    on: false, finishing: false, index: 0, composed: 0, failures: 0, pace: 0.5,
    rec: null, track: null, chunks: [], mime: '', ext: 'webm', width: 0, height: 0,
    palette: null, done: null, blob: null, url: null, name: '', startedAt: 0,
    // How far the file has got: `written` captures in it, `beat` frames handed
    // to the encoder (the two differ by the holds), `repeats` of those holds.
    written: 0, beat: 0, repeats: 0, tick: null, seconds: 0,
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

// One entry per capture, built from the snapshot list alone, no fetch, no
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
  tlWarmTicker();

  if (TL.forUrl !== state.url) {
    TL.forUrl = state.url;
    TL.index = 0;
    tlRingClear();
    tlWarmReset();
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
  clearInterval(tlWarmTick);
  tlWarmTick = null;
  // Stop listening to the reading. The reading itself carries on, if the
  // dashboard is open it is probably the one driving it, but a closed film
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
  TL.progress = { done: 0, total: Math.max(0, tlTotal() - 1), year: null, etaSeconds: 0, stage: 'record' };
  tlSetPlaying(false);
  tlShowLoader(true);
  tlPaintLoader();

  // Opening the film, and reading the numbers behind it, are two different
  // waits and only the first one is worth a card. The pages come from this
  // machine in one response; the numbers are measured on the server, once per
  // site, at about 66ms a capture. So the film opens the moment every page has
  // been answered, and the rail fills in behind it as the measurements land -
  // which is what it has always done during a reading.
  let opened = false;
  const open = (record) => {
    if (TL.gen !== myGen || opened) return;
    opened = true;
    tlApplyRecord(record);
    tlMarkReady();
    tlShowLoader(false);
    tlScaleTicks();
    tlUpdateSubtitle();
    tlShowFrame(TL.index);
  };

  let record;
  try {
    record = await arEnsure(state.url, state.snapshots, (p) => {
      if (TL.gen !== myGen) return;
      TL.progress = {
        done: p.done,
        total: p.total,
        year: p.date ? new Date(p.date).getFullYear() : null,
        etaSeconds: p.etaSeconds,
        stage: p.stage,
      };
      // The numbers arrive after the film is already playing, so they are
      // applied from the progress event itself: a rail that filled in only when
      // the reading finished would stay empty through the whole film.
      if (p.stage === 'numbers' && p.counts) tlApplyCounts(p.counts, p.totals);
      tlScaleTicks();
      tlPaintLoader();
    }, open);
  } catch (err) {
    // Nothing is left waiting on nothing. The card said what it was doing, so
    // it has to be the thing that says it stopped.
    if (TL.gen !== myGen) return;
    tlShowLoader(true);
    el('tlLoaderText').textContent = 'The record could not be read';
    el('tlLoadSub').textContent = 'The server did not answer. Close this and open it again.';
    el('tlLoadFill').style.width = '0%';
    return;
  }
  if (TL.gen !== myGen) return;   // superseded by a newer reading

  tlApplyRecord(record);
  if (!opened) open(record);       // the pages arrived with the numbers
  tlScaleTicks();
  tlUpdateSubtitle();
  tlShowFrame(TL.index);
  tlShowLoader(false);
}

// The counts describe what changed to reach each capture, so they land on the
// capture that follows them. The first capture has nothing before it and so has
// no counts of its own - it is still a frame, and still plays.
function tlApplyCounts(counts, totals) {
  if (!counts) return;
  TL.frames.forEach((f, i) => {
    if (counts[i]) {
      f.counts = counts[i];
      f.total = (totals && totals[i]) || 0;
    }
  });
}

// What a reading hands over: which captures are on disk, which the Archive does
// not have, and whatever numbers have been measured so far. A frame is only
// ever marked unavailable from a reading that asked, and was told no.
function tlApplyRecord(record) {
  if (!record) return;
  tlApplyCounts(record.counts, record.totals);
  if (record.docs) TL.frames.forEach((f, i) => { f.failed = !record.docs[i]; });
}

// Handing over from phase one to phase two. This has to actively unlock the
// transport, not merely flip a flag: the play button is disabled while the
// record is incomplete, and if this only set `phase` the button would stay
// disabled forever, a film you can look at but never start, which is exactly
// what happened before this function existed.
function tlMarkReady() {
  TL.phase = 'ready';
  tlSetPlaying(false);   // refreshes the disabled state from the new phase
  tlPreparePaint();
}

// ---------------------------------------------------------------- documents
// Reading one page for playback. The record is on this machine, so this is
// effectively instant, which is the whole reason phase one exists. The ring in
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

// ---------------------------------------------------------------- warming
const tlWarmed = new Set();   // asset -> already asked for, once per record

// The queue, not the pass, is what the lanes work on. A frame's assets enter it
// in the order the film will need them, nearest past the pool first, and a
// pass that outlives its horizon drops whatever the playhead has already reached
// rather than finishing work nobody wants. That is the failure this replaces: a
// pass that read the horizon once and fetched it as one block spent its budget
// on frames the film had gone by, which is exactly when warming was needed.
const tlWarmQueue = [];       // frame indices, nearest past the pool first
let tlWarmFrame = 0;          // the next frame index to enqueue
let tlWarmActive = 0;         // lanes running right now

function tlWarmReset() {
  tlWarmed.clear();
  tlCanonTs.clear();
  tlWarmDone.clear();
  tlWarmNeeded.clear();
  tlWarmQueue.length = 0;
  tlWarmFrame = 0;
  tlCoveredBest = -1;
  tlCoveredAt = performance.now();
}

const tlWarmDone = new Set();   // frames whose assets have all been answered
const tlWarmNeeded = new Set(); // frames the film is waiting on right now

// The Archive rewrites every asset in a capture's markup to a URL carrying that
// capture's own timestamp, /web/20010107135200im_/<original>, so the same logo,
// the same spacer and the same stylesheet are a DIFFERENT URL in every frame of
// the record. That is the whole reason a film stalls. A resource the Archive has
// not served before comes back out of cold storage and costs it about three
// seconds (its own server-timing says so), so a page whose thirty pictures are
// thirty new URLs is half a minute of waiting no matter how wide the pool is.
// The slice measured here asked for 2,251 distinct asset URLs that are really
// 128 files.
//
// Rendering that rewriting back to one URL per original collapses the work. The
// one URL is chosen the first time this session sees the original and never
// changes, so a picture warmed for frame 3 is the same URL frame 40 asks for.
// The version that gets pinned is the one the run met first, for a run that
// starts at the beginning of the record, the earliest, and a picture the site
// itself replaced keeps the version it had when the film reached it.
//
// The URL it is rewritten to is this app's own asset cache (/api/asset), not the
// Archive. That is the half that makes a frame cost milliseconds: the server has
// each asset on disk after fetching it once, so a frame's thirty pictures are
// thirty file reads over loopback, and the Archive is asked for a file exactly
// once per machine rather than once per frame, per session, forever.
// The scheme is part of the match, not left behind: replacing from the `//`
// onward would leave the capture's own `https:` in front of the new URL and
// produce `https:http://...`, which the browser resolves as a path against the
// document's base rather than as an address of its own.
//
// The host is optional, and that is the difference between a film that renders
// and one that does not. The Archive rewrites a capture's assets in two shapes,
// and it uses the second one for almost everything:
//
//   https://web.archive.org/web/20150205222010cs_/http://settlement.org/Site.css
//   /web/20150205222010cs_/http://settlement.org/Site.css
//
// Only the first names web.archive.org, so a pattern that insisted on the host
// walked straight past the other 160 URLs in that frame. Those then resolved
// against OUR origin, `/web/...` is an absolute path, so the base cannot save
// it, and every one of them was a 404: the stylesheets never applied, and not
// one photograph arrived. The page still looked like a page, which is what made
// it look like a rendering bug rather than a missing rewrite. Measured on that
// frame: 212 asset URLs, 160 of them in the shape nothing was rewriting.
const TL_ASSET_RE = /(?:(?:https?:)?\/\/web\.archive\.org)?\/web\/(\d{14})([a-z_]*\/)([^\s"'()<>\\]+)/g;
const tlCanonTs = new Map();   // original (modifier + path) -> the timestamp this run uses

// Literal, not URLSearchParams: this string is written into archived markup, so
// every character that could end an attribute is escaped by hand. Absolute, not
// root-relative, and that is not cosmetic: an archived document carries the
// Archive's own <base href>, so a path like /api/asset would resolve against
// web.archive.org and be blocked. The origin is this app's, always.
// The asset route's own revision, and it has to be here as well as on the
// server. Every asset response is served `immutable, max-age=1y`, so the copy
// in the browser's cache is not asked for again for a year, which means a
// correction to what the server hands back for one address can never reach a
// browser that already had the wrong one. Changing the address is the only way
// to ask again. Kept equal to ASSET_VERSION in lib/assetCache.js.
const TL_ASSET_VERSION = 4;

function tlAssetUrl(mod, ts, url) {
  const bare = mod.replace(/\/+$/, '');   // the modifier without the separator
  return location.origin + '/api/asset?m=' + encodeURIComponent(bare) + '&t=' + ts + '&u=' +
    encodeURIComponent(url).replace(/'/g, '%27') + '&v=' + TL_ASSET_VERSION;
}

// The Archive's own base, unwrapped: the capture's timestamp and modifier, and
// the address the document was written against.
const TL_BASE_URL_RE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})([a-z_]*)\/(.*)$/i;

// A document's base, made ours.
//
// This is the half of the archive's rewriting that the markup cannot be trusted
// to carry. Wayback rewrites the URLs it can see, and a relative one it cannot:
// it is relative to a base the browser resolves at load time. Left alone, that
// base is web.archive.org, so every picture written `images/crest.gif`, every
// font a stylesheet names, every background in an inline style, went to the
// Archive for the whole film, two to twelve seconds each, on the render path,
// and for fonts refused outright, because a cross-origin webfont needs a CORS
// header the Archive does not send.
//
// Pointing the base at this app's own path-shaped asset route fixes all of them
// at once, with no parsing of attributes and no list of the ways a page can name
// a file. The tail is kept byte for byte, trailing slash or none, subdirectory
// or none, because a relative URL's meaning is exactly that shape and nothing
// else; only the part in front of it is replaced.
//
// The timestamp is pinned with the same policy the assets themselves use: one
// version per original for the length of a run, so the same picture is one
// address in frame 3 and frame 700 rather than seven hundred addresses for one
// file.
function tlProxyBase(href) {
  const m = TL_BASE_URL_RE.exec(href);
  if (!m) return href;
  const ts = m[1], mod = m[2], rest = m[3];
  const key = 'base:' + mod + '/' + rest;
  let canon = tlCanonTs.get(key);
  if (!canon) { canon = ts; tlCanonTs.set(key, canon); }
  // The revision rides in the path, not in a query string, because a path is all
  // a base can contribute to a relative reference: `new URL('images/a.gif',
  // base)` drops the base's query entirely. Everything after the version segment
  // is the shape the document expects, so a relative URL still resolves exactly
  // where it did, and a fixed asset behind an immutable cache entry gets asked
  // for again, which is the whole point of putting it there.
  return `${location.origin}/api/asset-dir/v${TL_ASSET_VERSION}/${canon}${mod}/${rest}`;
}

function tlCanonicalize(html) {
  // Either shape means there is work to do, and the base alone guarantees it:
  // the server writes every capture's base as the Archive's own, host and all.
  if (!/\/web\/\d{14}/.test(html)) return html;
  let base = null;
  const guarded = html.replace(
    /(<base\b[^>]*\bhref\s*=\s*["'])([^"']+)(["'])/i,
    (m, open, href, close) => { base = href; return open + '__tl_base__' + close; },
  );
  const out = guarded.replace(TL_ASSET_RE, (all, ts, mod, rest) => {
    const key = mod + rest;
    let canon = tlCanonTs.get(key);
    if (!canon) { canon = ts; tlCanonTs.set(key, canon); }
    return tlAssetUrl(mod, canon, rest);
  });
  return base === null ? out : out.replace('__tl_base__', tlProxyBase(base));
}

// What one captured page asks for, read straight out of its markup: its
// stylesheets and its pictures. A regex rather than a parser on purpose: this
// walks dozens of documents in a row on the main thread while the film is
// playable, and it only has to find URLs. A URL it misses costs one slower frame
// later; a parser here would cost the film its smoothness now.
//
// The stylesheets are the better half of this. A site serves the same two or
// three of them to every capture it ever made, so warming them once makes every
// later frame in the record cheaper to finish, and a frame can render in
// milliseconds only if nothing it asks for has to cross the network.
const TL_IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const TL_IMG_SET_RE = /<img\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["']/gi;
const TL_LINK_RE = /<link\b[^>]*>/gi;
const TL_HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const TL_REL_RE = /\brel\s*=\s*["']?([^"'>\s]+)/i;
const TL_SCRIPT_RE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const TL_OTHER_RE = /<(?:embed|iframe|frame|source|input)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const TL_OBJECT_RE = /<object\b[^>]*?\bdata\s*=\s*["']([^"']+)["']/gi;
const TL_BODY_BG_RE = /<body\b[^>]*?\bbackground\s*=\s*["']([^"']+)["']/gi;

// A name written in a page, turned into the address that page will actually
// request. This matters for exactly one kind of name, the relative one, which
// resolves against the document's base; since the base is this app's own asset
// route by the time this runs, the answer is the address the frame will ask for
// and the address the warm pass must ask for first. They have to agree, or the
// warming is spent on files nobody requests.
function tlResolve(url, base) {
  if (!base) return url;
  try { return new URL(url, base).toString(); } catch (_) { return url; }
}

function tlPushAsset(list, url, base) {
  if (!url || list.length >= TL_WARM_PER_FRAME) return;
  if (/^(data|blob|about):/i.test(url)) return;
  list.push(tlResolve(url, base));
}

function tlDocBase(doc) {
  const m = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(doc);
  return m ? m[1] : null;
}

function tlWarmTargets(doc) {
  const sheets = [];
  const images = [];
  const others = [];
  const base = tlDocBase(doc);
  let m;

  TL_IMG_SRC_RE.lastIndex = 0;
  while ((m = TL_IMG_SRC_RE.exec(doc))) tlPushAsset(images, m[1], base);
  TL_IMG_SET_RE.lastIndex = 0;
  while ((m = TL_IMG_SET_RE.exec(doc))) {
    // One candidate per set: the first, which is what a browser with no viewport
    // information would take as well.
    tlPushAsset(images, m[1].split(',')[0].trim().split(/\s+/)[0], base);
  }

  TL_LINK_RE.lastIndex = 0;
  while ((m = TL_LINK_RE.exec(doc))) {
    const tag = m[0];
    const href = TL_HREF_RE.exec(tag);
    if (!href) continue;
    const rel = (TL_REL_RE.exec(tag) || [])[1] || '';
    if (!/stylesheet/i.test(rel) && !/\.css(\?|$)/i.test(href[1])) continue;
    tlPushAsset(sheets, href[1], base);
  }

  for (const re of [TL_SCRIPT_RE, TL_OTHER_RE, TL_OBJECT_RE, TL_BODY_BG_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(doc))) tlPushAsset(others, m[1], base);
  }

  return { sheets, images, others };
}

// Fetch one photograph and let go of it. What is wanted is the entry in the
// browser's own cache, not the object, so nothing here is kept: the decode is
// asked for because a resident decoded image survives in the cache longer than
// raw bytes do.
// Resolves TRUE when the request was answered, loaded, or refused by the
// Archive (a picture that is genuinely not in the record), and FALSE when it
// simply did not come back in time. That distinction is the whole honesty of the
// pre-roll: an answer is a fact about the frame, a timeout is not, and a frame
// that timed out must not be counted as warm or the film will meet it later on
// the glass, half arrived.
function tlWarmImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (answered) => {
      if (done) return;
      done = true;
      img.onload = null;
      img.onerror = null;
      resolve(answered);
    };
    img.onerror = () => finish(true);    // an answer, even a refusal
    img.onload = () => {
      if (img.decode) img.decode().catch(() => {}).then(() => finish(true));
      else finish(true);
    };
    img.decoding = 'async';
    img.src = url;
    setTimeout(() => finish(false), TL_WARM_TIMEOUT_MS);
  });
}

// A stylesheet, warmed by asking for its bytes, and this one is read, not just
// fetched. A sheet names more assets than the markup does: every background,
// every bullet, every sprite it points at, and the browser asks for those from
// the sheet rather than from the page. A warm pass that only reads markup leaves
// them cold, and one cold background holds a frame at the ceiling exactly as
// surely as one cold photograph. The text comes back because these URLs are this
// app's own route, not the Archive's: same origin, so the body is readable.
function tlWarmSheet(url) {
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TL_WARM_TIMEOUT_MS);
  return fetch(url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
    .then((res) => (res ? res.text() : null))
    .catch(() => null)          // aborted or refused: not an answer, ask again later
    .then((text) => { clearTimeout(timer); return text; });
}

// Everything else a page loads and the loader does not model: scripts, embeds,
// objects, an old-fashioned body background. These cannot be judged by an
// <img>, but they DO hold the frame's load event, so they are warmed too.
function tlWarmOther(url) {
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TL_WARM_TIMEOUT_MS);
  return fetch(url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
    .then((res) => {
      if (!res) return false;
      if (res.arrayBuffer) return res.arrayBuffer().then(() => true, () => false);
      return true;
    })
    .catch(() => false)
    .then((ok) => { clearTimeout(timer); return ok; });
}

// The assets a stylesheet names. The sheet was served by this app, so the URLs
// inside it are already this app's own (the server rewrites them as it caches),
// and a root-relative one is made absolute so the browser reads it from the same
// cache entry the frame will.
const TL_CSS_ASSET_RE = /(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"])/gi;

function tlCssAssets(text) {
  const out = [];
  TL_CSS_ASSET_RE.lastIndex = 0;
  let m;
  while ((m = TL_CSS_ASSET_RE.exec(text))) {
    const raw = (m[1] || m[2] || '').trim();
    if (!raw || /^(data|blob|about):/i.test(raw)) continue;
    if (raw.startsWith('/api/asset')) out.push(location.origin + raw);
    else if (raw.startsWith(location.origin)) out.push(raw);
  }
  return out;
}

// The first frame that is not the playhead itself. Warming walks the frames the
// pool is loading as well as the ones past it, because they are the same URLs
// this pass asks for, one canonical URL per original, which the browser
// coalesces, and because "how far ahead the record is warm" has to mean every
// frame ahead of the playhead, not just the ones outside the pool. It moves with
// the playhead, which is the whole point, and it never looks behind it: there is
// nothing left to warm in a capture that has already been shown.
function tlWarmFrom() {
  return TL.index + 1;
}

// Ask the rack for one frame, now. The queue is in distance order, so a frame
// the film is actually waiting on goes in at the front of its own distance
// rather than at the back: a seek into unwarmed country is then paid for once,
// by the frame that needs it, instead of by every frame that follows it.
function tlWarmWant(i, now) {
  tlWarmNeeded.add(i);
  if (tlWarmDone.has(i) || tlWarmQueue.includes(i)) return;
  if (now) { tlWarmQueue.unshift(i); return; }
  let k = 0;
  while (k < tlWarmQueue.length && tlWarmQueue[k] < i) k++;
  tlWarmQueue.splice(k, 0, i);
}

// Wait for one frame's assets, asking for them if nobody has. This is the one
// place a capture may be waited on, and it waits on the rack where it is a
// single wait for a whole frame's pictures, rather than inside a render where it
// is a page arriving a piece at a time.
function tlAwaitWarm(i) {
  const run = TL.gen;
  const until = performance.now() + TL_PAINT_MAX_MS;
  const done = () => { tlWarmNeeded.delete(i); };
  return new Promise((resolve) => {
    const look = () => {
      if (TL.gen !== run || tlWarmDone.has(i)) { done(); resolve(); return; }
      // The wait has a ceiling, and it is the loader's own. Without it, one
      // picture the Archive accepts and never sends would hold this frame ,
      // and with it the film, forever, which is worse than any stutter. Past
      // the ceiling the frame is rendered anyway and held to the completeness
      // contract like every other: if it cannot finish it is shown degraded and
      // named on screen. Nothing waits forever; some things wait visibly.
      if (performance.now() >= until) { done(); resolve(); return; }
      // At the front, and named as needed: this is a frame the film is waiting
      // on right now, so neither the pass's distance ordering nor its habit of
      // dropping frames the playhead has passed may take it away.
      tlWarmWant(i, true);
      setTimeout(look, 50);
    };
    look();
  });
}

// The pre-roll is a promise, not a life sentence. A single asset the Archive
// accepts and then never answers would otherwise hold Play forever, and a film
// that never starts is worse than a film that occasionally waits. If coverage
// stops advancing for this long the transport opens anyway: everything that did
// arrive is cached, and the one stubborn picture is met the way every frame used
// to be, by holding the picture that is on screen until it is complete.
const TL_PREROLL_PATIENCE_MS = 30000;
let tlCoveredBest = -1;
let tlCoveredAt = 0;

// How far ahead of the playhead the record is warm: the frames, counted from the
// next one out, whose assets have all been asked for and answered. This is what
// the transport waits on, and what a lane grows by one frame at a time.
function tlWarmCovered() {
  let n = 0;
  for (let i = TL.index + 1; i < tlTotal(); i++) {
    if (!tlWarmDone.has(i)) break;
    n++;
  }
  if (n > tlCoveredBest) { tlCoveredBest = n; tlCoveredAt = performance.now(); }
  return n;
}

// Move the horizon forward. Frames the film has already reached are dropped
// instead of enqueued, the pool is loading those itself, and asking for their
// pictures a second time would spend the Archive's patience on a duplicate.
// Nothing is read here, so it is cheap enough to run before every step of every
// lane: that is what keeps the queue pointed at the playhead while the film is
// moving instead of at wherever it was when the pass began.
async function tlWarmRefill() {
  const total = tlTotal();
  const from = tlWarmFrom();
  if (tlWarmFrame < from) tlWarmFrame = from;
  for (let k = tlWarmQueue.length - 1; k >= 0; k--) {
    if (tlWarmQueue[k] < from && !tlWarmNeeded.has(tlWarmQueue[k])) tlWarmQueue.splice(k, 1);
  }
  const to = Math.min(total, from + TL_WARM_AHEAD);
  while (tlWarmFrame < to) tlWarmQueue.push(tlWarmFrame++);
}

// Warm one whole capture: its document read out of the store, then every asset
// it names asked for at once, the way its own document would ask for them.
//
// This is the part that had to change. The assets of one page are independent
// requests, and a rack that fetched them one per lane warmed about one capture a
// second, far behind a film that shows sixteen. In flight together, a frame's
// assets are warmed in the time one picture takes, and the responses stay as
// cache entries this tab reads for free when the frame reaches the pool.
async function tlWarmOne(i, run) {
  const frame = TL.frames[i];
  if (!frame || frame.failed || !frame.timestamp) { tlWarmDone.add(i); return; }
  const doc = await arDoc(state.url, frame.timestamp);
  if (TL.gen !== run) return;
  // The playhead has passed it, unless the film is waiting on it, which is what
  // a step backwards through the record looks like.
  if (i < TL.index && !tlWarmNeeded.has(i)) return;
  if (typeof doc !== 'string' || !doc) { tlWarmDone.add(i); return; }

  const { sheets, images, others } = tlWarmTargets(tlCanonicalize(doc));
  const urls = [];
  const want = (url, kind) => {
    const key = kind + url;
    if (tlWarmed.has(key)) return false;
    tlWarmed.add(key);
    urls.push({ url, kind });
    return true;
  };
  for (const url of sheets) want(url, 's');
  for (const url of images) want(url, 'i');
  for (const url of others) want(url, 'o');
  if (!urls.length) { tlWarmDone.add(i); return; }

  let cursor = 0;
  let answered = true;
  const lane = async () => {
    while (cursor < urls.length) {
      const item = urls[cursor++];
      if (TL.gen !== run) return;
      let ok = true;
      if (item.kind === 's') {
        // The sheet's own assets join the end of this frame's list, so the lanes
        // that are already running pick them up instead of a second pass.
        const css = await tlWarmSheet(item.url);
        ok = css !== null;
        if (css) for (const u of tlCssAssets(css)) want(u, 'i');
      } else if (item.kind === 'o') {
        ok = await tlWarmOther(item.url);
      } else {
        ok = await tlWarmImage(item.url);
      }
      // An asset that did not answer is forgotten so a later pass asks again ,
      // the server answers it out of its own cache the second time.
      if (!ok) { tlWarmed.delete(item.kind + item.url); answered = false; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TL_WARM_FRAME_LANES, urls.length) }, lane));
  // Only a frame every one of whose assets ANSWERED is warm. One that timed out
  // is left to be asked for again, which is what keeps the pre-roll honest.
  if (TL.gen === run && answered) tlWarmDone.add(i);
}

// Warming needs a heartbeat of its own. It is driven by presentations, which is
// perfect while the film runs and useless while the pool is still filling, and
// that is exactly when the pre-warm matters most, because a cold capture takes
// half a minute to assemble and nothing is presenting while it does. The tick
// keeps the lanes at the width the moment wants and the queue pointed at the
// playhead, and it is the only thing standing between a deep pre-warm and a
// single lane grinding through the record on its own.
let tlWarmTick = null;

function tlWarmTicker() {
  if (tlWarmTick) return;
  tlWarmTick = setInterval(() => {
    if (el('timelapseModal').hidden || TL.phase !== 'ready') return;
    tlPrefetch();
    tlWarmAhead();
  }, 300);
}

// A pass over the frames past the pool: lanes warming whole captures, nearest
// first. Cheap to call anywhere, it starts only the lanes that are missing, and
// a frame that is not on file is skipped rather than waited for.
//
// A lane re-reads the wanted width as it goes, so a film that starts running
// while three lanes are warm fans out to six without ever restarting the pass,
// and a film that stops lets the extra lanes fall away on their next step.
async function tlWarmAhead() {
  if (TL.phase !== 'ready' || !TL.forUrl) return;
  if (tlWarmFrom() >= tlTotal()) return;
  // Warming starts the moment the record is ready rather than the moment Play is
  // pressed, because that is the only thing that can make a cold slice play
  // smoothly: an asset warmed now is a page that opens in milliseconds later.

  const want = TL.playing ? TL_WARM_LANES_PLAYING : TL_WARM_LANES;
  if (tlWarmActive >= want) return;   // the queue is already being drained
  const run = TL.gen;

  tlWarmActive++;
  try {
    while (TL.gen === run && tlWarmActive <= (TL.playing ? TL_WARM_LANES_PLAYING : TL_WARM_LANES)) {
      await tlWarmRefill();   // the horizon moves with the playhead
      if (!tlWarmQueue.length) return;   // nothing left within the horizon
      const i = tlWarmQueue.shift();
      if (i === undefined) return;
      if (i < tlWarmFrom()) continue;   // the pool owns it now
      await tlWarmOne(i, run);
    }
  } finally {
    tlWarmActive--;
  }
}

// ---------------------------------------------------------------- stage
// The stage is a pool of iframes rather than a pair. Each one holds one
// capture, fully rendered and left that way, and the film shows whichever one
// holds the frame it is on. That is where its smoothness comes from: by the
// time the film reaches a capture, the capture has been sitting there finished
// for as long as it took the frames before it to play. Two iframes can only
// ever hold "now" and "next", and a whole archived page takes longer to arrive
// than a 16x frame lasts, so "next" was still on its way every single time it
// was needed.
//
// Depth is the one resource here that is not free: a slot is a live document
// with its images decoded. Twelve is the deepest pool that stays comfortably
// inside a tab's budget while still being enough to cover the frames that 16x
// consumes before the network can answer.
const TL_SLOTS = 12;

// How many frames ahead of the playhead must be complete before Play unlocks,
// at the pace the film is set to. This is the promise the film makes: pressing
// play starts a film, not a loading screen, and it is the reason a slow start is
// taken rather than a single stutter later. At 1x a runway of four is a couple
// of seconds; at 16x the film eats sixteen frames a second, so it waits for the
// pool to be full before it begins.
function tlRunwayNeed() {
  const want = Math.ceil(TL.speed * 1.25) + 2;
  return Math.max(3, Math.min(TL_SLOTS - 2, want));
}

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

// The dissolve, sized to the beat. A cross-fade is a luxury at 1x and a lie at
// 16x, where a 420ms fade leaves two captures blended for most of the run: the
// frame you are looking at is half of the one before it, which looks exactly
// like a page that never finished loading. The fade never takes more than half a
// beat, and the value is written only when it changes.
let tlFadeMs = 0;
function tlFadeFor() {
  const period = TL_FRAME_MS / TL.speed;
  const ms = Math.max(TL_FADE_MIN_MS, Math.min(TL_FADE_MAX_MS, Math.round(period * 0.45)));
  if (ms === tlFadeMs) return ms;
  tlFadeMs = ms;
  el('tlViewport').style.setProperty('--tl-fade', `${ms}ms`);
  return ms;
}

function tlSlotHolding(i) {
  return tlSlots.find((s) => s.index === i && s.state === 'ready') || null;
}

// A slot the film is counting on right now: the capture on the screen, the
// capture the next beat will need, and the capture a seek is heading for. These
// are never taken for a speculative load. Taking one is what turns a frame that
// was guaranteed into a frame that has to be fetched a second time, and that is
// how a pool this deep still manages to starve at speed.
function tlProtectedSlot(s) {
  if (s === tlFrontSlot) return true;
  if (s.index === TL.index + 1) return true;
  if (s.index === TL.target && s.state === 'loading') return true;
  return false;
}

// Which slot takes the next capture? An empty one, otherwise the one holding the
// least useful frame, and never one the film is about to need. Null means the
// pool is full of frames the film wants, which is a queue rather than a
// failure: the caller waits for a slot instead of stealing one.
function tlSlotFor(i) {
  const pool = tlSlots.filter((s) => !tlProtectedSlot(s) || s.index === i);
  if (!pool.length) return null;
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
// screen, a change the site's owner never made. The compare view keeps its
// scrollbars, because there you are reading the page.
const TL_FRAME_STYLE =
  '<style>html{scrollbar-width:none !important;}' +
  'html::-webkit-scrollbar,body::-webkit-scrollbar{width:0 !important;height:0 !important;}</style>';

// The document transform, and the only one the film applies. injectScrollFix is
// the compare view's, verbatim, so a frame is the same document the compare
// pane writes; the extra rule only hides scrollbars, which flicker from frame
// to frame and are not a change the site's owner ever made.
function tlPrepareFrame(html) {
  let doc = injectScrollFix(tlCanonicalize(html));
  if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head[^>]*>/i, (m) => m + TL_FRAME_STYLE);
  } else {
    doc = TL_FRAME_STYLE + doc;
  }
  return doc;
}

function tlWriteFrame(iframe, doc) {
  // Reassigning an identical srcdoc does not reload the document, so the load
  // event the cross-fade waits on would never fire, and two consecutive
  // captures that render identically is not a rare edge case on a long film.
  if (iframe.srcdoc === doc) return false;
  iframe.srcdoc = doc;
  return true;
}

// Which stylesheets of this frame never applied? A sheet whose request is
// cancelled in flight counts as absent and the browser never asks for it again,
// so a frame can sit there permanently unstyled.
//
// This asks each link about itself rather than counting sheets, and that
// distinction is the whole point. Counted, the inline <style> blocks half these
// pages carry stand in for a link that failed, so a frame reads as styled while
// a stylesheet of it never arrived. Per link, the answer is a fact about the
// element that asked: a sheet that applied is there, a sheet that did not is
// not, and the ones that need asking again are named exactly.
//
// Images are deliberately not part of this. An archived page is full of
// pictures the Archive never captured, and those are permanently gone rather
// than in flight: re-asking for them cannot bring one back, so judging a frame
// by them only produces work and repaints a page whose pictures will not
// change. A picture still genuinely arriving is the loader's business, and it
// is handled there, before anything is shown.
function tlUnstyled(iframe) {
  const d = iframe.contentDocument;
  if (!d || !d.body) return null;   // nothing to judge yet
  return Array.from(d.querySelectorAll('link[rel~="stylesheet"]')).filter((l) => !l.sheet);
}

function tlSwap(incoming) {
  for (const s of tlSlots) s.el.classList.toggle('is-front', s === incoming);
  tlFrontSlot = incoming;
}

// ---------------------------------------------------------------- scrolling
// The stage is a window onto a page that is nearly always taller than it, and
// there was no way to see the rest of one. The frames are inert on purpose ,
// pointer-events: none, so a click can never navigate the film away from the
// record, which also means a wheel over them is never theirs. So the wheel is
// read here, at the viewport, and applied to every frame at once.
//
// Every frame, not just the one on screen, and that is the whole idea. A capture
// is one moment of a site, and what changed between two of them is usually not
// in the first screenful: a footer, a fee table, a disclaimer, a phone number.
// One scroll position for the whole record means the film can be watched at that
// part of the page, park on the fees, press play, and every capture in the
// record arrives already scrolled to its fees, changing under your hands. The
// alternative, a reset to the top on every beat, makes the wheel useless at
// exactly the speeds it is most wanted at.
//
// The position is a wish rather than a coordinate. Each capture keeps as much of
// it as its own height allows: five thousand pixels down a page that is five
// hundred tall is five hundred, and the next capture, which may be tall again,
// is five thousand again. That is what makes this feel like one document being
// scrolled rather than a slot machine of documents.
TL.scrollY = 0;
let tlScrollUsed = false;
let tlScrollDrag = null;
let tlScrollHintTimer = 0;

// Where a capture actually scrolls. It is usually the root element, and it is
// not always, which is the trap this function exists for: a page whose own CSS
// gives the body a height, and these are archived pages, so some of them are
// twenty-year-old full-height layouts, turns the body into a scroll container of
// its own, and the window then has nothing to move. Asked of the elements rather
// than assumed, because the answer is different on the next capture.
//
// (This app's own stylesheet makes it likelier: `overflow-x: hidden` on both html
// and body is in every frame, the compare view's rule, which the film reuses ,
// and an overflow pair with one axis hidden computes the other to `auto`, which
// hands a full-height body its own scrollbar.)
function tlScrollers(iframe) {
  try {
    const d = iframe.contentDocument;
    if (!d || !d.documentElement) return [];
    return [d.documentElement, d.body]
      .filter((n) => n && n.scrollHeight - n.clientHeight > 1);
  } catch (_) {
    return [];
  }
}

// How far this frame can be scrolled, asked of the document itself rather than
// remembered: an archived page grows as its pictures arrive, and a height taken
// once would clamp the wheel to the layout of a moment ago.
function tlMaxScroll(iframe) {
  let max = 0;
  for (const node of tlScrollers(iframe)) max = Math.max(max, node.scrollHeight - node.clientHeight);
  return max;
}

// Put this frame at that position, on whichever element scrolls. Written to every
// scroller it has rather than to the one that answered, because a page can have
// both and only one of them will move.
function tlSetScroll(iframe, y) {
  for (const node of tlScrollers(iframe)) {
    const at = Math.max(0, Math.min(y, node.scrollHeight - node.clientHeight));
    if (Math.abs(node.scrollTop - at) > 0.5) node.scrollTop = at;
  }
}

// One scroll position, written to every capture on the stage: the one on screen,
// the one dissolving in, and the frames the pool is holding for the next beats.
// Writing it to a frame that has just loaded is what stops the dissolve showing
// the top of a page for a moment before the wheel's position arrives, the two
// documents are blended for a fifth of a second, and a jump between them is the
// most visible thing on screen when it happens.
function tlApplyScroll() {
  for (const s of tlSlots) {
    if (s.state === 'empty' || s.index < 0) continue;
    tlSetScroll(s.el, TL.scrollY);
  }
  tlPaintScrollTrack();
}

function tlMarkScrolled() {
  tlScrollUsed = true;
  clearTimeout(tlScrollHintTimer);
  el('tlScrollHint').hidden = true;
}

function tlScrollBy(dy) {
  const front = tlFrontSlot;
  if (!front || !dy) return;
  const max = tlMaxScroll(front.el);
  if (max <= 0) { TL.scrollY = 0; tlPaintScrollTrack(); return; }
  // Anchored to what is on screen, not to the wish. On a short capture the wish
  // was clamped, and a wheel that started from the wish would feel stuck for the
  // first notch or two of the next tall one.
  const at = Math.min(TL.scrollY, max);
  const next = Math.max(0, Math.min(max, at + dy));
  if (next === at) return;
  TL.scrollY = next;
  tlMarkScrolled();
  tlApplyScroll();
}

// The track: as tall as the visible share of the page, as far down as the wheel
// has gone. Painted from the frame on screen, because that is the page the
// person is looking at.
function tlPaintScrollTrack() {
  const track = el('tlScroll');
  const thumb = el('tlScrollThumb');
  if (!track || !thumb) return;
  const front = tlFrontSlot;
  const max = front ? tlMaxScroll(front.el) : 0;
  const view = front ? front.el.clientHeight : 0;
  // Nothing to say on a capture that fits the window: no track, no thumb, and
  // the wheel stays a wheel that goes to the page behind the film.
  if (!front || max <= 0 || view <= 0 || TL.export.state === 'recording') {
    track.hidden = true;
    return;
  }
  track.hidden = false;
  const trackH = track.clientHeight || view;
  const h = Math.max(36, Math.round((view / (view + max)) * trackH));
  const at = Math.min(TL.scrollY, max);
  const y = Math.round((at / max) * (trackH - h));
  thumb.style.height = `${h}px`;
  thumb.style.transform = `translateY(${y}px)`;
}

// Said once, on the first capture that is taller than the window. The track is a
// scrollbar and a scrollbar is understood, but a scrollbar inside a picture of a
// browser is not a thing anyone expects to be able to move, and a line of text
// is cheaper than a feature nobody finds.
function tlMaybeShowScrollHint() {
  const hint = el('tlScrollHint');
  if (!hint || tlScrollUsed || TL.export.state === 'recording') return;
  if (!el('tlBuffer').hidden) return;
  if (!tlFrontSlot || tlMaxScroll(tlFrontSlot.el) <= 0) return;
  hint.hidden = false;
  clearTimeout(tlScrollHintTimer);
  tlScrollHintTimer = setTimeout(() => { hint.hidden = true; }, 6000);
}

// The wheel, at the viewport rather than on the frames, because the frames never
// see it. deltaMode is honoured: a wheel that reports lines rather than pixels is
// ordinary on Windows and on many mice, and treating three lines as three pixels
// is a scroll that appears not to work.
el('tlViewport').addEventListener('wheel', (e) => {
  if (TL.phase !== 'ready' || !tlFrontSlot || TL.export.state === 'recording') return;
  if (tlMaxScroll(tlFrontSlot.el) <= 0) return;
  e.preventDefault();
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tlFrontSlot.el.clientHeight : 1;
  tlScrollBy(e.deltaY * px);
}, { passive: false });

// Dragging the thumb: a track that answers the wheel but not the hand is half a
// scrollbar, and the half it is missing is the one that is precise.
function tlScrollFromThumb(clientY) {
  const track = el('tlScroll');
  const thumb = el('tlScrollThumb');
  const front = tlFrontSlot;
  if (!track || !thumb || !front) return;
  const max = tlMaxScroll(front.el);
  const trackH = track.clientHeight || 1;
  const thumbH = thumb.offsetHeight || 36;
  const room = Math.max(1, trackH - thumbH);
  const grab = tlScrollDrag ? tlScrollDrag.grab : thumbH / 2;
  const y = Math.max(0, Math.min(room, clientY - track.getBoundingClientRect().top - grab));
  TL.scrollY = Math.round((y / room) * max);
  tlMarkScrolled();
  tlApplyScroll();
}

el('tlScroll').addEventListener('pointerdown', (e) => {
  if (TL.phase !== 'ready' || !tlFrontSlot) return;
  const thumb = el('tlScrollThumb');
  const onThumb = e.target === thumb;
  tlScrollDrag = { grab: onThumb ? e.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2 };
  el('tlScroll').classList.add('is-dragging');
  try { el('tlScroll').setPointerCapture(e.pointerId); } catch (_) {}
  tlScrollFromThumb(e.clientY);
  e.preventDefault();
});
el('tlScroll').addEventListener('pointermove', (e) => { if (tlScrollDrag) tlScrollFromThumb(e.clientY); });
function tlScrollDragEnd(e) {
  if (!tlScrollDrag) return;
  tlScrollDrag = null;
  el('tlScroll').classList.remove('is-dragging');
  try { el('tlScroll').releasePointerCapture(e.pointerId); } catch (_) {}
}
el('tlScroll').addEventListener('pointerup', tlScrollDragEnd);
el('tlScroll').addEventListener('pointercancel', tlScrollDragEnd);
window.addEventListener('resize', () => { tlApplyScroll(); });

// Put a capture on screen and make everything that describes it agree with it
// in the same breath: the date, the counts, the rail head, the counter. Writing
// the caption first and the picture later is what makes a film look like it is
// running ahead of itself, and at 16x that gap is most of what you see.
function tlPresent(i, slot) {
  const frame = TL.frames[i];
  if (!frame || !slot) return false;
  tlSwap(slot);
  TL.index = i;
  TL.target = i;
  TL.waiting = null;
  tlShowBuffer(false);
  // The wheel's position first, then the caption: a frame that arrives scrolled
  // is the film holding its place, and a frame that arrives at the top and
  // scrolls a moment later is a page jumping under the reader.
  tlApplyScroll();
  tlMaybeShowScrollHint();
  tlPaintDate(frame, i);
  tlPaintRailHead();
  // The frames past the pool are warmed from here, so the warm-up follows the
  // playhead instead of running once at the beginning and stopping.
  tlWarmAhead();
  return true;
}

// Load one capture into a slot and say how it went:
//   'ready'  , the slot holds it, rendered
//   'missing', the capture could not be produced at all
//   'stolen' , the slot was given another frame while this one loaded
// Everything the film does goes through here, the frame on screen, the
// runway, the frames warmed for later, so there is one loader and one notion
// of what "loaded" means.
function tlStartLoad(slot, i) {
  // One capture, one slot. This is the choke point every loader goes through,
  // so it is where the rule is enforced rather than at each of them: if the
  // capture is already rendered, or already being rendered, somewhere else,
  // this returns that load instead of beginning a second one.
  //
  // The guard is here because the pool and the film ask asynchronously, and a
  // slot that frees up looks like an invitation. Measured before it existed: a
  // warming film started twelve frames' worth of the same handful of captures
  // over and over, one capture loaded eleven times into eleven slots, all of
  // them competing for the same parse, layout and pictures, and the film
  // crawling at two frames a second with every slot busy doing the same work.
  const held = tlSlots.find((s) => s !== slot && s.index === i && (s.state === 'loading' || s.state === 'ready'));
  if (held) return held.state === 'loading' ? held.done : Promise.resolve('ready');

  clearTimeout(slot.timer);
  clearTimeout(slot.heal);
  slot.timer = null;
  slot.heal = null;
  if (slot.detachLoad) { slot.detachLoad(); slot.detachLoad = null; }
  slot.index = i;
  slot.state = 'loading';
  slot.done = tlLoadInto(slot, i);
  return slot.done;
}

// One capture, one load, however many callers ask for it.
//
// Several parts of the film want the same capture in the same tick, the beat
// that is about to show it, the pool filling the runway behind that beat, a
// seek that landed on it, and each of those is an independent ask. Without a
// claim, every ask found the frame unclaimed, took a slot of its own and wrote
// the same document again. Measured on a 53KB archived page: twelve of them
// started in the same millisecond, and all twelve finished after five and a
// half seconds where one finishes in under half of one. Twelve copies of a page
// in one renderer is not twelve times the throughput; they compete for the same
// parse, the same layout and the same pictures, and the film crawls at two
// frames a second with every slot busy doing the same work twice.
//
// The claim is a promise rather than a flag so a second caller waits on the
// first load instead of starting another, and it is made before anything is
// awaited, that ordering is the whole mechanism, because a check that happens
// after an await has already happened after the race it exists to prevent.
const tlLoads = new Map();   // frame index -> the load in flight for it

// Ask for a capture. Always resolves, and always says what happened:
//   { outcome: 'ready',   slot }  the capture is complete in that slot
//   { outcome: 'missing', slot }  there is no document for it on file
//   { outcome: 'stolen',  slot }  the slot was given another capture mid-load
function tlEnsureLoaded(i) {
  const claimed = tlLoads.get(i);
  if (claimed) return claimed;

  const settle = (promise, fallback) => promise.then((outcome) => ({
    outcome,
    slot: outcome === 'ready' ? (tlSlotHolding(i) || fallback) : fallback,
  }));

  const load = (async () => {
    const ready = tlSlotHolding(i);
    if (ready) return { outcome: 'ready', slot: ready };

    // A capture whose pictures are not warm yet is not a capture this film can
    // open quickly, and rendering the document first while its assets are still
    // coming is what put half-arrived pages on the glass. So the wait happens
    // here, before a slot is claimed, and the document is only written once the
    // frame can actually arrive.
    if (!tlWarmDone.has(i)) {
      await tlAwaitWarm(i);
      const warmed = tlSlotHolding(i);
      if (warmed) return { outcome: 'ready', slot: warmed };
    }

    const loading = tlSlots.find((s) => s.index === i && s.state === 'loading');
    if (loading) return settle(loading.done, loading);

    const slot = tlSlotFor(i);
    if (slot) return settle(tlStartLoad(slot, i), slot);

    // Every slot holds something the film still wants. Wait for one to come free
    // rather than taking it: the capture is next, and the film would rather arrive
    // late and complete than on time and unfinished.
    return tlSlotFreed(i);
  })();

  tlLoads.set(i, load);
  load.then(() => {}, () => {}).then(() => {
    if (tlLoads.get(i) === load) tlLoads.delete(i);
  });
  return load;
}

function tlSlotFreed(i) {
  return new Promise((resolve) => {
    const look = () => {
      const slot = tlSlotFor(i);
      if (!slot) { setTimeout(look, 40); return; }
      resolve(slot);
    };
    setTimeout(look, 20);
  }).then((slot) =>
    tlStartLoad(slot, i).then((outcome) => ({
      outcome,
      slot: outcome === 'ready' ? (tlSlotHolding(i) || slot) : slot,
    })),
  );
}

// Two animation frames: the first lets whatever just changed lay out, the
// second proves the browser painted it. In a background tab nothing paints at
// all, and a film must not hang waiting for a paint that is never coming, so the
// second frame is given a deadline of its own.
function tlNextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 250);
  });
}

// The frame's own load event, as a promise. It fires once the document and
// everything it references have settled, errors included, which is exactly the
// floor this needs: after it, nothing is still arriving, so everything left to
// check is a fact about the document rather than an event that may never come.
//
// The listener is attached before the document is written, because setting
// srcdoc starts a navigation and a navigation that has already finished cannot
// be waited on afterwards: a missed load event would leave that frame sitting
// until the ceiling, every single time.
function tlFrameStarted(slot) {
  const frame = slot.el;
  const loaded = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      frame.removeEventListener('load', finish);
      resolve();
    };
    frame.addEventListener('load', finish);
    slot.detachLoad = () => { done = true; frame.removeEventListener('load', finish); };
  });
  return loaded;
}

// Wait until the capture is COMPLETE, not merely parsable: the document has
// loaded, every stylesheet has applied, no image is still arriving, every image
// that did arrive has been decoded into pixels, the fonts the page asked for
// have settled, and the browser has painted the result. That is the film's
// contract, and this function is where it is kept.
//
// A frame that cannot get there inside the ceiling comes back 'degraded' and is
// shown anyway: an imperfect frame the viewer can question beats a blank stage,
// and the heal pass gets one more try at it afterwards.
async function tlWaitPainted(slot, token, loaded) {
  const until = performance.now() + TL_PAINT_MAX_MS;
  const left = () => Math.max(0, until - performance.now());
  const stale = () => slot.token !== token;

  // 1. Everything the page references has finished arriving.
  await Promise.race([loaded, tlSleep(left())]);
  if (stale()) return 'stolen';

  // 2. Fonts. They are pulled in by the stylesheets rather than named in the
  // markup, so the load event does not always cover them, and a page that swaps
  // its font after the first paint is a page captured mid-swap.
  //
  // This reads the FRAME's font set, not this file's. That distinction is the
  // whole point: the film's own page finished loading its fonts long ago, so
  // asking it would answer instantly about the wrong document. An archived font
  // can also be blocked at its source forever, so this is a wait with a floor
  // under it, never a hang.
  const fonts = slot.el.contentDocument && slot.el.contentDocument.fonts;
  if (fonts && fonts.ready) {
    await Promise.race([
      fonts.ready.catch(() => {}),
      tlSleep(Math.min(1500, left())),
    ]);
    if (stale()) return 'stolen';
  }

  // 3. What is left is read off the frame: the stylesheets applied, every image
  // arrived, none still in flight, and the pixels decoded. Decoding is the
  // difference between receiving the bytes and being able to show them, and at
  // sixteen frames a second that difference is the flicker this exists to
  // remove.
  const kicked = new Set();
  let straggling = 0;

  while (performance.now() < until) {
    if (stale()) return 'stolen';
    const doc = slot.el.contentDocument;
    if (!doc || !doc.body) { await tlSleep(30); continue; }

    const missingSheets = tlUnstyled(slot.el);
    const styled = missingSheets !== null && missingSheets.length === 0;
    const imgs = Array.from(doc.images || []);
    const arriving = imgs.filter((im) => !im.complete);

    if (styled && arriving.length && !straggling) straggling = performance.now();
    if (styled && arriving.length && performance.now() - straggling > TL_STRAGGLER_MS) {
      for (const im of arriving) {
        if (kicked.has(im)) continue;
        kicked.add(im);
        const src = im.getAttribute('src');
        if (src) im.src = src;
      }
      straggling = performance.now();
    }

    if (styled && !arriving.length) {
      const drawn = imgs.filter((im) => im.naturalWidth > 0);
      await Promise.all(drawn.map((im) => im.decode().catch(() => {})));
      if (stale()) return 'stolen';
      await tlNextPaint();
      if (stale()) return 'stolen';
      await tlNextPaint();
      return stale() ? 'stolen' : 'painted';
    }
    await tlSleep(40);
  }

  return stale() ? 'stolen' : 'degraded';
}

// One quiet look, a moment after the frame is loaded, for the failure the
// browser never repairs by itself: a stylesheet whose request was cancelled in
// flight is never asked for again, and that frame stays unstyled forever. One
// retry per frame, and only for the links that actually failed.
//
// The retry is the sheet, never the page. Re-inserting a link asks for the one
// request that went missing; rewriting the document would navigate the frame
// again, which re-fetches every picture the capture references and repaints the
// stage from scratch, a visible change to the capture that the site's owner
// never made. A link the Archive simply does not have fails again in the same
// breath and changes nothing: a sheet that never applied has nothing on screen
// to redraw, so the repair can only ever make a frame more correct.
function tlHealLater(slot, token) {
  clearTimeout(slot.heal);
  slot.heal = setTimeout(() => {
    if (slot.token !== token || slot.state !== 'ready') return;
    const missing = tlUnstyled(slot.el);
    if (!missing || !missing.length) return;
    for (const link of missing) link.parentNode.replaceChild(link.cloneNode(false), link);
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

  // The listener goes on before the document does. See tlFrameStarted.
  const loaded = tlFrameStarted(slot);
  if (!tlWriteFrame(slot.el, prepared)) {
    // This slot already holds this exact document, so there is no navigation to
    // wait for and nothing to do: a seek back and forth over one capture.
    if (slot.detachLoad) { slot.detachLoad(); slot.detachLoad = null; }
    slot.state = 'ready';
    slot.degraded = false;
    return 'ready';
  }

  const outcome = await tlWaitPainted(slot, token, loaded);
  if (outcome === 'stolen') return 'stolen';

  slot.degraded = outcome === 'degraded';
  slot.state = 'ready';
  // A frame that has just finished loading is put where the wheel left it before
  // anything can see it: it is written for the pool, and a later beat may present
  // it a minute from now, but the dissolve starts the moment it is swapped in.
  tlApplyScroll();

  tlHealLater(slot, token);
  return 'ready';
}

// Warm the frames ahead of the playhead for as long as the pool has room. This
// is what turns "the next capture" into a promise instead of a hope, and it is
// the only reason a beat can be instant when it fires.
function tlPrefetch() {
  if (tlPrefetching || TL.phase !== 'ready') return;

  const from = Math.max(TL.index, TL.target);
  const queue = [];
  for (let k = 1; k <= TL_SLOTS - 1; k++) {
    const i = from + k;
    if (i >= tlTotal()) break;
    if (!tlSlots.some((s) => s.index === i)) queue.push(i);
  }
  if (!queue.length) { tlPreparePaint(); tlWarmAhead(); return; }

  tlPrefetching = true;

  // Slots are claimed synchronously, before any loading starts, so two lanes
  // can never be handed the same one. Then they load together: one frame at a
  // time cannot feed a film that shows sixteen frames a second.
  const jobs = [];
  const wide = tlWarmWide();
  const width = wide ? TL_PREFETCH_LANES : TL_WARM_RENDER_LANES;
  for (const i of queue) {
    if (jobs.length >= width) break;
    // Rendering waits for the rack. A slot is a promise that this capture opens
    // in milliseconds, and it can only make that promise once its pictures are
    // already in the cache; claiming it earlier only converts the wait into a
    // page that arrives unfinished.
    if (!tlWarmDone.has(i)) { tlWarmWant(i); continue; }
    // A capture the film is already waiting on is not started again here: the
    // beat asked for it first, and a second copy in another slot is not a
    // second chance, it is the same document twice.
    if (tlLoads.has(i)) continue;
    const slot = tlSlotFor(i);
    if (!slot) continue;   // every remaining slot is one the film needs
    slot.index = i;
    slot.state = 'loading';
    jobs.push(tlStartLoad(slot, i));
  }

  // Nothing could be started, which happens when the pool is entirely made of
  // frames the film is about to need. Re-entering would spin, so stop here and
  // let the next presentation free a slot.
  if (!jobs.length) { tlPrefetching = false; tlWarmAhead(); tlPreparePaint(); return; }

  Promise.all(jobs)
    .catch(() => {})
    .then(() => {
      tlPrefetching = false;
      tlPaintTransport();
      // Keep going until the pool is full, whether or not the film is running:
      // the runway the transport is waiting on is built by this loop, so it
      // cannot stop after one pass. A pool with nothing left to fetch ends on
      // the empty queue above instead.
      tlPrefetch();
    });
}

// The runway: the frames just ahead of the playhead, complete and rendered. How
// many are required is a function of the pace, because the pace is what decides
// how fast the film will spend them.
function tlRunwayReady() {
  const need = Math.min(tlRunwayNeed(), tlTotal() - 1 - TL.index);
  if (need <= 0) return true;
  for (let k = 1; k <= need; k++) if (!tlSlotHolding(TL.index + k)) return false;
  return true;
}

// The transport's state in one place. A dark Play button is only acceptable
// when it is dark for a stated reason: the record is not here yet, or the
// frames ahead of it are not loaded yet.
// The pre-roll: how much of the record must be warm before Play opens at all.
// The pool is under a second of screen time at 16x, ten frames is nothing to a
// film that shows sixteen a second, so the thing that decides whether a run
// keeps its pace is how far ahead the ASSETS are cached, not how many frames are
// rendered. A film released onto a cold record drains the pool and then waits,
// which is exactly the stutter this whole file exists to prevent.
//
// It does not need to be deep, and that is the point of warming in distance
// order: a site serves the same pictures to every capture it makes, so the first
// dozen frames pay for nearly all of the assets the whole record needs (2,251
// asset URLs in the slice measured here were 128 files), and once those are in,
// one lane outruns the film by a wide margin. Six frames of coverage for each
// frame a second of pace, a hundred-odd at 16x, twenty-four at 1x, is past
// the wave and into the cheap part, and it is the wait the viewer is asked to
// accept IN PLACE of a stutter, once, at the start.
const TL_PREROLL_MAX = 600;

function tlPrerollFrames() {
  return Math.min(
    tlTotal() - 1 - TL.index,
    TL_PREROLL_MAX,
    Math.max(24, Math.ceil(TL.speed * 6)),
  );
}

// Is the record warm enough that the render pool may open to its full width?
// Before that, renders and warming are competing for the same pipe, and warming
// is the one that has to win: it is what makes every later render cheap.
function tlWarmWide() {
  return tlWarmCovered() >= tlPrerollFrames();
}

function tlStageReady() {
  if (!tlRunwayReady()) return false;
  if (tlWarmWide()) return true;
  return performance.now() - tlCoveredAt > TL_PREROLL_PATIENCE_MS;
}

// Greying the play button is delayed past a blink: readiness jitters while
// the pool churns (slots fill, warm coverage crosses its line, a seek lands),
// and every jitter repainted the button red-grey-red. The button only goes
// dark when unready survives a third of a second; coming back to ready is
// instant.
let tlTransportGreyTimer = 0;
function tlPaintTransport() {
  const btn = el('tlPlay');
  const waiting = !TL.playing && TL.phase === 'ready' && !tlStageReady();
  btn.classList.toggle('is-playing', TL.playing);
  const shouldDisable = TL.phase !== 'ready' || waiting;
  if (shouldDisable && !btn.disabled) {
    clearTimeout(tlTransportGreyTimer);
    tlTransportGreyTimer = setTimeout(() => {
      const w = !TL.playing && TL.phase === 'ready' && !tlStageReady();
      btn.disabled = TL.phase !== 'ready' || w;
    }, 350);
  } else if (!shouldDisable) {
    clearTimeout(tlTransportGreyTimer);
    btn.disabled = false;
  }
  btn.title = TL.playing
    ? (TL.waiting === null ? 'Pause' : 'Holding the capture while the next one finishes loading')
    : (waiting ? 'Warming the record\u2026' : 'Play');
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

  const need = Math.max(1, Math.min(tlRunwayNeed(), total - 1 - TL.index));
  let have = 0;
  for (let k = 1; k <= need; k++) if (tlSlotHolding(TL.index + k)) have++;

  // The pre-roll first, then the frames: while the record behind the playhead is
  // still being warmed there is nothing useful to say about how many frames are
  // rendered, because the render is not what the film is waiting for.
  const warmNeed = tlPrerollFrames();
  const warmHave = Math.min(tlWarmCovered(), warmNeed);
  const warming = warmHave < warmNeed;

  const ready = TL.phase === 'ready' && have >= need && !warming;
  const filming = TL.export.state === 'recording' || TL.export.state === 'saved';
  row.hidden = ready || TL.playing || filming || TL.phase !== 'ready';
  // The one line that explains the wait: either the record is being warmed or the
  // frames are being rendered, and the film will not start on a page that is
  // still putting itself together.
  const shown = warming
    ? `Warming the record \u00b7 ${tlFmt(warmHave)} of ${tlFmt(warmNeed)} frames`
    : `Rendering the frames ahead \u00b7 ${tlFmt(have)} of ${tlFmt(need)}`;
  el('tlPrepareLabel').textContent = shown;
  el('tlPrepareFill').style.width =
    `${Math.round((warming ? warmHave / Math.max(1, warmNeed) : have / need) * 100)}%`;
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
  tlFadeFor();

  const token = ++TL.showToken;
  TL.target = i;

  const awaiting = tlEnsureLoaded(i);

  // With nothing on screen yet there is no previous capture to hold it, so the
  // status light explains the wait rather than a blank stage.
  if (!tlFrontSlot) tlShowBuffer(true, 'opening the capture\u2026');

  const { outcome, slot } = await awaiting;
  if (token !== TL.showToken) return;   // a newer frame took over
  if (outcome === 'stolen') return;     // the slot moved on; its new frame owns it

  if (outcome === 'ready') {
    tlPresent(i, slot);
    tlPrefetch();
    tlPreparePaint();
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

// ---------------------------------------------------------------- out of the film
// The date card, pressed, leaves the film and opens the capture in the compare
// view, with the slider's *from* handle on the date that was on the card.
//
// Watching a capture raises the question the film cannot answer, what changed
// here, exactly?, and the answer lives one view over. The pair it opens on is
// this capture against the next one, because that is the change this capture is
// the *before* half of: the same relationship the timeline's handles have, and
// the reason the card's own counts, which are about the change that produced it,
// are deliberately not what gets shown. The date someone presses is the date they
// are asking about, so that is the from date.
function tlOpenInCompare(i) {
  const snaps = (state.snapshots || []);
  if (!snaps.length) return;

  // The film's index and the record's index are the same list in the same order
  // (tlBuildFrames maps state.snapshots one for one), but the timestamp is the
  // thing both sides actually agree on, so it is what gets matched.
  const frame = TL.frames[i];
  let from = frame ? snaps.findIndex((s) => s.timestamp === frame.timestamp) : i;
  if (from < 0) from = Math.min(Math.max(i, 0), snaps.length - 1);

  // The last capture of a record has nothing after it to compare against, so the
  // pair steps back one instead: the change that produced it, which is also the
  // only comparison that capture can be part of.
  let to = Math.min(from + 1, snaps.length - 1);
  if (to === from) from = Math.max(0, to - 1);
  if (to === from) return;    // a record of one capture has nothing to compare

  tlSetPlaying(false);
  closeTimelapse();

  state.fromIndex = from;
  state.toIndex = to;
  renderTimeline();           // positions the handles and writes both dates
  el('timelineSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadDiff();                 // and build the comparison itself
}

el('tlDateCard').addEventListener('click', () => {
  if (TL.export.state === 'recording') return;   // the file being written owns the stage
  tlOpenInCompare(TL.index);
});

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
// phase one these arrive progressively, so the rail visibly builds itself ,
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
// Move to a capture and resolve when it is on screen. The index that describes
// the film is only written when the picture is (see tlPresent), so a seek that
// is still loading leaves the caption on the capture the viewer can actually
// see rather than on the one being fetched.
function tlSeek(i) {
  const n = tlTotal();
  if (!n) return Promise.resolve();
  const next = Math.min(Math.max(i, 0), n - 1);
  TL.target = next;
  TL.beat++;                            // a beat still waiting lets go of it
  const shown = tlShowFrame(next);
  tlPrefetch();
  tlPreparePaint();
  return shown;
}

function tlSetPlaying(on) {
  TL.playing = !!on;
  clearTimeout(TL.timer);
  TL.timer = null;
  TL.beat++;                            // any advance mid-wait is now stale
  if (!TL.playing) {
    TL.waiting = null;
    tlShowBuffer(false);
  }

  // Play is meaningless until the record is here and the frames ahead of it are
  // complete. tlPaintTransport is the one place that decides how the button
  // reads, so the reason it is dark can never drift from the truth.
  tlPaintTransport();

  if (TL.playing) tlScheduleNext();
}

// One beat of screen time for the capture that is on screen. The period is
// measured from the moment that capture arrived, so every frame is held for as
// long as the pace says and never for less: what stretches a run is a frame the
// film had to wait for, and that wait is stated on screen instead of being paid
// for by cutting the picture short.
function tlScheduleNext() {
  clearTimeout(TL.timer);
  if (!TL.playing) return;
  const period = TL_FRAME_MS / TL.speed;
  TL.timer = setTimeout(tlAdvance, period);
}

// One beat of the film, and the place the contract is kept: the film moves to
// the next capture when that capture is complete, and not before.
//
// The fast path is the whole design. After the warm-up the next capture is
// already rendered in a slot, so a beat is two iframe opacities changing in the
// same frame the clock fired. That is the part that is instant, and it is
// instant because the loading was paid for earlier, not because it was skipped.
//
// The slow path is the one that used to lie. If the next capture is not ready,
// the film holds the capture that is on screen, says which one it is waiting
// for, and goes the moment it is complete. Nothing is dropped, nothing is
// jumped over, and the caption never describes a capture that is not the picture.
//
// The only thing stepped over is a capture the Archive cannot produce at all,
// which is a hole in the record rather than a slow frame, and that is named on
// screen as it happens.
async function tlAdvance() {
  if (!TL.playing) return;
  const n = tlTotal();
  if (!n) { tlSetPlaying(false); return; }

  if (TL.index >= n - 1) {
    // End of the record: stop on the last frame rather than looping. A looping
    // timelapse is a screensaver; this is meant to be watched once through.
    tlSetPlaying(false);
    return;
  }

  const beat = TL.beat;
  const next = TL.index + 1;

  const held = tlSlotHolding(next);
  if (held) {
    tlPresent(next, held);
    tlScheduleNext();
    tlPrefetch();
    tlPreparePaint();
    return;
  }

  // Not there yet: hold the picture, say what the wait is for, and move as soon
  // as the frame is whole. TL.target is set so the prefetcher and the slot
  // protector both know which capture the film is waiting on.
  TL.target = next;
  TL.waiting = next;
  tlShowBuffer(true, `waiting for capture ${tlFmt(next + 1)} of ${tlFmt(n)} to finish loading\u2026`);

  const { outcome, slot } = await tlEnsureLoaded(next);
  if (beat !== TL.beat || !TL.playing) return;   // paused, seeked or restarted

  if (outcome === 'ready' && slot) {
    tlPresent(next, slot);
    tlScheduleNext();
    tlPrefetch();
    tlPreparePaint();
    return;
  }

  if (outcome === 'missing') {
    tlShowBuffer(true, `capture ${tlFmt(next + 1)} is unavailable, stepping past it\u2026`);
    // The playhead moves over the hole and the next beat is a fresh one, so a
    // record with missing captures still plays end to end.
    TL.index = next;
    TL.target = next;
    tlPaintRailHead();
    tlPrefetch();
    setTimeout(() => { if (TL.playing && beat === TL.beat) tlAdvance(); }, 260);
    return;
  }

  // 'stolen': the capture was taken by another slot while this beat waited for
  // it. Ask again rather than assume, and give the pool a moment to settle.
  setTimeout(() => { if (TL.playing && beat === TL.beat) tlAdvance(); }, 40);
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
    tlFadeFor();
    tlUpdateSubtitle();
    // A new pace wants a deeper runway before it starts, so the transport and the
    // prepare row are re-read against the number this pace needs, and the pool
    // starts filling towards it immediately.
    tlPaintTransport();
    tlPreparePaint();
    tlPrefetch();
    if (TL.playing) tlScheduleNext();
  });
});

// Space plays and pauses, the arrows step frame by frame, the same three keys
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
// Every number here is the store's, not this file's, if the dashboard is what
// started the reading, this card is reporting on someone else's progress and
// is right to do so.
function tlPaintLoader() {
  const n = tlTotal();
  const { done, total, year, etaSeconds, stage } = TL.progress;
  const steps = total || Math.max(0, n - 1);
  const pct = steps ? Math.min(100, Math.round((done / steps) * 100)) : 0;

  // Three different waits wear this one card, and the difference between them
  // matters: a couple of seconds for a record this machine already holds, a
  // quarter of an hour for the part that has to come off the Archive, and the
  // numbers behind the rail, which nobody waits on. Saying "reaching for the
  // Internet Archive" through a three-second database read would be a lie a
  // person can watch.
  el('tlLoadFill').style.width = pct + '%';

  if (stage === 'captures') {
    el('tlLoaderText').textContent =
      `Reading ${tlFmt(steps)} capture${steps === 1 ? '' : 's'} from the Archive`;
    el('tlLoadSub').textContent = !done
      ? 'Reaching for the Internet Archive\u2026'
      : done >= steps
        ? 'Filing the last pages\u2026'
        : `${pct}% \u00b7 now covering ${year || 'the record'} \u00b7 about ${tlHumanSeconds(etaSeconds)} left`;
    return;
  }

  el('tlLoaderText').textContent = `Retrieving capture 1 of ${tlFmt(n)}`;
  el('tlLoadSub').textContent = 'Reading the record from this machine\u2026';
}

// A small status light rather than a screen-covering panel. It only ever
// appears for a capture that genuinely could not be retrieved; in normal
// playback it is never seen, because phase one has already finished.
function tlShowBuffer(on, text) {
  el('tlBuffer').hidden = !on;
  if (on && text) el('tlBufferText').textContent = text;
  // The buffer pill and the scroll hint share the same bottom-centre seat:
  // never seat both at once, or their two sentences print on top of each other.
  if (on) {
    clearTimeout(tlScrollHintTimer);
    el('tlScrollHint').hidden = true;
  }
}

// Start from a known state: nothing playing, and the transport locked until
// phase one hands over a complete record.
tlSetPlaying(false);
tlPaintExportHud();

// ---------------------------------------------------------------- download
// The film can be kept as a video file, and that file is *written*, not filmed.
//
// Every capture is laid out here and painted into a canvas, the page as the
// stage's window crops it, the date card, the counts, and the canvas is what
// the encoder is handed. Nothing about the screen is involved: no sharing
// prompt, no permission, no dependence on which tab is in front, and no frame
// that had not finished arriving. What comes out is an ordinary video file that
// lands in Downloads, plays in any player, and can be sent to somebody.
//
// Why written rather than captured: a recording of this window is a picture of a
// browser, at whatever size the window happened to be, at whatever pace the tab
// could keep up with, with its own progress row in the picture. A file about a
// record should be composed from the record.
//
// The pace is seconds per capture, not a frame rate. One capture is one still
// moment of a site's life, and holding it long enough to read is the point.
const TL_EXPORT_PACES = [0.25, 0.5, 1];

// Stills are composed wider than the stage on purpose: the file outlives the
// window it was made in. 1600 is wide enough to keep a 2015 layout out of its
// tablet breakpoint and small enough that a phone can still decode the result.
const TL_EXPORT_WIDTH = 1600;
// Twelve megabits of a slideshow is a lot, which is the point: these frames are
// text, and text is what a cheap bitrate turns to mush.
const TL_EXPORT_BITRATE = 12000000;
// Inlined assets, kept between stills. The same logo is in every frame of a
// record, and a data: URI of it is worth keeping for the frames that follow.
const TL_DATA_CACHE_MAX = 400;
// How many references of one still are inlined at the same time. Eight is a
// compromise rather than a limit anyone measured: enough to turn a minute of
// serial waiting into a few seconds, few enough that a cold record does not open
// two hundred connections to a polite queue. See tlPool.
const TL_INLINE_LANES = 8;
// A one-pixel transparent GIF: what an asset that cannot be inlined becomes.
//
// It has to become *something*, and this is the least surprising thing. A still
// that names any resource outside itself, even one the browser refuses to load,
// even a mailto: behind a picture, taints the canvas it is drawn into, and a
// tainted canvas is refused by the encoder **silently**: the recorder runs, the
// frames go in, and the file comes out empty. Measured: one such reference cost a
// whole export, with no error anywhere.
const TL_BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

// Which container this browser will actually write. MP4 with H.264 when it can
// (Chrome, Edge and Safari all can now, from a canvas, with no permission of any
// kind), WebM when it cannot, named for what it is rather than for what was
// asked for, because a file called .mp4 that is not one is a file that fails to
// open somewhere later.
const TL_EXPORT_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];

function tlExportContainer() {
  const mime = window.MediaRecorder
    ? TL_EXPORT_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || ''
    : '';
  return { mime, ext: mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm', supported: !!mime };
}

// The palette the stills are painted with, resolved from the page's own
// variables so a video made next year looks like the app it was made in ,
// canvas cannot read var(), so the values are looked up once per export.
function tlExportPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    card: v('--card', '#FCF9F0'),
    ink: v('--ink', '#1B1811'),
    soft: v('--ink-soft', '#6D6650'),
    line: v('--line-strong', '#C9BB8E'),
    added: v('--added', '#3F7A4E'),
    removed: v('--removed', '#BB4530'),
    changed: v('--changed', '#A8791F'),
    serif: v('--serif', 'Georgia, serif'),
    sans: v('--sans', 'sans-serif'),
    mono: v('--mono', 'monospace'),
  };
}

// One asset as a data: URI, kept for the frames that follow.
//
// Why inlined at all: a still is drawn by handing an SVG to an <img>, and an SVG
// being loaded as an image is not allowed to fetch anything from outside itself.
// That rule is also what makes this safe to paint, nothing off this machine can
// reach the canvas, but it means an asset left pointing at a URL would simply be
// absent from the file. Inlining is what makes the pictures appear.
const tlDataCache = new Map();
// The same address asked for twice before the first answer arrived. A page that
// names one picture in four places, inlined from four places at once, would
// otherwise fetch and base64 it four times over, same bytes, four times the
// work, all of it on the path a beat is waiting behind.
const tlDataPending = new Map();

function tlAbs(ref) {
  try { return new URL(ref, location.href).toString(); } catch (_) { return null; }
}

// Several jobs at once, in order, with a ceiling.
//
// Every reference in a still, a picture, a font, a background, is a fetch and
// a base64 conversion, and they were done strictly one after another, which is
// the whole reason a cold first still took half a minute: at two hundred
// milliseconds each, a page with a hundred and thirty references is twenty-six
// seconds of waiting for work that has no ordering in it at all. The ceiling is
// real, though: the Archive answers this app through one polite queue, and
// unleashing two hundred requests at it does not make them arrive sooner.
async function tlPool(items, lanes, fn) {
  const out = new Array(items.length);
  let at = 0;
  const width = Math.max(1, Math.min(lanes | 0 || 1, items.length));
  const workers = [];
  for (let n = 0; n < width; n++) {
    workers.push((async () => {
      while (at < items.length) {
        const i = at++;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function tlAssetData(url) {
  if (!url || /^(data|blob):/i.test(url)) return url || null;
  const hit = tlDataCache.get(url);
  // `undefined` means nobody has asked, and `null` means somebody asked and the
  // Archive does not hold it. Kept apart on purpose: a picture that is gone is
  // gone for the whole film, and re-asking once per still for a hundred stills
  // is a hundred requests that cannot succeed.
  if (hit !== undefined) return hit;
  const flight = tlDataPending.get(url);
  if (flight) return flight;
  const job = (async () => {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) { tlRememberData(url, null); return null; }
      // A picture the Archive does not hold is a document, not a picture: the
      // server already answers those with a blank pixel (see lib/assetCache.js),
      // and this is the second half of the same rule, for anything that got here
      // as HTML anyway. Left as it is, the still would carry an HTML page as an
      // image and draw the broken-picture glyph with the alt text beside it.
      if (/text\/html/i.test(res.headers.get('content-type') || '')) { tlRememberData(url, null); return null; }
      const blob = await res.blob();
      const uri = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('unreadable'));
        fr.readAsDataURL(blob);
      });
      tlRememberData(url, uri);
      return uri;
    } catch (_) {
      return null;
    }
  })();
  tlDataPending.set(url, job);
  try {
    return await job;
  } finally {
    tlDataPending.delete(url);
  }
}

function tlRememberData(url, uri) {
  if (tlDataCache.size >= TL_DATA_CACHE_MAX) tlDataCache.delete(tlDataCache.keys().next().value);
  tlDataCache.set(url, uri);
}

// Every url() in a stylesheet, inlined too, and in a stylesheet this app's own
// server has already rewritten, so those URLs are its own asset cache. A video
// of a site is not the place for a font that has to be fetched: the file is
// written once and read for years.
const TL_CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const TL_CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

async function tlInlineCss(text, base, depth = 0) {
  let out = text;
  if (depth < 3) {
    // Imports recurse and are rare, so they stay in order. A sheet that pulls in
    // three others is three large strings; it is not three hundred pictures.
    for (const m of Array.from(out.matchAll(TL_CSS_IMPORT_RE))) {
      const abs = tlAbs(m[2] || m[4]);
      let sub = '';
      if (abs) {
        try {
          const res = await fetch(abs, { credentials: 'omit' });
          if (res.ok) sub = await tlInlineCss(await res.text(), abs, depth + 1);
        } catch (_) { /* an import that cannot be read is absent, as it was in the film */ }
      }
      out = out.split(m[0]).join(sub);
    }
  }
  const refs = [];
  const seen = new Set();
  for (const m of out.matchAll(TL_CSS_URL_RE)) {
    const ref = m[2];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    // A fragment (#filter, #gradient) is inside the document already and stays
    // one. Everything else is either inlined or neutralised: what is left pointing
    // outward would take the canvas with it.
    if (/^(data|blob):/i.test(ref) || ref.charAt(0) === '#') continue;
    refs.push(ref);
  }
  if (!refs.length) return out;
  // All of them at once, then one rewrite of the text.
  //
  // The rewrite being one pass matters as much as the fetching being parallel: a
  // sheet with a hundred url()s used to be copied, end to end, a hundred times.
  const pairs = await tlPool(refs, TL_INLINE_LANES,
    async (ref) => [ref, (await tlAssetData(tlAbs(ref))) || TL_BLANK_PIXEL]);
  const map = new Map(pairs);
  return out.replace(TL_CSS_URL_RE, (all, quote, ref) => {
    const uri = map.get(ref);
    return uri ? `url("${uri}")` : all;
  });
}

// The background the page itself sits on. It belongs to the canvas rather than
// to the SVG: inside a foreignObject the body is exactly as tall as its content,
// so a background that covers the window in the film would cover only the top of
// the still. Read from the rendered frame when one is on the stage, and from the
// markup's own bgcolor when one is not.
function tlStillBackground(i, page) {
  const slot = tlSlotHolding(i);
  if (slot) {
    try {
      const d = slot.el.contentDocument;
      const c = (getComputedStyle(d.body).backgroundColor || '').trim();
      if (c && !/^rgba\(0, 0, 0, 0\)$/.test(c)) return c;
    } catch (_) { /* not readable yet: fall through to the markup's own answer */ }
  }
  const attr = page && page.body ? page.body.getAttribute('bgcolor') : null;
  return attr || '#ffffff';
}

// An archived page is HTML and a still is XML, and the two do not always agree
// about what a name may be. A page carrying `<gcse:search>`, Google's custom
// search element, and this record has one, is perfectly good HTML and a
// malformed XML document: the prefix is never declared, and an XML parser stops
// at it, which means the image never loads and the still is empty. Measured: that
// one element failed a whole 4.9MB still.
//
// The prefix is what goes. The element keeps its children and its attributes
// under a plain name, which is all a still can use from a custom element anyway.
function tlUnprefix(page) {
  for (const node of Array.from(page.querySelectorAll('*'))) {
    const name = node.tagName || '';
    const at = name.indexOf(':');
    if (at <= 0 || !node.parentNode) continue;
    let next = null;
    try { next = node.ownerDocument.createElement(name.slice(at + 1)); } catch (_) { continue; }
    for (const attr of Array.from(node.attributes || [])) {
      if (attr.name === 'xmlns' || attr.name.indexOf('xmlns:') === 0) continue;
      const colon = attr.name.indexOf(':');
      const plain = colon > 0 ? attr.name.slice(colon + 1) : attr.name;
      try { next.setAttribute(plain, attr.value); } catch (_) { /* a name XML will not take is dropped */ }
    }
    while (node.firstChild) next.appendChild(node.firstChild);
    node.parentNode.replaceChild(next, node);
  }
}

// One capture, made self-contained: every stylesheet and every picture written
// into the document itself, so it draws with no network of any kind.
//
// The page's own <style> blocks and its linked sheets become one sheet inside the
// body, because in an SVG the styles have to be part of the content they style.
// The pictures become data: URIs; the srcset candidates are dropped rather than
// inlined, because a still has exactly one width and inlining four versions of a
// photograph to use none of three of them is work for nobody.
//
// Returns { svg, bg } or null for a document there is nothing to draw.
async function tlStillSvg(html, i, W, H) {
  const page = new DOMParser().parseFromString(html, 'text/html');
  tlUnprefix(page);
  page.querySelectorAll('base, script, noscript, iframe, object, embed, video, audio, source, link[rel="preload"], link[rel="prefetch"]')
    .forEach((n) => n.remove());

  // The page's styles, read as the page has them: links and <style> blocks in one
  // document-order pass, because that order *is* the cascade. They were two
  // passes - every link, then every block - and swapping them is not cosmetic: a
  // page that overrides its framework in a <style> written above the <link> was
  // rendered with the framework winning.
  const sheetJobs = [];
  for (const node of Array.from(page.querySelectorAll('link, style'))) {
    if (node.tagName === 'STYLE') {
      sheetJobs.push({ node, kind: 'block' });
      continue;
    }
    const href = node.getAttribute('href');
    const rel = node.getAttribute('rel') || '';
    const media = (node.getAttribute('media') || '').trim();
    // A sheet meant for paper is not part of what the film shows, and it has to be
    // dropped here rather than carried over: these sheets all become one <style>,
    // and a style has no media to inherit. Measured, inlining a page's print.css
    // without its attribute printed the page into the still: centered header, no
    // hero image, the whole desktop layout replaced by the one nobody sees.
    if (/print/i.test(media) && !/screen/i.test(media)) { node.remove(); continue; }
    if (!href || !(/stylesheet/i.test(rel) || /\.css(\?|$)/i.test(href))) { node.remove(); continue; }
    sheetJobs.push({ node, kind: 'link', media, abs: tlAbs(href) });
  }
  // A few sheets at once rather than one: they are independent reads, and each is
  // the slowest thing in a still that has to cross the network.
  const sheetCss = await tlPool(sheetJobs, 3, async (job) => {
    if (job.kind === 'block') return tlInlineCss(job.node.textContent || '', location.href);
    if (!job.abs) return '';
    try {
      const res = await fetch(job.abs, { credentials: 'omit' });
      if (!res.ok) return '';
      const css = await tlInlineCss(await res.text(), job.abs);
      return job.media && !/^all$/i.test(job.media) ? `@media ${job.media} {\n${css}\n}` : css;
    } catch (_) { /* a sheet that could not be read is one the frame did not have either */ }
  });
  const sheets = [];
  sheetJobs.forEach((job, i) => {
    if (sheetCss[i]) sheets.push(sheetCss[i]);
    job.node.remove();
  });

  await tlPool(Array.from(page.querySelectorAll('img')), TL_INLINE_LANES, async (img) => {
    img.removeAttribute('srcset');
    img.setAttribute('src', (await tlAssetData(tlAbs(img.getAttribute('src')))) || TL_BLANK_PIXEL);
  });
  const styled = Array.from(page.querySelectorAll('[style]'))
    .filter((node) => (node.getAttribute('style') || '').indexOf('url(') >= 0);
  await tlPool(styled, TL_INLINE_LANES, async (node) => {
    node.setAttribute('style', await tlInlineCss(node.getAttribute('style') || '', location.href));
  });

  // Every other way a document can point at something: a link, a poster frame, an
  // old-fashioned background attribute, a form. A picture is fetched and inlined;
  // a link is simply dropped, because a still cannot be clicked and the only
  // thing its address can do here is taint the canvas.
  const URL_ATTRS = ['href', 'src', 'poster', 'background', 'action', 'formaction', 'data', 'longdesc', 'cite'];
  const INLINE_ATTRS = new Set(['src', 'poster', 'background']);
  const attrJobs = [];
  for (const node of Array.from(page.querySelectorAll('*'))) {
    for (const attr of URL_ATTRS) {
      if (!node.hasAttribute(attr)) continue;
      const raw = (node.getAttribute(attr) || '').trim();
      if (!raw || /^(data|#)/i.test(raw)) continue;
      if (INLINE_ATTRS.has(attr)) attrJobs.push({ node, attr, raw });
      else node.removeAttribute(attr);
    }
  }
  await tlPool(attrJobs, TL_INLINE_LANES, async (job) => {
    job.node.setAttribute(job.attr, (await tlAssetData(tlAbs(job.raw))) || TL_BLANK_PIXEL);
  });

  const body = page.body;
  if (!body) return null;
  const style = page.createElement('style');
  style.textContent = sheets.join('\n');
  body.insertBefore(style, body.firstChild);

  const xml = new XMLSerializer().serializeToString(body);
  const raw = '<?xml version="1.0" encoding="UTF-8"?>' +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`;
  // Belt and braces, on the string itself: one reference the inliner missed does
  // not fail loudly, it empties the file, so the finished document is checked
  // before anything is drawn from it. A reference that is not a fragment and not
  // inside the document already is removed; a url() left in a style is pointed at
  // the blank pixel, since CSS cannot simply lose the value and still parse.
  const svg = raw
    .replace(/((?:href|src)\s*=\s*["'])(?!#|data:)[^"']*(["'])/gi, '$1$2')
    .replace(/url\(\s*["']?(?!#|data:)[^)"']*["']?\s*\)/gi, `url(${TL_BLANK_PIXEL})`)
    // A prefixed attribute is the same problem as a prefixed element, XML will
    // not take a prefix it has not been told about, and the namespace
    // declarations themselves are what a parser is looking for, so they stay.
    .replace(/(\s)([a-zA-Z_][\w.-]*):([a-zA-Z_][\w.-]*)=/g,
      (m, sp, pre, name) => (pre === 'xmlns' ? m : sp + name + '='));
  return { svg, bg: tlStillBackground(i, page) };
}

// One still, laid out and decoded: ready to be drawn without any work left in it.
// Null means the capture could not be produced at all, which is a fact about the
// record rather than a failure of the file, its still says so.
async function tlRenderStill(i, W, H) {
  const raw = await tlDocFor(i);
  if (!raw) return null;
  const built = await tlStillSvg(tlCanonicalize(raw), i, W, H);
  if (!built) return null;
  // A data: URL rather than a blob: one, and that is not a preference, it is the
  // difference between a file and an empty file. Chromium treats an SVG image
  // containing a foreignObject as origin-unclean when it arrives from a blob:
  // URL: drawing it taints the canvas, and a tainted canvas is silently refused by
  // the encoder, so the recorder runs, the frames go in, and nothing comes out.
  // The identical document from a data: URL draws clean. Both were measured.
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(built.svg);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('the still could not be rendered'));
      img.src = url;
    });
    // Decoded here rather than at draw time, which is the point of rendering a
    // frame ahead: the beat is spent showing the capture, not rasterising it.
    if (img.decode) await img.decode();
  } catch (_) {
    return null;
  }
  return { img, bg: built.bg };
}

function tlRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// The date card and the counts, painted into the still, the same two objects the
// film floats over the page, at the still's own scale. A file whose frames are
// only pages is a set of screenshots; the date is what makes it a record.
function tlDrawCaption(ctx, i, W, H, pal) {
  const frame = TL.frames[i];
  if (!frame) return;
  const k = W / 1280;                 // the film's own proportions, scaled
  const pad = Math.round(24 * k);
  const date = formatDate(frame.date);
  const gap = i === 0
    ? 'the first capture on file'
    : frame.gapDays < 1
      ? 'another capture the same day'
      : `${tlFmt(frame.gapDays)} day${frame.gapDays === 1 ? '' : 's'} since the previous capture`;

  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${Math.round(10 * k)}px ${pal.sans}`;
  const wEyebrow = ctx.measureText('CAPTURED').width + Math.round(1.2 * k) * 8;
  ctx.font = `italic 600 ${Math.round(34 * k)}px ${pal.serif}`;
  const wDate = ctx.measureText(date).width;
  ctx.font = `${Math.round(12 * k)}px ${pal.sans}`;
  const wGap = ctx.measureText(gap).width;

  const cw = Math.round(Math.max(wEyebrow, wDate, wGap) + 40 * k);
  const ch = Math.round(96 * k);
  const cx = pad;
  const cy = H - pad - ch;

  ctx.save();
  ctx.shadowColor = 'rgba(27, 24, 17, 0.20)';
  ctx.shadowBlur = Math.round(18 * k);
  ctx.shadowOffsetY = Math.round(6 * k);
  ctx.fillStyle = 'rgba(252, 249, 240, 0.96)';
  tlRoundRect(ctx, cx, cy, cw, ch, Math.round(14 * k));
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = Math.max(1, Math.round(k));
  tlRoundRect(ctx, cx + 0.5, cy + 0.5, cw - 1, ch - 1, Math.round(14 * k));
  ctx.stroke();

  const tx = cx + Math.round(20 * k);
  ctx.fillStyle = pal.soft;
  ctx.font = `600 ${Math.round(10 * k)}px ${pal.sans}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(1.2 * k)}px`;
  ctx.fillText('CAPTURED', tx, cy + Math.round(26 * k));
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.fillStyle = pal.ink;
  ctx.font = `italic 600 ${Math.round(34 * k)}px ${pal.serif}`;
  ctx.fillText(date, tx, cy + Math.round(65 * k));
  ctx.fillStyle = pal.soft;
  ctx.font = `${Math.round(12 * k)}px ${pal.sans}`;
  ctx.fillText(gap, tx, cy + Math.round(85 * k));

  const c = frame.counts;
  if (!c) return;
  const figs = [
    [`+${tlFmt(c.added)}`, pal.added],
    [`\u2212${tlFmt(c.removed)}`, pal.removed],
    [`~${tlFmt(c.changed)}`, pal.changed],
  ];
  ctx.font = `${Math.round(13 * k)}px ${pal.mono}`;
  const widths = figs.map(([t]) => ctx.measureText(t).width);
  const gapX = Math.round(22 * k);
  const pw = Math.round(widths.reduce((a, b) => a + b, 0) + gapX * (figs.length - 1) + 40 * k);
  const ph = Math.round(44 * k);
  const px = W - pad - pw;
  const py = H - pad - ph;
  ctx.save();
  ctx.shadowColor = 'rgba(27, 24, 17, 0.18)';
  ctx.shadowBlur = Math.round(16 * k);
  ctx.shadowOffsetY = Math.round(5 * k);
  ctx.fillStyle = 'rgba(252, 249, 240, 0.96)';
  tlRoundRect(ctx, px, py, pw, ph, ph / 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = pal.line;
  tlRoundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, (ph - 1) / 2);
  ctx.stroke();
  ctx.font = `${Math.round(13 * k)}px ${pal.mono}`;
  let at = px + Math.round(20 * k);
  for (let n = 0; n < figs.length; n++) {
    ctx.fillStyle = figs[n][1];
    ctx.fillText(figs[n][0], at, py + ph / 2 + Math.round(5 * k));
    at += widths[n] + gapX;
  }
}

function tlDrawStill(ctx, still, i, W, H, pal) {
  if (still && still.img) {
    ctx.fillStyle = still.bg || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(still.img, 0, 0, W, H);
  } else {
    // Stated in the file rather than left as a black frame: a capture the record
    // cannot produce is a hole in the record, and the file says so where the
    // picture would be.
    ctx.fillStyle = '#f3eddc';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = pal.soft;
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(15 * (W / 1280))}px ${pal.sans}`;
    ctx.fillText('this capture could not be rendered', W / 2, H / 2);
    ctx.textAlign = 'left';
  }
  tlDrawCaption(ctx, i, W, H, pal);
}

// The stage shows the file being written. The canvas is the source and stays the
// source; this is a copy, because a download that shows nothing for six minutes
// is a download nobody trusts, and this is exactly what is going into it.
function tlExportLiveShow(canvas) {
  const live = el('tlLive');
  if (!live) return;
  if (live.width !== canvas.width || live.height !== canvas.height) {
    live.width = canvas.width;
    live.height = canvas.height;
  }
  try { live.getContext('2d').drawImage(canvas, 0, 0); } catch (_) {}
  live.hidden = false;
}

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
  // The explanatory paragraph under the title was removed: title, pace, time
  // estimate and the note below the buttons already say everything.
  el('tlExportSub').textContent = '';
  el('tlExportSub').hidden = true;
  for (const btn of document.querySelectorAll('.tl-export-pace')) {
    btn.classList.toggle('is-active', parseFloat(btn.dataset.pace) === TL.export.pace);
  }
  el('tlExportTime').textContent = `\u2248 ${tlExportEstimate()}`;
  const { ext, supported } = tlExportContainer();
  el('tlExportNote').textContent = !supported
    ? 'This browser cannot write a video file from a canvas. Chrome, Edge and Safari can.'
    : (ext === 'mp4'
      ? 'Saves an MP4 into your downloads.'
      : 'Saves a WebM: this browser cannot write MP4, so the file is the format it can.');
  el('tlExportStart').disabled = !supported;
}

// How many stills are composed at the same time, ahead of the file. Three is not
// a guess at a number: composing a still is a parse, a decode and a rasterization
// on three different engines, and the parts that wait overlap while the parts that
// compute take turns. Measured on one capture of a photograph-heavy page: one at
// a time is about 1.4 seconds, three at a time is about 0.6 seconds per still.
const TL_EXPORT_AHEAD = 3;

// Write the file.
//
// Every capture is laid out and painted into a canvas here, one still per
// capture, and the canvas is what the encoder is handed, so the film on the
// stage is not involved in any way, and neither is the screen.
//
// The file is written to a beat, and the beat is the one that was chosen. That is
// the part that took the longest to get right, because MediaRecorder stamps a
// canvas by the *clock*, not by anything the code says: a frame handed over is a
// frame at the time it was handed over, so the only way a file holds each capture
// for half a second is to hand each one over half a second after the last. So the
// loop below is a clock, and the stills are composed *ahead* of it, several at
// once, in its shadow, rather than the clock waiting on the composing (which is
// what makes a file whose beats are however long the machine took) or the
// composing waiting on the clock (which would waste the hold).
//
// When composing cannot keep up, the picture on the glass holds for one more
// beat and the capture that was due takes the next one. Every capture still
// reaches the file, every beat is still exactly the beat that was asked for, and
// what grows is the number of beats, which is stated in the row below while it
// happens rather than discovered in the finished file.
async function tlExportStart() {
  const total = tlTotal();
  if (TL.phase !== 'ready' || !total || TL.export.state === 'recording') return;
  const { mime, ext, supported } = tlExportContainer();
  if (!supported || !HTMLCanvasElement.prototype.captureStream) {
    el('tlExportNote').textContent =
      'This browser cannot write a video file from a canvas. Chrome, Edge and Safari can.';
    return;
  }
  tlSetPlaying(false);
  Object.assign(TL.export, {
    state: 'recording', on: true, finishing: false, chunks: [],
    mime, ext, index: 0, written: 0, beat: 0, repeats: 0, composed: 0, failures: 0,
    startedAt: Date.now(), palette: tlExportPalette(),
  });
  tlExportCloseCard();
  tlPaintExportHud();
  // The row keeps its own clock. The first capture of a cold record is a minute of
  // fetching and inlining, and a row that only redrew when a frame landed would
  // sit frozen through all of it, looking exactly like a row that had given up.
  clearInterval(TL.export.tick);
  TL.export.tick = setInterval(tlPaintExportHud, 500);

  // The stills are composed at the stage's own shape *as it is while the file is
  // written*, the swap above changes its height, so the file shows each page
  // the way the film shows it, the same crop and the same breakpoints. Wider
  // than the window when the window allows it, because the file outlives it.
  const rect = document.querySelector('.tl-stage').getBoundingClientRect();
  const W = Math.max(960, Math.min(TL_EXPORT_WIDTH, Math.round(rect.width) || 1280)) & ~1;
  const H = Math.max(540, Math.round(W * ((rect.height || 720) / (rect.width || W)))) & ~1;
  // Every still is cropped from the top of its capture, and that is a decision
  // rather than an oversight. The wheel's position belongs to the film, where
  // each capture is rendered and can be clamped to its own height as it arrives;
  // a still has no such second chance, it is one rasterization of one document,
  // and a park deep enough to be past a short capture's end would write blank
  // frames into the file for the early years of the record. A file that opens
  // every page at its beginning is the one crop that is never wrong.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const paceMs = TL.export.pace * 1000;
  const pal = TL.export.palette;

  // The composing, running ahead of the writing. `flight` is what is still being
  // composed and `ready` what has arrived; both are emptied as they are consumed,
  // and that is load-bearing twice over. A map that only ever grows holds a
  // decoded still per capture, megabytes each, for a record of hundreds, and a
  // count of started jobs that is never given back means the pipeline fills to its
  // ceiling once and then never starts another capture at all. Both were bugs in
  // this loop, and the second one is invisible: the file simply stops moving.
  const flight = new Map();
  const ready = new Map();
  let composing = 0;
  const fill = () => {
    while (composing < total && flight.size < TL_EXPORT_AHEAD) {
      const i = composing++;
      const pending = tlRenderStill(i, W, H).catch(() => null);
      flight.set(i, pending);
      pending.then((still) => {
        TL.export.composed++;
        ready.set(i, still || null);
        flight.delete(i);
      });
    }
  };
  fill();

  // The first still is composed before the encoder is started, so the file opens
  // on the first capture of the record. Started the other way round, recorder
  // first, still whenever it arrives, the file begins with however long that
  // took of nothing at all.
  const first = ready.has(0) ? ready.get(0) : await (flight.get(0) || tlRenderStill(0, W, H).catch(() => null));
  ready.delete(0);
  if (!TL.export.on) {
    clearInterval(TL.export.tick);
    TL.export.tick = null;
    TL.export.state = 'idle';
    el('tlLive').hidden = true;
    tlPaintExportHud();
    return;
  }
  if (!first) TL.export.failures++;
  TL.export.written = 1;
  tlDrawStill(ctx, first, 0, W, H, pal);
  tlExportLiveShow(canvas);
  tlPaintExportHud();

  // A stream asked for no frames of its own and pushed into by hand: exactly one
  // still per beat, and no chance of the encoder inventing a duplicate of a page
  // or dropping one because the tab was busy with something else.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: TL_EXPORT_BITRATE });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) TL.export.chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  // The clock the row reads was set when the export began, not here: composing
  // the first stills of a cold record is a minute of work, and a row that said
  // 0:00 through all of it reads as a row that is not running.
  Object.assign(TL.export, { rec, track, width: W, height: H });
  TL.export.done = done;
  rec.start(1000);

  const started = performance.now();
  TL.export.beat = 1;         // the first capture has had its beat
  track.requestFrame();       // and it is at the head of the file

  let last = first;
  while (TL.export.on && TL.export.written < total) {
    const next = TL.export.written;
    const due = started + TL.export.beat * paceMs;
    let still = ready.has(next) ? ready.get(next) : null;
    if (!still) {
      // Not here yet: wait, but never past the beat it was due at.
      const left = due - performance.now();
      if (left > 0) await tlSleep(left);
      still = ready.has(next) ? ready.get(next) : null;
    }
    if (!TL.export.on) break;
    if (!still) {
      // Its beat has come and the capture is not composed. The picture on the
      // glass holds for one more beat rather than the file holding it for an
      // unmeasured one, and this capture takes the next beat instead.
      //
      // The hold is a *repaint* of the same still, not just another push of the
      // same canvas, and that is the difference between a hold and nothing at all.
      // Measured: Chromium emits a frame only for a canvas that has been drawn on
      // since the last one, so an untouched canvas handed over again is silently
      // no frame, the hold would not be in the file, and the capture after it
      // would quietly be the one that lasted two beats.
      TL.export.repeats++;
      TL.export.beat++;
      tlDrawStill(ctx, last, Math.max(0, next - 1), W, H, pal);
      track.requestFrame();
      fill();
      tlPaintExportHud();
      continue;
    }
    // Composed early: held until its beat, because that is what the beat is for.
    const wait = due - performance.now();
    if (wait > 0) await tlSleep(wait);
    if (!TL.export.on) break;
    tlDrawStill(ctx, still, next, W, H, pal);
    track.requestFrame();
    tlExportLiveShow(canvas);
    ready.delete(next);
    last = still;
    TL.export.index = next;
    TL.export.written++;
    TL.export.beat++;
    tlPaintExportHud();
    fill();
  }
  // The last capture is held for its beat too, or the file ends the instant it
  // appears, its beat is the gap between it and the frame that never comes. So
  // one more beat is handed over showing it again: the file's length is then the
  // whole of the record's time, and a player that loops does not flash the last
  // capture for a single frame.
  if (TL.export.on) {
    await tlSleep(paceMs);
    if (TL.export.on) {
      TL.export.beat++;
      // Repainted for the same measured reason as a hold: a push of a canvas
      // nobody has drawn on is not a frame, and a repaint of the same picture is
      // one, for about twenty-five bytes.
      tlDrawStill(ctx, last, Math.max(0, total - 1), W, H, pal);
      track.requestFrame();
    }
  }
  await tlExportFinish();
}

// Stop, close the file, hand it over. Safe to call from anywhere: the sharing
// track ending, the stop button, or the film closing.
async function tlExportFinish() {
  if (TL.export.state !== 'recording' || TL.export.finishing) return;
  TL.export.finishing = true;
  TL.export.on = false;
  clearInterval(TL.export.tick);
  TL.export.tick = null;
  // The frame that was handed over last is not in the file the moment it is
  // handed over: a captured canvas frame reaches the encoder on the next
  // compositor tick, and a stop issued in the same turn loses it. Measured, and
  // what it costs is the final capture of the record, the one frame a viewer is
  // most likely to be looking at when the video stops.
  await tlSleep(150);

  const { rec, track, done, chunks, mime, ext } = TL.export;
  if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} }
  if (done) await done;
  if (track) track.stop();

  const blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  TL.export.blob = blob;
  // Its length, asked of the file rather than worked out from the beats. The last
  // capture is held until the end of the file, and the end of the file is
  // something only the encoder that wrote it knows, a row that did the
  // arithmetic itself would quote a number nobody checked.
  TL.export.seconds = await tlExportMeasure(blob);
  TL.export.finishing = false;
  el('tlLive').hidden = true;

  if (!blob.size) {
    TL.export.state = 'idle';
    tlPaintExportCard();
    el('tlExportNote').textContent = TL.export.rec
      ? 'Nothing was written. The video came out empty.'
      : 'Stopped while the first captures were being composed, so there is no file.';
    el('tlExport').hidden = false;
    tlPaintExportHud();
    return;
  }

  // What is *in* the file, not what the record holds: a file stopped after a
  // hundred captures that calls itself a file of seven hundred and forty-one is a
  // file that lies about itself in its own name.
  const first = TL.frames[0] ? TL.frames[0].date.slice(0, 10) : 'film';
  const slug = state.url.replace(/[^a-z0-9.]+/gi, '-');
  const count = TL.export.written || tlTotal();
  TL.export.name = `palimpsest-${slug}-${first}-${count}-captures.${ext}`;
  TL.export.url = URL.createObjectURL(blob);
  TL.export.state = 'saved';
  tlExportSave();
  tlPaintExportHud();
}

// How long the file is, in seconds, read out of the file. A throwaway <video> and
// its metadata, which is decoded from the same header a player would read; a file
// the browser cannot make sense of resolves to 0 rather than holding the row up.
function tlExportMeasure(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = (seconds) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    v.onloadedmetadata = () => done(isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(isFinite(v.duration) ? v.duration : 0), 3000);
    v.src = url;
  });
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
  // The stage's own furniture goes while the file is being written: the still
  // carries its own date card, and a scrollbar drawn over a composition that
  // cannot be scrolled, the file, not the page, would be a lie about it.
  el('tlDateCard').hidden = busy;
  el('tlDelta').hidden = busy;
  if (busy) {
    el('tlScroll').hidden = true;
    el('tlScrollHint').hidden = true;
  } else if (!saved) {
    el('tlLive').hidden = true;
    tlPaintScrollTrack();
  }

  if (busy) {
    const total = tlTotal();
    const elapsed = TL.export.startedAt ? (Date.now() - TL.export.startedAt) / 1000 : 0;
    const written = TL.export.written || 0;
    // The remaining time is the beats that are left at the pace that was chosen,
    // stretched by how often a capture has had to hold for an extra one. That is
    // the only thing that makes a file take longer than the card promised, and it
    // is caused by this machine at this moment, so it is measured here rather
    // than guessed at when the card was painted.
    const beats = Math.max(1, TL.export.beat || 0);
    const lag = 1 + (TL.export.repeats || 0) / beats;
    const left = (total - written) * TL.export.pace * lag;
    el('tlRecDot').hidden = false;
    el('tlRecLabel').textContent =
      (TL.export.rec
        ? `Writing capture ${tlFmt(Math.max(1, Math.min(written, total)))} of ${tlFmt(total)}`
        : `Composing capture 1 of ${tlFmt(total)}`) +
      (TL.export.repeats ? ` \u00b7 ${tlFmt(TL.export.repeats)} held an extra beat` : '') +
      (TL.export.failures ? ` \u00b7 ${tlFmt(TL.export.failures)} unavailable` : '');
    el('tlRecTime').textContent = `${tlClock(elapsed)} \u00b7 \u2248${tlHumanSeconds(left)} left`;
    el('tlRecAction').textContent = 'Stop & save';
    el('tlRecDone').hidden = true;
  } else if (saved) {
    el('tlRecDot').hidden = true;
    const film = TL.export.seconds ? tlHumanSeconds(TL.export.seconds) : '';
    const part = TL.export.written && TL.export.written < tlTotal()
      ? ` \u00b7 stopped at ${tlFmt(TL.export.written)} of ${tlFmt(tlTotal())}` : '';
    el('tlRecLabel').textContent =
      `Saved ${TL.export.name} \u00b7 ${tlBytes(TL.export.blob ? TL.export.blob.size : 0)}` +
      (film ? ` \u00b7 ${film} long` : '') + part;
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
