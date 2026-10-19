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
// Reading a record is two different jobs with two very different prices, and
// they are done separately because only one of them is slow.
//
// The pages come from this machine. The server holds every capture it has ever
// read, and it hands the whole record back in ONE response - a 741-capture
// history is one query and about three seconds, where asking for it a pair at a
// time was seven hundred and forty round trips and about a hundred seconds.
// A capture the server has never read has to come off the Archive, which hands
// out roughly one document a second through lib/rateLimiter.js, and that is the
// only genuinely slow part: about thirteen minutes for a 740-capture record the
// first time anyone reads it, for everyone rather than per visitor, because
// each document is kept in Turso forever under `${url}::${timestamp}`. Every
// reading after that costs no Archive request at all.
//
// The numbers - what changed between each capture and the one before it - are
// measured on the server, once per site, and written down. They cost about 66ms
// a pair to measure, so nobody waits on them: the pages are released to the
// view the moment they are all accounted for, and the rail fills in behind the
// film as the measurements land.
//
// Whichever view opens first starts the reading, and any other view that opens
// while it is still running attaches to that same reading instead of starting a
// second one. Visit the dashboard, wait through it once, and the timelapse
// opens instantly afterwards - and the other way round works too.
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
// created for anyone who had opened the app before the rename, every write and
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

// How many captures are asked for at once when the record has to come off the
// Archive. The server puts every Archive request behind one 1.1s gate no matter
// how many arrive, so this is not about going faster than the Archive allows -
// it is about keeping the pipe full during the gaps between those gated
// fetches, because a capture the Archive is sitting on must not hold up the six
// behind it.
const AR_HOLE_WIDE = 6;

// How many pages are asked for in one batch when the record is being filled in
// behind a film that is already playing. Small enough that the response is a
// few megabytes rather than thirty, and large enough that the round trips are
// not the cost.
const AR_DOC_CHUNK = 120;

// How many times one capture may be asked for before it is written off. Nearly
// every failure here is a timeout rather than a capture that will never exist,
// so one retry is worth it. An unbounded retry is not: a capture the Archive
// will never have would otherwise be re-requested on every visit.
const AR_MAX_ATTEMPTS = 2;

// Every request this file makes has a deadline, and that is the point of the
// numbers below. There was a version of this that did not: one fetch with no
// timeout, waiting on a server that had already stopped answering, left a
// progress card reading "retrieving capture 1 of 741" with nothing running
// behind it and no way out but closing the tab. A wait that cannot end is not a
// slow record, it is a broken one, and the fix is to make every wait end.
const AR_RECORD_TIMEOUT_MS = 240000;  // one response carrying the whole record
const AR_CAPTURE_TIMEOUT_MS = 90000;  // one capture, possibly off the Archive
const AR_POLL_TIMEOUT_MS = 20000;     // the numbers behind the rail, once a second
const AR_POLL_MS = 1500;
const AR_MANIFEST_TIMEOUT_MS = 8000;  // IndexedDB may never stall a reading

// How long a reading waits for a compile to finish before resolving with the
// numbers it has. The compile is about 66ms a pair, so this covers a record far
// longer than the Archive's own 2000-capture ceiling. It is a ceiling and not a
// wait: a compile that has already stopped is not polled once, and a compile
// that finishes the record ends the poll the moment it does.
const AR_COMPILE_WAIT_MS = 300000;

// How many captures may fail in a row, with nothing ever succeeding, before the
// reading decides it is not looking at a record but at a server that has stopped
// answering. Only the first few can fail for a real reason - a capture the
// Archive does not have is answered 'no', not left unanswered - so a dozen
// 'nothing' responses with no success anywhere is a broken connection.
const AR_BLIND_ATTEMPTS = 12;

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
    // What this reading is doing right now: pulling the record off this
    // machine ('record'), reading captures off the Archive ('captures'), or
    // waiting on the numbers behind the rail ('numbers'). A progress card can
    // only be honest if it knows which one it is reporting on.
    stage: state.stage || 'record',
    timestamp: index >= 0 ? state.snaps[index].timestamp : null,
    date: index >= 0 ? state.snaps[index].date : null,
    etaSeconds: eta,
    // The numbers measured so far, index-aligned with the capture list. They
    // arrive while a view is already playing, so they have to be readable from
    // the progress event itself - the rail builds itself out of these, and the
    // dashboard draws its charts from them long before the reading resolves.
    counts: state.stage === 'numbers' ? state.counts : null,
    totals: state.stage === 'numbers' ? state.totals : null,
    tags: state.stage === 'numbers' ? state.tags : null,
  };
}

