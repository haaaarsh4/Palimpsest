// lib/rateLimiter.js
// The Internet Archive asks that automated clients keep requests to roughly
// one per second. Since many browser tabs could be hitting our backend at
// once, we fold every outgoing request to web.archive.org through this one
// queue so they're always spaced out, no matter how many users are active.
//
// Important: the "gate" that spaces requests out must never itself become a
// rejected promise, or every request queued after one failure would fail
// too, forever, for the lifetime of the server. So the gate only ever waits
// on a timer (which can't throw); the actual task's success or failure is
// handled separately per caller and never fed back into the shared chain.

const MIN_GAP_MS = 1100;

let chain = Promise.resolve();
let lastRunAt = 0;

function schedule(task) {
  const gate = chain.then(async () => {
    const wait = Math.max(0, lastRunAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRunAt = Date.now();
  });
  chain = gate;
  return gate.then(task);
}

module.exports = { schedule };
