// lib/sampleSnapshots.js
//
// What `/api/snapshots` actually sends for a record, and why it is not the
// record.
//
// nytimes.com has 436,339 captures on file. Sending them all is a 43MB JSON
// response the browser parses before it can draw anything - measured at 1.9
// seconds of database read on the server and several more in the page, every
// visit, for a slider that draws a few hundred ticks. So the response is a
// faithful *sample*, and this file is where the sampling rule lives, on its
// own, because getting it wrong is invisible until somebody tries to open a
// capture they can see in the record card.
//
// The rule, in two resolutions:
//
//   - the recent window (18 months) keeps every capture, thinned to one a DAY
//     when a record has more than the cap can hold - that is the part of a
//     history people compare ("what did it say last month");
//   - everything before it keeps one capture a MONTH, which is the resolution
//     the rail can show anyway, and which is what makes the whole history
//     reachable: April 2017 is a point you can pick, in a record whose April
//     2017 holds a thousand captures;
//   - the first and last captures are always here, because they are the ends
//     of the rail and the labels under it.
//
// What this replaced: "keep everything recent, then if the result is still
// over the cap, thin the whole sample evenly by index". On a record this size
// the recent window alone blew past the cap, and even thinning then divided
// the sample by index - hundreds of thousands of recent points against a few
// dozen older ones - so almost every historical month fell out of the list.
// The rail drew a gap where the history was, and a link to a capture the
// Archive really holds said the capture was no longer on the record.
//
// The two counters the page needs ride along: `total` is the real number of
// captures on file, and `thinned` says whether anything was left out.

const MAX_TIMELINE_POINTS = 6000;
const RECENT_WINDOW_MS = 18 * 30 * 24 * 60 * 60 * 1000;

// The sample is sent as {timestamp, date} only: `original` is the capture's
// own address, no client reads it, and on a record this size it is most of the
// bytes (the same long URL, repeated hundreds of thousands of times).
function slimSnapshot(s) {
  return { timestamp: s.timestamp, date: s.date };
}

function sampleSnapshots(snapshots, now = Date.now()) {
  if (!Array.isArray(snapshots)) return [];
  const total = snapshots.length;
  if (total <= MAX_TIMELINE_POINTS) return snapshots.map(slimSnapshot);
  const recentFrom = now - RECENT_WINDOW_MS;
  const out = [];
  const months = new Set();
  const days = new Set();
  for (let i = 0; i < total; i++) {
    const s = snapshots[i];
    const ts = String(s.timestamp || '');
    const when = Date.parse(s.date || '') || Number(ts.slice(0, 4)) * 31536000000;
    if (i === 0 || i === total - 1) {
      months.add(ts.slice(0, 6));
      days.add(ts.slice(0, 8));
      out.push(slimSnapshot(s));
      continue;
    }
    if (when >= recentFrom) {
      const day = ts.slice(0, 8);
      if (days.has(day)) continue;
      days.add(day);
      months.add(ts.slice(0, 6));
      out.push(slimSnapshot(s));
      continue;
    }
    const month = ts.slice(0, 6);
    if (months.has(month)) continue;
    months.add(month);
    out.push(slimSnapshot(s));
  }
  return out;
}

module.exports = { sampleSnapshots, slimSnapshot, MAX_TIMELINE_POINTS, RECENT_WINDOW_MS };
