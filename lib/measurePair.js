// lib/measurePair.js
//
// One comparison, measured the same way everywhere it is measured.
//
// /api/diff (the compare view), /api/record-step (one dashboard/film step)
// and the record compile (every step, in the background) used to each run
// their own version of this: the compare view diffed, then promoted silent
// image changes and demoted proven-no-op resizes, while the record paths
// ran the bare diff and called it a number. Any pair with a redesigned logo
// under an unchanged filename, or a width/height-only change that renders
// identically, then counted differently in the dashboard than in the changes
// list beside the panes, and the dashboard is supposed to be the same
// record, not a second opinion.
//
// So every path comes through here: the full diff, then the same two image
// passes, with the same timestamps. The callers only differ in what they
// keep: the compare view keeps the documents and the change entries, the
// record paths keep the numbers.

const { diffSnapshots } = require('./diffEngine');
const { promoteSilentImageChanges, demoteNoopImageResizes } = require('./imageBytes');

// The byte passes are bounded by a wall-clock budget (see lib/imageBytes.js):
// they are what made one comparison take fifteen seconds, and the panes are
// waiting on this function before they get a document at all. `budgetMs` is
// passed through so a caller with a slower clock - the record walk, which
// nobody is watching - can give them longer.
async function measurePair(oldHtml, newHtml, { tsFrom, tsTo, budgetMs } = {}) {
  const started = Date.now();
  const result = diffSnapshots(oldHtml, newHtml, {});
  // Same address, different pixels: the attribute diff cannot see it, so
  // the bytes are compared and silent pairs are promoted to changes.
  await promoteSilentImageChanges(result, { tsFrom, tsTo, budgetMs });
  // Same file, declared size added later, renders identically: proven
  // no-ops are demoted so they never reach the changes list. The two passes
  // share one budget between them (the demotion gets what is left, never
  // less than a third of it), so a page that spends the whole allowance
  // promoting cannot then spend it again demoting.
  const spent = Date.now() - started;
  const left = budgetMs === undefined ? undefined : Math.max(800, budgetMs - spent);
  await demoteNoopImageResizes(result, { tsFrom, tsTo, budgetMs: left });
  return result;
}

// The record walk never draws the change list, it only groups it: counts
// and the per-tag breakdown, in the shape record_steps stores.
function stepNumbers(result) {
  const tagCounts = {};
  (result.changes || []).forEach((c) => {
    tagCounts[c.tag] = (tagCounts[c.tag] || 0) + 1;
  });
  const counts = result.counts || { added: 0, removed: 0, changed: 0 };
  return {
    counts,
    tagCounts,
    totals: (counts.added || 0) + (counts.removed || 0) + (counts.changed || 0),
  };
}

module.exports = { measurePair, stepNumbers };