function arProgress(state, index, run) {
  if (!run) return;
  run.lastIndex = index;
  arEmit(run, arMakeProgress(state, index));
}

// A request that is guaranteed to end. `fetch` will wait forever on a socket
// whose far end has stopped answering, and every wait in this file is built on
// this rather than on that hope.
async function arFetchJson(path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// A promise with a ceiling. Used for IndexedDB, which does not take an abort
// signal and can sit on a blocked transaction indefinitely - a version upgrade
// another tab is holding open, a disk that has stopped answering. Nothing here
// is required for the app to work, so a store that will not answer is a store
// this reading does without.
function arBound(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// One capture on its own: the page, either from the server's cache or straight
// off the Archive. This is the only way a page is ever fetched now, because a
// page and the numbers behind it are asked for on different schedules - the
// pages the moment the record is opened, the numbers as they are compiled.
async function arCapture(url, ts) {
  for (let attempt = 0; attempt < AR_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await arFetchJson(
        `/api/capture?url=${encodeURIComponent(url)}&ts=${encodeURIComponent(ts)}`,
        AR_CAPTURE_TIMEOUT_MS
      );
      if (typeof data.html !== 'string' || !data.html.length) throw new Error('Empty capture.');
      return data.html;
    } catch (_) {
      if (attempt + 1 < AR_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

// Emit in batches rather than one transaction per page: 741 documents is more
// transactions than it is data.
async function arWriteBatched(entries) {
  for (let i = 0; i < entries.length; i += AR_BATCH) {
    await arWrite(entries.slice(i, i + AR_BATCH));
  }
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
    stage: 'record',
    startedAt: Date.now(),
  };
  // Handed to anyone who attaches later, so a view that opens halfway through
  // a reading starts reporting the reading's real position rather than zero -
  // and announced immediately, before the first request goes out, so that a
  // card is never showing a number no walk is behind.
  run.state = state;
  arProgress(state, -1, run);

  // Pick up where a previous reading left off. An interrupted walk - closed
  // tab, dropped connection, one failed capture - costs only the part it did
  // not finish, and a page that could not be retrieved last time is tried again
  // rather than being remembered as permanently missing.
  const prev = await arBound(arRead(arManifestKey(url)), AR_MANIFEST_TIMEOUT_MS, undefined);
  if (prev && (prev.schema !== AR_SCHEMA || prev.signature !== sig)) {
    await arBound(arClearFor(url), AR_MANIFEST_TIMEOUT_MS, undefined);
  } else if (prev) {
    for (let i = 0; i < n; i++) {
      if (prev.counts && prev.counts[i]) state.counts[i] = prev.counts[i];
      if (prev.tags && prev.tags[i]) state.tags[i] = prev.tags[i];
      if (prev.totals) state.totals[i] = prev.totals[i] || 0;
      if (prev.docs && prev.docs[i]) state.docs[i] = true;
    }
  }
  if (run.cancelled) return arResult(url, sig, state);

  // Everything this record needs may already be on this machine, in which case
  // there is nothing to ask anyone and the film opens at once. That is the
  // whole point of storing it: the second visit is not a faster walk, it is no
  // walk.
  let answered = 0;
  for (let i = 0; i < n; i++) if (state.docs[i]) answered++;

  // ---- how much of this record is already here, and the numbers -------------
  // Asked for before anything is waited on, and it is a few kilobytes: the
  // numbers, plus how many captures this machine already holds for the address.
  // That one number decides which of two very different films is about to
  // happen, so it is worth a single small request to know.
  let held = 0;
  if (answered < n) {
    try {
      const brief = await arFetchJson(
        `/api/record?url=${encodeURIComponent(url)}&countsOnly=1`,
        AR_POLL_TIMEOUT_MS
      );
      held = Number(brief.captures) || 0;
      if (brief.counts) arApplyCounts(state, brief.counts);
    } catch (_) {
      // Not fatal: without an answer the pages are simply read the slow way.
    }
    if (run.cancelled) return arResult(url, sig, state);

    // Every capture of this record is already on this machine, so the film does
    // not wait for the documents. A page is a disk read away and the loader
    // already fetches each one before it is shown, so the film opens on the
    // numbers - kilobytes - and the pages arrive behind it, in the order it
    // will want them. That is the difference between a card that says
    // "retrieving capture 1 of 741" and a film that is already playing.
    if (held >= n) {
      state.docs.fill(true);          // answerable: on file here, and fetchable per frame
      arDocsReady(run, arResult(url, sig, state));
      await arStreamDocs(url, snaps, state, run);
      await arCollectCounts(url, snaps, state, run);
      await arWriteManifest(url, sig, state);
      return arResult(url, sig, state);
    }
  }

  // ---- the pages -----------------------------------------------------------
  // One request for every capture the server already holds. A record of 741
  // captures is about three seconds this way and about a hundred the other way,
  // and it is the same data either way.
  if (answered < n) {
    try {
      const data = await arFetchJson(`/api/record?url=${encodeURIComponent(url)}`, AR_RECORD_TIMEOUT_MS);
      const held = new Map();
      if (Array.isArray(data.rows)) {
        for (const row of data.rows) held.set(String(row[0]), row[1]);
      }
      const writes = [];
      for (let i = 0; i < n; i++) {
        if (state.docs[i]) continue;
        const html = held.get(snaps[i].timestamp);
        if (typeof html === 'string' && html.length) {
          state.docs[i] = true;
          answered++;
          writes.push([arKey(url, snaps[i].timestamp), html]);
        }
      }
      if (writes.length) await arWriteBatched(writes);

      // The numbers measured so far ride along with the pages, so a record that
      // has been read before arrives complete in one response.
      if (data.counts) arApplyCounts(state, data.counts);
    } catch (_) {
      // The whole-record request is the fast path, not the only path: whatever
      // it could not deliver is asked for capture by capture below.
    }
    if (run.cancelled) return arResult(url, sig, state);
  }

  // Anything still unanswered has to come off the Archive, one capture at a
  // time. This is the only genuinely slow part of reading a record - the
  // Archive hands out about a document a second - and it is why a record that
  // has never been read says how far along it is.
  const holes = [];
  for (let i = 0; i < n; i++) if (!state.docs[i]) holes.push(i);
  if (holes.length) {
    state.stage = 'captures';
    state.total = holes.length;
    state.done = 0;
    arProgress(state, -1, run);

    let cursor = 0;
    let asked = 0;
    let retrieved = 0;
    let blind = false;

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= holes.length || run.cancelled || blind) return;
        asked++;
        const html = await arCapture(url, state.snaps[holes[i]].timestamp);
        if (typeof html === 'string' && html.length) {
          retrieved++;
          state.docs[holes[i]] = true;
          await arWrite([[arKey(url, state.snaps[holes[i]].timestamp), html]]);
        } else if (!retrieved && asked >= AR_BLIND_ATTEMPTS) {
          // Twelve captures asked for and not one page back is not a record
          // with holes in it, it is a server that is not answering. Asking the
          // remaining seven hundred the same question would take hours and
          // teach nobody anything, so the reading stops and says so.
          blind = true;
          return;
        }
        state.done++;
        arProgress(state, holes[i], run);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AR_HOLE_WIDE, holes.length) }, worker));

    if (blind && !run.cancelled) {
      throw new Error('The server did not answer while the record was being read.');
    }
  }

  // Every frame has been answered - it is on disk, or it is a capture the
  // Archive does not have - so the film can open. The numbers behind its rail
  // are still being measured, and it does not wait for them: they fill in while
  // it plays, which is the same way the rail has always built itself.
  arDocsReady(run, arResult(url, sig, state));

  // ---- the numbers ---------------------------------------------------------
  await arCollectCounts(url, snaps, state, run);
  await arWriteManifest(url, sig, state);

  return arResult(url, sig, state);
}

