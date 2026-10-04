// scripts/repair-archive-cache.js
//
// One-off repair, but kept in the repo because the same thing will be true
// again for anyone who ran an older build, and because the next person to hit
// "the film shows the wrong page" should find this rather than rediscover it.
//
// The bug: lib/fetchHtml.js used to cache whatever the Archive returned, which
// includes the Wayback playback bundle (bundle-playback.js, wombat.js) and any
// <script> tags the captured page had of its own. Nothing sanitised it on the
// way out. So every page already in snapshot_html was stored in a state that
// renders as something other than the capture it claims to be — Wombat rewrites
// the document as it loads — and with no base href, so its relative
// stylesheets resolved against this app and 404'd.
//
// fetchHtml.js now sanitises before caching, so new pages are correct. This
// rewrites the rows that are already there. The stored html is a cache of
// something reproducible, so rewriting it is safe; no user data is touched.
require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createClient } = require('@libsql/client');
const { prepareCapture } = require(path.join(ROOT, 'lib', 'prepareCapture'));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const APPLY = process.argv.includes('--apply');

(async () => {
  const res = await db.execute('SELECT cache_key, url, timestamp, html FROM snapshot_html');
  const rows = res.rows;
  console.log('rows: ' + rows.length + (APPLY ? '  (applying)' : '  (dry run — pass --apply to write)'));

  let changed = 0, scriptsLeft = 0, toolbarLeft = 0, baseAdded = 0;
  const fixes = [];

  for (const row of rows) {
    // cache_key is `${url}::${timestamp}` — the same shape fetchHtml builds.
    const [url, timestamp] = [row.url, row.timestamp];

    const clean = prepareCapture(row.html, { url, timestamp });
    if (clean === row.html) continue;

    changed++;
    if (/<script[\s>]/i.test(clean)) scriptsLeft++;
    if (/archive\.org\/_static/.test(clean)) toolbarLeft++;
    if (clean.includes('<base href') && !row.html.includes('<base href')) baseAdded++;
    fixes.push([clean, row.cache_key]);

    if (fixes.length <= 3) {
      console.log('  e.g. ' + row.cache_key + '  scripts ' +
        (row.html.match(/<script[\s>]/gi) || []).length + ' -> ' +
        (clean.match(/<script[\s>]/gi) || []).length);
    }
  }

  console.log('would change: ' + changed + ' of ' + rows.length);
  console.log('  scripts remaining after repair: ' + scriptsLeft);
  console.log('  toolbar assets remaining:        ' + toolbarLeft);
  console.log('  base hrefs added:               ' + baseAdded);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write these rows.');
    return;
  }

  // One statement per row: libSQL rejects a multi-statement batch (SQL_MANY_STATEMENTS),
  // and this is a one-off on a table this size, so the round trips are acceptable.
  // Restartable, because this is a long job over a remote database and the
  // network will eventually drop mid-run. A failure retries a few times, and
  // because the work is idempotent (a row already matching the target is not in
  // the list at all) it is always safe to just run the script again.
  let written = 0;
  for (let i = 0; i < fixes.length; i++) {
    const [html, key] = fixes[i];
    for (let attempt = 1; ; attempt++) {
      try {
        await db.execute({
          sql: 'UPDATE snapshot_html SET html = ? WHERE cache_key = ?',
          args: [html, key],
        });
        break;
      } catch (err) {
        if (attempt >= 4) {
          console.log('\ngave up on ' + key + ' after ' + attempt + ' attempts: ' + err.message);
          console.log('written ' + written + ' of ' + fixes.length + ' — run it again to finish.');
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
    written++;
    if (written % 50 === 0 || written === fixes.length) {
      process.stdout.write('\r  written: ' + written + '/' + fixes.length);
    }
  }
  console.log('\ndone');
})();