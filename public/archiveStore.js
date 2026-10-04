// public/archiveStore.js
//
// One reading of one site's history, taken once and read by everyone who
// wants it.
//
// The dashboard and the timelapse want exactly the same thing from a site's
// past: every capture, in order, with the numbers describing what changed at
// each step, and the pages themselves. They used to go and get it separately.
// The dashboard sampled twenty-eight transitions across the history and kept
// only the numbers. The timelapse then walked the whole record again, from
// the first capture to the last, fetching pages the dashboard's walk had
// already pulled down and thrown away. Two readings of one history, the second
// one paying for most of the first.
//
// So there is one reading now, and both views read it.
//
// ## What the walk costs
//
// One step is one request to /api/record-step for a pair of adjacent captures.
// The Archive hands out roughly one document a second, and the server
// serialises every request to it through lib/rateLimiter.js, so a 740-capture
// record is about thirteen minutes the first time it is read - for everyone,
// not per visitor, because each document is then cached in Turso forever under
// `${url}::${timestamp}`. Every reading after that is served from the
// database and costs no Archive request at all.
//
// Thirteen minutes is a long time to stare at a progress bar, which is why the
// work is shared rather than repeated: whichever view opens first starts the
// walk, and any other view that opens while it is still running attaches to
// that same walk instead of starting a second one. Visit the dashboard, wait
// through it once, and the timelapse opens instantly afterwards - and the other
// way round works too.
//
// ## Why the pages live in IndexedDB
//
// Holding 740 whole archived documents as strings would be tens of megabytes of
// live heap, enough to make the tab stutter and often enough to get it killed.
// So pages go to disk as they arrive and are read back one at a time during
// playback. What stays in the browser between visits is what makes the second
// opening instant: the record is already there, complete, and neither view has
// to fetch anything at all.
//
// ## If IndexedDB is unavailable
//
// Private windows, blocked origins, a full disk. None of this is required for
// the app to work, so every function here degrades rather than throws: the
// documents fall back to a Map in memory, the walk still completes, the
// timelapse still plays and the dashboard still draws - it just costs heap
// and does not survive a reload. That fallback is the reason the code below is
// written in terms of "did this land" rather than "is the database happy".

const AR_IDB_NAME = 'palimpsest-record';
const AR_IDB_STORE = 'record';

// This must be raised whenever the store's name or shape changes, and it was
// not: the store was renamed while the version stayed at 1. A database already
// at version 1 never fires onupgradeneeded again, so the store was never
// created for anyone who had opened the app before the rename — every write and
// read threw, every call silently took the in-memory fallback, and nothing
// persisted across a reload. The failure was invisible because the fallback is
// the whole point of the module: the app worked, it just quietly forgot
// everything between visits.
// Raised to 3 when the frames stopped being trusted to the store's own stamp:
// a document written by an older pipeline renders as a plausible-looking page
// rather than an error, so the whole record on this machine is thrown away and
// read again from the server, which is the copy that is already repaired. The
// record is a cache of something reproducible, so dropping it costs one walk.
const AR_IDB_VERSION = 3;

// Bumped whenever the shape of the stored manifest changes. A manifest written
// by an older build is ignored rather than misread: a half-understood record
// is worse than no record, because it plays back as though it were complete.
const AR_SCHEMA = 2;

// How many steps are in flight at once. The server puts every Archive request
// behind one 1.1s gate no matter how many arrive, so this is not about going
// faster than the Archive allows - it is about keeping the network and the
// server's diffing busy during the gaps between those gated fetches.
const AR_CONCURRENCY = 4;

// How many times one step may be asked for before it is written off. Nearly
// every failure here is a timeout rather than a capture that will never exist,
// so one retry is worth it. An unbounded retry is not: a capture the Archive
// will never have would otherwise be re-requested on every visit.
const AR_MAX_ATTEMPTS = 2;

// Documents per IndexedDB transaction. One transaction per document across 740
// documents would spend more time opening transactions than storing data.
const AR_BATCH = 12;

// ---------------------------------------------------------------- IndexedDB
let arDb = null;
let arDbUnavailable = false;
let arMemory = null;   // Map<key, html>, used only when IndexedDB is not

function arIdbOpen() {
  if (arDb) return Promise.resolve(arDb);
  if (arDbUnavailable) return Promise.resolve(null);
  if (typeof indexedDB === 'undefined') { arDbUnavailable = true; return Promise.resolve(null); }

  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(AR_IDB_NAME, AR_IDB_VERSION); }
    catch (_) { arDbUnavailable = true; return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      // The old store is dropped, not kept: a version bump is how the record on
      // this machine is thrown away, and every document in it is re-read from
      // the server on the next walk.
      if (db.objectStoreNames.contains(AR_IDB_STORE)) db.deleteObjectStore(AR_IDB_STORE);
      db.createObjectStore(AR_IDB_STORE);
    };
    req.onsuccess = () => { arDb = req.result; resolve(arDb); };
    req.onerror = () => { arDbUnavailable = true; resolve(null); };
    req.onblocked = () => { arDbUnavailable = true; resolve(null); };
  });
}