// Written last, and read first, so a half-finished walk is never mistaken for a
// whole one.
async function arWriteManifest(url, sig, state) {
  await arBound(arWrite([[arManifestKey(url), {
    schema: AR_SCHEMA,
    signature: sig,
    count: state.snaps.length,
    counts: state.counts,
    tags: state.tags,
    totals: state.totals,
    docs: state.docs,
    savedAt: Date.now(),
  }]]), AR_MANIFEST_TIMEOUT_MS, undefined);
}

// The pages, pulled in behind a film that is already playing. Each batch is a
// slice of the record the server already holds, and each one is written to disk
// as it lands, so the frames just ahead of the playhead reach the store before
// the playhead does and the next opening of this record costs nothing at all.
//
// In order, deliberately: the film plays the record front to back, so filling it
// front to back means the pages arrive in the order they are wanted without the
// store having to guess. A batch that fails is not retried here - the frame
// fetches its own page when it is needed, and this is the pass that makes that
// rare.
async function arStreamDocs(url, snaps, state, run) {
  const n = snaps.length;
  const wanted = new Set(snaps.map((s) => s.timestamp));

  for (let from = 0; from < n; from += AR_DOC_CHUNK) {
    if (run.cancelled) return;
    let data;
    try {
      data = await arFetchJson(
        `/api/record?url=${encodeURIComponent(url)}&from=${from}&limit=${AR_DOC_CHUNK}`,
        AR_RECORD_TIMEOUT_MS
      );
    } catch (_) {
      return;   // the film plays from the server frame by frame instead
    }
    if (!Array.isArray(data.rows) || !data.rows.length) return;

    const writes = [];
    for (const row of data.rows) {
      const ts = String(row[0]);
      if (!wanted.has(ts)) continue;
      writes.push([arKey(url, ts), row[1]]);
    }
    if (writes.length) await arWriteBatched(writes);
    if (run.cancelled) return;
  }
}

