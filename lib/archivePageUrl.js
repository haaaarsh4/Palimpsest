// lib/archivePageUrl.js
//
// A pane showing a followed link holds a full Wayback playback address:
//
//   https://web.archive.org/web/20151124141511/http://settlement.org/ontario/...
//
// "Compare these open pages" has to re-read exactly those two addresses.
// This turns one such address back into the (inner URL, timestamp) pair the
// capture pipeline (fetchArchivedHtml + prepareCapture) already speaks, and
// refuses anything that is not an archived page, a pane can wander onto the
// live web too, and this endpoint must never become a fetcher for an
// arbitrary server.

const WAYBACK_PAGE_RE = /^\/web\/(\d{14})[a-z_]*\/(.+)$/i;

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The { url, timestamp } pair behind an archived page address.
function parseArchivePageUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) throw bad('Give both panes an address to compare.');
  let outer;
  try {
    outer = new URL(raw);
  } catch (_) {
    throw bad(`That is not an address this can compare: ${raw.slice(0, 80)}`);
  }
  if (!/^https?:$/.test(outer.protocol)) {
    throw bad('Only archived pages can be compared, that address is not one.');
  }
  if (outer.hostname.toLowerCase() !== 'web.archive.org') {
    throw bad(
      'Only archived pages can be compared. ' +
        'That pane is showing the live web (or somewhere else entirely), ' +
        'go back to an archived page first.'
    );
  }
  const m = WAYBACK_PAGE_RE.exec(outer.pathname);
  if (!m) {
    throw bad(
      'That address is on the archive but is not a page capture ' +
        '(no /web/<timestamp>/ address), go back to an archived page first.'
    );
  }
  const timestamp = m[1];
  let inner = null;
  try {
    inner = decodeURIComponent(m[2]);
  } catch (_) {
    inner = m[2];
  }
  // The archive kept the captured address verbatim after the timestamp,
  // query and fragment included; the outer parse hands those back as the
  // outer URL's, so they are reattached here exactly.
  inner += outer.search + outer.hash;
  let parsed;
  try {
    parsed = new URL(inner);
  } catch (_) {
    throw bad(
      'That capture address is relative to the page it was stored from, ' +
        'so it cannot be re-read on its own. Open the page itself first.'
    );
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw bad('Only archived pages can be compared, that address is not one.');
  }
  return { url: parsed.href, timestamp };
}

module.exports = { parseArchivePageUrl };