function arStore(mode) {
  return arIdbOpen().then((db) => {
    if (!db) return null;
    try { return db.transaction(AR_IDB_STORE, mode).objectStore(AR_IDB_STORE); }
    catch (_) { return null; }
  });
}

// Keys are namespaced by url so a second reading of the same address reuses
// what is already stored, and a different address can never read another's.
function arKey(url, ts) { return `${url}::${ts}`; }
function arManifestKey(url) { return `${url}::__manifest__`; }

// Identifies the record itself: how many captures, and the first and last
// timestamps. If a re-trace of the same address returns a different list, this
// changes and everything stored under the old signature is dropped rather than
// played back as though it were one record.
function arSignature(url, snaps) {
  return `${snaps.length}|${snaps[0].timestamp}|${snaps[snaps.length - 1].timestamp}`;
}

function arWrite(entries) {
  if (!entries.length) return Promise.resolve(true);

  return arStore('readwrite').then((store) => {
    if (!store) {
      if (!arMemory) arMemory = new Map();
      entries.forEach(([k, v]) => arMemory.set(k, v));
      return true;
    }
    return new Promise((resolve) => {
      let queued = 0;
      try {
        entries.forEach(([k, v]) => { store.put(v, k); queued++; });
      } catch (_) { /* the transaction result decides */ }
      if (!queued) return resolve(false);
      const tx = store.transaction;
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }).catch(() => false);
}

function arRead(key) {
  if (arMemory && arMemory.has(key)) return Promise.resolve(arMemory.get(key));
  return arStore('readonly').then((store) => {
    if (!store) return undefined;
    return new Promise((resolve) => {
      let req;
      try { req = store.get(key); } catch (_) { return resolve(undefined); }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  }).catch(() => undefined);
}

function arClearFor(url) {
  const prefix = `${url}::`;
  if (arMemory) {
    Array.from(arMemory.keys()).forEach((k) => {
      if (k.indexOf(prefix) === 0) arMemory.delete(k);
    });
  }
  return arStore('readwrite').then((store) => {
    if (!store) return false;
    return new Promise((resolve) => {
      let req;
      try { req = store.openCursor(); } catch (_) { return resolve(false); }
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (String(cur.key).indexOf(prefix) === 0) cur.delete();
        cur.continue();
      };
      const tx = store.transaction;
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      req.onerror = () => resolve(false);
    });
  }).catch(() => false);
}

// ---------------------------------------------------------------- the walk

// The single walk, or null when none is in flight. A second caller asking for
// a record that is already being read gets this one rather than a new one.
let arRun = null;

// The most recent completed reading, kept so that reopening a view on a record
// read moments ago is a memory lookup instead of a round trip to disk. It is
// deliberately only the last one: a cache of several would just be a second
// place for the stored record to disagree with.
let arLast = null;

function arEmit(run, progress) {
  if (!run) return;
  run.listeners.forEach((fn) => {
    try { fn(progress); } catch (_) { /* one bad listener must not stop the walk */ }
  });
}

function arMakeProgress(state, index) {
  const done = state.done;
  const total = state.total;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  // Measured from the steps already taken, never from a guess: the Archive's
  // rate varies enormously across a site's history, and an estimate based on
  // the first twenty captures of 1999 says nothing useful about 2024.
  const eta = done > 2 ? Math.max(0, ((total - done) * elapsed) / done) : 0;
  return {
    done,
    total,
    index,
    timestamp: index >= 0 ? state.snaps[index].timestamp : null,
    date: index >= 0 ? state.snaps[index].date : null,
    etaSeconds: eta,
  };
}

function arProgress(state, index, run) {
  if (!run) return;
  run.lastIndex = index;
  arEmit(run, arMakeProgress(state, index));
}

async function arStep(url, snaps, p, needOld) {
  const from = snaps[p];
  const to = snaps[p + 1];

  for (let attempt = 0; attempt < AR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        `/api/record-step?url=${encodeURIComponent(url)}` +
        `&from=${encodeURIComponent(from.timestamp)}` +
        `&to=${encodeURIComponent(to.timestamp)}` +
        (needOld ? '&withOld=1' : '')
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not retrieve that pair of captures.');
      if (typeof data.newHtml !== 'string' || !data.newHtml.length) throw new Error('Empty capture.');
      return data;
    } catch (_) {
      if (attempt + 1 < AR_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

// One capture on its own, with no diff attached. Used to fill a page that a
// failed step should have delivered; nothing else needs it, because every
// other page arrives as part of a step.
async function arCapture(url, ts) {
  for (let attempt = 0; attempt < AR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        `/api/capture?url=${encodeURIComponent(url)}&ts=${encodeURIComponent(ts)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not retrieve that capture.');
      if (typeof data.html !== 'string' || !data.html.length) throw new Error('Empty capture.');
      return data.html;
    } catch (_) {
      if (attempt + 1 < AR_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

async function arWalk(url, snaps, run) {
  const n = snaps.length;
  const sig = arSignature(url, snaps);

  const state = {
    snaps,
    counts: new Array(n).fill(null),
    tags: new Array(n).fill(null),
    totals: new Array(n).fill(0),
    docs: new Array(n).fill(false),
    done: 0,
    total: Math.max(0, n - 1),
    startedAt: Date.now(),
  };
  // Handed to anyone who attaches later, so a view that opens halfway through
  // a reading starts reporting the reading's real position rather than zero.
  run.state = state;

  // Pick up where a previous reading left off. An interrupted walk - closed
  // tab, dropped connection, one failed capture - costs only the part it did
  // not finish, and a step that failed last time is tried again rather than
  // being remembered as permanently missing.
  const prev = await arRead(arManifestKey(url));
  if (prev && (prev.schema !== AR_SCHEMA || prev.signature !== sig)) {
    await arClearFor(url);
  } else if (prev) {
    for (let i = 0; i < n; i++) {
      if (prev.counts && prev.counts[i]) state.counts[i] = prev.counts[i];
      if (prev.tags && prev.tags[i]) state.tags[i] = prev.tags[i];
      if (prev.totals) state.totals[i] = prev.totals[i] || 0;
      if (prev.docs && prev.docs[i]) state.docs[i] = true;
    }
  }
  if (run.cancelled) return arResult(url, sig, state);

  // A step produces the page on its right, and therefore also counts the
  // changes leading into that page. Step 0 has nothing before it, so the
  // counts for the opening capture are always null and the opening page has to
  // be asked for as the older half of step 0.
  const queue = [];
  for (let p = 0; p < n - 1; p++) if (!state.counts[p + 1]) queue.push(p);

  if (queue.length) {
    let cursor = 0;
    let pending = [];

    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await arWrite(batch);
    };

    async function worker() {
      while (cursor < queue.length) {
        const p = queue[cursor++];
        if (run.cancelled) return;

        // Only the very first step needs its older page as well: every other
        // step's left-hand page is the previous step's right-hand page. Whether
        // that previous step actually delivered it is not knowable until it
        // finishes, which on a pipeline is often after this one is already in
        // flight. Waiting for it would hold the whole reading to one request at
        // a time to save half the bandwidth, which is a bad trade — the gaps
        // between steps are where the transfer and the storing happen. If a
        // step does fail, the page it owed is picked up afterwards instead.
        const data = await arStep(url, snaps, p, p === 0);

        if (data) {
          const to = p + 1;
          state.counts[to] = data.counts;
          state.tags[to] = data.tagCounts || {};
          state.totals[to] = data.counts.added + data.counts.removed + data.counts.changed;
          state.docs[to] = true;
          pending.push([arKey(url, snaps[to].timestamp), data.newHtml]);

          if (p === 0 && typeof data.oldHtml === 'string' && data.oldHtml.length) {
            state.docs[0] = true;
            pending.push([arKey(url, snaps[0].timestamp), data.oldHtml]);
          }
        } else {
          state.counts[p + 1] = null;
          state.docs[p + 1] = false;
        }

        state.done++;
        if (pending.length >= AR_BATCH) await flush();
        arProgress(state, p + 1, run);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(AR_CONCURRENCY, queue.length) }, worker)
    );
    await flush();
  }

  // Any page still missing at this point is a page a failed step owed us, and
  // the only way to know is to look. In the ordinary case there are none and
  // this costs nothing; when the Archive drops something, it is one cheap
  // request per hole rather than a page that silently never plays.
  const holes = [];
  for (let i = 0; i < n; i++) if (!state.docs[i]) holes.push(i);
  if (holes.length) {
    await Promise.all(holes.map(async (i) => {
      const html = await arCapture(url, snaps[i].timestamp);
      if (typeof html === 'string' && html.length) {
        state.docs[i] = true;
        await arWrite([[arKey(url, snaps[i].timestamp), html]]);
      }
    }));
  }

  // Written last, and read first, so a half-finished walk is never mistaken
  // for a whole one. `complete` is deliberately absent: the field is written
  // exactly once, by the code that is about to finish.
  await arWrite([[arManifestKey(url), {
    schema: AR_SCHEMA,
    signature: sig,
    count: n,
    counts: state.counts,
    tags: state.tags,
    totals: state.totals,
    docs: state.docs,
    savedAt: Date.now(),
  }]]);

  return arResult(url, sig, state);
}

function arResult(url, sig, state) {
  const complete = state.counts.slice(1).every(Boolean);
  return {
    url,
    signature: sig,
    count: state.snaps.length,
    complete,
    counts: state.counts,
    tags: state.tags,
    totals: state.totals,
    docs: state.docs,
  };
}

/** The record just read in this tab, or null if this is not it. */
function arCached(url, snaps) {
  if (arLast && arLast.url === url && arLast.sig === arSignature(url, snaps)) return arLast.result;
  return null;
}

/**
 * Read (or finish reading) the whole record for `snaps`, calling
 * `onProgress({ done, total, index, date, etaSeconds })` as it goes.
 *
 * Resolves with { counts, tags, totals, docs, complete } either way - a
 * capture the Archive will not produce is reported as missing, not thrown, so
 * that one hole in a twenty-seven-year history cannot cost you the other
 * seven hundred captures.
 */
function arEnsure(url, snaps, onProgress) {
  const sig = arSignature(url, snaps);

  if (arRun && arRun.url === url && arRun.sig === sig) {
    if (onProgress) {
      arRun.listeners.add(onProgress);
      if (arRun.state) onProgress(arMakeProgress(arRun.state, arRun.lastIndex ?? -1));
    }
    return arRun.promise;
  }

  const run = { url, sig, state: null, lastIndex: -1, listeners: new Set(onProgress ? [onProgress] : []) };
  arRun = run;
  run.promise = arWalk(url, snaps, run).then((result) => {
    arLast = { url, sig, result };
    return result;
  }).finally(() => {
    if (arRun === run) arRun = null;
  });

  return run.promise;
}

// Asking a walk in flight to stop. Only for the case where leaving it running
// would be pointless work - a different site was traced, so the record on
// screen is not the one being read.
function arCancelIfOther(url, sig) {
  if (arRun && (arRun.url !== url || arRun.sig !== sig)) arRun.cancelled = true;
}

// ---------------------------------------------------------------- reading

// Which revision of the server's capture pipeline produced the documents this
// build understands. Must match PREPARE_VERSION in lib/prepareCapture.js, which
// stamps every document it prepares with it.
//
// This is what makes the on-disk record self-healing. The pages here outlive
// the code that wrote them by weeks, and a document prepared by an older
// pipeline can render wrong in a way that still looks like a finished page -
// an unstyled capture with broken images is a plausible-looking page, not an
// error. Rather than trusting the store, every read checks the stamp and
// quietly replaces anything stale with the server's current copy.
//
// The refetch is a database read on the far side, not a trip to the Archive:
// the server has its own cache, so a stale record repairs itself at the cost of
// one small request per capture, and only for captures actually played.
const AR_CAPTURE_VERSION = 2;
const AR_CAPTURE_STAMP_RE = /<meta name="palimpsest-capture" content="(\d+)"/i;

// A stamp is not proof on its own. The number was reused once while the
// prepare pipeline changed underneath it, and every row written by the older
// pipeline kept passing this check — so the film could render a document the
// compare view no longer produces, silently, and the two readings of one
// record disagreed.
//
// So the shape is checked as well. lib/prepareCapture.js strips every script
// and noscript element, which means a current document has none; a document
// that still has one came from a build that did not. It is parsed rather than
// pattern-matched because commented-out script tags are common in archived
// pages and a comment is not an element — the older pipeline's regex was what
// broke those comments in the first place.
function arCaptureIsCurrent(html) {
  if (typeof html !== 'string' || !html) return false;
  const m = html.match(AR_CAPTURE_STAMP_RE);
  if (!m || Number(m[1]) !== AR_CAPTURE_VERSION) return false;
  if (/<script|<noscript/i.test(html)) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (doc.querySelector('script, noscript')) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

/**
 * One capture, ready to render — from the store when it is there and current,
 * and from the server when it is not.
 *
 * Never throws and never returns a rejected promise: a capture that cannot be
 * read at all resolves to undefined, which is the same signal the walk uses for
 * a capture the Archive does not have. Playback already knows how to show that.
 */
async function arDoc(url, ts) {
  const stored = await arRead(arKey(url, ts));
  if (arCaptureIsCurrent(stored)) return stored;

  const fresh = await arCapture(url, ts);
  if (typeof fresh === 'string' && fresh.length) {
    await arWrite([[arKey(url, ts), fresh]]);
    return fresh;
  }
  // The refetch failed. A stale page still beats no page — it is the wrong
  // document rather than a blank frame - so it is used as-is.
  return typeof stored === 'string' && stored.length ? stored : undefined;
}