// The counts a record response carried, keyed by capture timestamp. Only the
// pairs that have actually been measured appear, so this is how a partly
// compiled record still arrives mostly filled in.
function arApplyCounts(state, byTs) {
  const snaps = state.snaps;
  let applied = 0;
  for (let i = 1; i < snaps.length; i++) {
    if (state.counts[i]) { applied++; continue; }
    const step = byTs[snaps[i].timestamp];
    if (!step || !step.counts) continue;
    state.counts[i] = step.counts;
    state.tags[i] = step.tagCounts || {};
    state.totals[i] = typeof step.totals === 'number'
      ? step.totals
      : step.counts.added + step.counts.removed + step.counts.changed;
    applied++;
  }
  return applied;
}

// Waiting on the numbers. They are measured on the server, once per site, and
// written down; what is left here is asking how far along that is. A record
// whose numbers are already compiled answers on the first look and this returns
// immediately, and a record whose numbers cannot be compiled finishes with the
// holes the rail already draws honestly rather than polling for five minutes
// over work that is not happening.
//
// It gives up on a stopped compile straight away, on a ceiling of
// AR_COMPILE_WAIT_MS, and on the reading being cancelled - and in every one of
// those cases it resolves with what it has rather than failing, because a film
// that plays without its captions is worth more than a card that waits.
async function arCollectCounts(url, snaps, state, run) {
  const n = snaps.length;
  const missing = () => {
    let count = 0;
    for (let i = 1; i < n; i++) if (!state.counts[i]) count++;
    return count;
  };
  if (missing() === 0) return;

  const deadline = Date.now() + AR_COMPILE_WAIT_MS;
  state.stage = 'numbers';

  while (!run.cancelled && Date.now() < deadline) {
    let data;
    try {
      data = await arFetchJson(`/api/record?url=${encodeURIComponent(url)}&countsOnly=1`, AR_POLL_TIMEOUT_MS);
    } catch (_) {
      // A poll that fails is not a record that failed. Try again until the
      // ceiling; the pages are already on disk and the film is already playing.
      await new Promise((r) => setTimeout(r, AR_POLL_MS));
      continue;
    }

    arApplyCounts(state, data.counts || {});
    state.done = n - 1 - missing();
    state.total = n - 1;
    arProgress(state, run.lastIndex, run);

    if (missing() === 0) return;
    if (data.compile && data.compile.running === false) return;   // finished, or gave up
    await new Promise((r) => setTimeout(r, AR_POLL_MS));
  }
}

