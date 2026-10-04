// lib/rateLimiter.js
// The Internet Archive asks that automated clients keep requests to roughly
// one per second. Since many browser tabs could be hitting our backend at
// once, we fold every outgoing request to web.archive.org through this one
// queue so they're always spaced out, no matter how many users are active.
//
// ## Why there are two queues
//
// Reading a site's whole history is a long job: one request per capture, every
// one of them paced, so a 740-capture record is over thirteen minutes of
// queued work. That was harmless while only short jobs existed. It stopped
// being harmless when that work became possible, because all of it sat on ONE
// chain and a compare view queued behind it waited for every step of it. A
// person dragging the timeline got a white pane for thirteen minutes, through
// no fault of the page they asked for.
//
// So there are two queues. The interactive one holds what a person is watching
// a spinner for right now — a snapshot list, a single diff. The bulk one holds
// the record walk. Whatever is dequeued, the interactive queue is always
// preferred, and that preference is re-checked after the wait rather than
// before it, so a request that arrives while we are sleeping still goes first.
//
// The guarantee that matters is unchanged, and is the reason this file exists:
// no two requests are STARTED closer together than MIN_GAP_MS, however many are
// waiting and whichever lane they came from. What changed is that a response is
// no longer waited for before the next request goes out. Spacing starts is the
// polite rate; spacing completions made every lane as slow as the slowest page
// the Archive was sitting on, which is how one film frame ended up taking a
// minute while its neighbours took a second.
//
// ## Why there is exactly one drain loop
//
// Because that guarantee is enforced by a single loop stepping through the
// queues in order, there must never be two of them. The flag below is set
// SYNCHRONOUSLY, at enqueue time, not when the loop starts: setTimeout and
// setImmediate both run on a later tick, so a check made inside the loop would
// still read "idle" for every one of a burst of enqueues and would start one
// loop per call. Those loops then each dequeue independently, which is how you
// get five requests in flight and a measured gap of zero — the exact behaviour
// the Archive asked us not to cause. Set the flag before yielding and the
// guarantee holds.
//
// The "gate" that spaces requests out must never itself become a rejected
// promise, or every request queued after one failure would fail too, forever,
// for the lifetime of the server. So the gate only ever waits on a timer
// (which can't throw); the actual task's success or failure is settled per
// caller and never fed back into the queue.

const MIN_GAP_MS = 1100;

// How many requests may be waiting on the Archive at once. The spacing below is
// what the Archive asks for, and it is a rule about how closely two requests are
// STARTED, not about how long they take. Awaiting each response before starting
// the next one made every wait in the system as long as the slowest response: a
// single capture that the Archive sat on for thirty seconds held the whole
// queue, so a person's one page waited behind it. That is what made one frame
// of the film take a minute while the next took a second. This cap is only here
// so a slow Archive cannot leave hundreds of sockets open; six overlapping
// responses still means requests leave at the polite rate below.
const MAX_IN_FLIGHT = 6;

let lastRunAt = 0;

// True from the moment a request is enqueued until the queues are empty. Set
// synchronously in schedule() — see the note above.
let draining = false;

let inFlight = 0;
let slotWaiters = [];

function releaseSlot() {
  inFlight--;
  const next = slotWaiters.shift();
  if (next) next();
}

function waitForSlot() {
  if (inFlight < MAX_IN_FLIGHT) return Promise.resolve();
  return new Promise((resolve) => slotWaiters.push(resolve));
}

const interactiveQueue = [];
const bulkQueue = [];

function nextTask() {
  if (interactiveQueue.length) return interactiveQueue.shift();
  return bulkQueue.shift() || null;
}

async function drain() {
  try {
    for (;;) {
      const queued = nextTask();
      if (!queued) break;

      await waitForSlot();

      const wait = Math.max(0, lastRunAt + MIN_GAP_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      // Picked again after the sleep: anything interactive that arrived during
      // it should not wait for this one to run as well. It goes back to the
      // head of its own lane, so ordering within a lane stays FIFO for
      // everything queued after it.
      let job = queued;
      if (!queued.interactive && interactiveQueue.length) {
        job = interactiveQueue.shift();
        bulkQueue.unshift(queued);
      }

      lastRunAt = Date.now();
      inFlight++;

      // Started, not awaited. One failed capture must not reject the gate, or
      // every request queued behind it would fail too: the caller gets its own
      // error and the loop moves on, which is why the outcome is settled on the
      // job rather than thrown back into the queue.
      job.run().then(job.resolve, (err) => job.reject(err)).finally(releaseSlot);
    }
  } finally {
    draining = false;
    // A request that arrived during the final await above must not be stranded.
    // Anything still queued also means we are about to start the loop again,
    // and the flag has to be back up before yielding to avoid a second loop.
    if (interactiveQueue.length || bulkQueue.length) {
      draining = true;
      setImmediate(drain);
    }
  }
}

/**
 * Queue one request to the Archive.
 *
 * `opts.interactive` marks a request a person is waiting on. Bulk work yields
 * to those; without the distinction a thirteen-minute record walk silently
 * becomes a thirteen-minute compare view.
 */
function schedule(task, opts = {}) {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

  const job = {
    run: task,
    interactive: !!opts.interactive,
    resolve,
    reject,
  };

  (job.interactive ? interactiveQueue : bulkQueue).push(job);

  if (!draining) {
    draining = true;              // synchronous, before any yield
    setImmediate(drain);
  }

  return promise;
}

module.exports = { schedule };