function arResult(url, sig, state) {
  return {
    url,
    signature: sig,
    count: state.snaps.length,
    // `complete` is about the numbers, which is what the dashboard draws. The
    // pages are a separate question with a separate answer: `docsComplete` says
    // every capture has been answered - it is on disk, or the Archive does not
    // have it - which is what the film needs before it can play.
    complete: state.counts.slice(1).every(Boolean),
    docsComplete: state.docs.every(Boolean),
    counts: state.counts,
    tags: state.tags,
    totals: state.totals,
    docs: state.docs,
  };
}

// The pages are on disk, so anything that wants to play this record can start
// now. Recorded on the run as well as fired, because the film may be opened
// while the dashboard is already reading the same record: the second caller
// gets the same answer instead of waiting for a walk it does not need.
function arDocsReady(run, result) {
  run.docsReady = true;
  run.docsResult = result;
  if (typeof run.onDocs !== 'function') return;
  try { run.onDocs(result); } catch (_) { /* a view's problem, not the record's */ }
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
function arEnsure(url, snaps, onProgress, onDocs) {
  const sig = arSignature(url, snaps);

  if (arRun && arRun.url === url && arRun.sig === sig) {
    if (onProgress) {
      arRun.listeners.add(onProgress);
      if (arRun.state) onProgress(arMakeProgress(arRun.state, arRun.lastIndex ?? -1));
    }
    if (onDocs) {
      // The pages may already be in hand from the reading this view is
      // attaching to; if they are, this is a callback and not a wait.
      if (arRun.docsReady) {
        try { onDocs(arRun.docsResult); } catch (_) {}
      } else {
        arRun.onDocs = onDocs;
      }
    }
    return arRun.promise;
  }

  const run = {
    url, sig, state: null, lastIndex: -1,
    listeners: new Set(onProgress ? [onProgress] : []),
    onDocs, docsReady: false, docsResult: null,
  };
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
// Kept in step with lib/prepareCapture.js by test/prepareVersion.test.js rather
// than by memory: the two disagreed once already, and the symptom was the film
// rendering documents the compare view no longer produced.
const AR_CAPTURE_VERSION = 9;
const AR_CAPTURE_STAMP_RE = /<meta name="palimpsest-capture" content="(\d+)"/i;

// A stamp is not proof on its own. The number was reused once while the
// prepare pipeline changed underneath it, and every row written by the older
// pipeline kept passing this check, so the film could render a document the
// compare view no longer produces, silently, and the two readings of one
// record disagreed.
//
// So the shape is checked as well. lib/prepareCapture.js strips every script
// and noscript element, which means a current document has none; a document
// that still has one came from a build that did not. It is parsed rather than
// pattern-matched because commented-out script tags are common in archived
// pages and a comment is not an element, the older pipeline's regex was what
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
 * One capture, ready to render, from the store when it is there and current,
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
  // The refetch failed. A stale page still beats no page, it is the wrong
  // document rather than a blank frame - so it is used as-is.
  return typeof stored === 'string' && stored.length ? stored : undefined;
}