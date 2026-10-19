// scripts/check-compare-clicks.js
//
// The comparison is only as good as what happens when a row is picked: the
// snapshot has to scroll to the change and mark it, on both sides, whatever
// the archived page does with its own layout. That is a browser behaviour, so
// it is checked in a real browser against real archive data - the unit tests
// next to it only guard the shape of the code that does the work.
//
// This walks a comparison and judges every picked row the way a reader would:
//
//   - something the app marked is on screen in the pane (the change itself,
//     or the container that holds it when the archive never painted the exact
//     node - a broken image, a zero-width rail link);
//   - the marked node is on screen too whenever it has a readable box;
//   - a snapshot the stage folded away for this change - the change is laid
//     out in one of the page's own orientations, and the pane holding it took
//     the stage so the page could paint it - is a FOLDED outcome, not a miss;
//     the other snapshot is the one the row is about, and it is judged as
//     usual. A click changes only two things in a snapshot: how wide its pane
//     is, and whether a container the page itself hides (a dropdown, an
//     accordion) is open so the change inside it can be marked. The mark has
//     to be on the change itself whenever the page paints it.
//
// Usage:
//   node scripts/check-compare-clicks.js --url apple.com \
//     --from 20150128193043 --to 20261017060811 [--rows 30] [--step 5]
//   node scripts/check-compare-clicks.js --pair 'url=...&from=...&to=...'
//
// The app must be running (npm start) and reachable at --base
// (default http://localhost:3000). Playwright is optional: it is only the
// browser driver, and when it is missing this prints how to add it and exits
// without a verdict rather than failing the check.
//
// Exits 0 when every sampled row lands, 1 when any row does not, 2 when the
// check could not run (no browser, no server, no rows).

const path = require('node:path');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const v = process.argv[at + 1];
  return v == null || v.startsWith('--') ? true : v;
}

const base = String(arg('base', 'http://localhost:3000')).replace(/\/$/, '');
const rows = Number(arg('rows', 30));
const step = Number(arg('step', 0));
const pair = arg('pair', null);
const url = arg('url', null);
const from = arg('from', null);
const to = arg('to', null);

let playwright = null;
try {
  playwright = require('playwright');
} catch (_) {
  try { playwright = require(path.join(process.cwd(), 'node_modules', 'playwright')); } catch (__) { playwright = null; }
}
if (!playwright) {
  console.log('check-compare-clicks: playwright is not installed, so the click check cannot run.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  console.log('(the depth checks in `npm test` cover the logic; this one covers the pixels)');
  process.exit(2);
}

const query = typeof pair === 'string' ? pair.replace(/^#/, '')
  : (url && from && to ? `url=${url}&from=${from}&to=${to}` : null);
if (!query) {
  console.log('check-compare-clicks: give a comparison, e.g.');
  console.log('  --url apple.com --from 20150128193043 --to 20261017060811');
  console.log('  --pair "url=apple.com&from=20150128193043&to=20261017060811"');
  process.exit(2);
}

(async () => {
  const { chromium } = playwright;
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log('check-compare-clicks: could not start a browser: ' + String(e).slice(0, 200));
    console.log('  npx playwright install chromium');
    process.exit(2);
  }
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  try {
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!res || !res.ok) throw new Error(`no app answering at ${base} (start it with npm start)`);
  } catch (e) {
    console.log('check-compare-clicks: ' + e.message);
    await browser.close();
    process.exit(2);
  }

  await page.goto(base + '/compare#' + query, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => {
      const list = document.getElementById('changesList');
      return list && list.children.length > 0;
    }, null, { timeout: 240000 });
  } catch (_) {
    console.log('check-compare-clicks: the comparison never produced a changes list (server or archive problem?)');
    await browser.close();
    process.exit(2);
  }

  // Let the snapshots finish arriving before the first pick, the way a reader
  // does: a click during the pane's first parse is measured against a page
  // with no layout yet, and a check that reports it would be judging the
  // archive's load time rather than the selection.
  await page.waitForFunction(() => {
    const ready = (id) => {
      const f = document.getElementById(id);
      const d = f && f.contentDocument;
      return !!(d && d.body && d.body.children.length && d.readyState !== 'loading');
    };
    return ready('paneOld') && ready('paneNew');
  }, null, { timeout: 120000 }).catch(() => { /* one pane may never settle: judge what is there */ });
  await page.waitForTimeout(1500);

  const total = await page.evaluate(() => document.getElementById('changesList').children.length);
  const useStep = step > 0 ? step : Math.max(1, Math.floor(total / rows));
  const indices = [];
  const at = arg('at', null);
  if (typeof at === 'string') {
    // A specific row or rows, for chasing one that misbehaved: --at 99,140
    for (const n of at.split(',').map(Number)) {
      if (Number.isFinite(n) && n >= 0 && n < total) indices.push(n);
    }
  } else {
    for (let i = 0; i < total && indices.length < rows; i += useStep) indices.push(i);
  }

  console.log(`checking ${indices.length} of ${total} changes on ${base} (every ${useStep})`);
  const failures = [];
  for (const i of indices) {
    const info = await page.evaluate(async (i) => {
      const li = document.getElementById('changesList').children[i];
      const text = li ? li.innerText.replace(/\s+/g, ' ').slice(0, 50) : '?';
      const c = state.currentDiff.changes[i];
      li.click();
      const read = () => {
        const out = { sides: {} };
        // The stage's own classes are the arrangement: a snapshot the row
        // folded away is off screen by design, and nothing in it is judged.
        const stage = document.getElementById('viewerPanes');
        const folded = {
          old: !!(stage && stage.classList.contains('hide-old')),
          new: !!(stage && stage.classList.contains('hide-new')),
        };
        for (const side of ['old', 'new']) {
          const id = side === 'old' ? c.oldId : c.newId;
          if (!id) { out.sides[side] = { skip: true }; continue; }
          if (folded[side]) { out.sides[side] = { folded: true }; continue; }
          const iframe = document.getElementById(side === 'old' ? 'paneOld' : 'paneNew');
          const doc = iframe.contentDocument;
          const win = iframe.contentWindow;
          if (!doc) { out.sides[side] = { none: true }; continue; }
          const vw = win.innerWidth;
          const vh = win.innerHeight;
          const marked = doc.querySelector(`[data-pdiff-id="${id}"]`);
          const lits = Array.from(doc.querySelectorAll('.pdiff-selected'));
          const wantText = String(side === 'old' ? c.before : c.after || '').replace(/\s+/g, ' ').trim();
          let textPresent = false;
          try {
            const paneText = (doc.body && doc.body.innerText ? doc.body.innerText : '').replace(/\s+/g, ' ');
            textPresent = wantText.length >= 8 && paneText.indexOf(wantText) >= 0;
          } catch (_) { textPresent = false; }
          const fileOf = (u) => {
            try {
              const s = String(u || '').split('?')[0].split('#')[0];
              return decodeURIComponent(s.split('/').filter(Boolean).pop() || '');
            } catch (_) { return ''; }
          };
          const attr = (name) => {
            const bag = side === 'old' ? c.attrsBefore : c.attrsAfter;
            if (bag && bag[name] != null) return bag[name];
            const found = (c.attrChanges || []).find((a) => a.name === name);
            return found ? (side === 'old' ? found.before : found.after) : '';
          };
          const wantFile = fileOf(attr('src')) || fileOf(attr('poster'));
          let filePresent = false;
          if (wantFile) {
            try {
              filePresent = Array.from(doc.querySelectorAll('img, source, video, [style*="url("]')).some((n) => {
                const raw = n.getAttribute && (n.getAttribute('src') || n.getAttribute('srcset') || '');
                const style = n.getAttribute && (n.getAttribute('style') || '');
                return fileOf(raw) === wantFile || (style || '').indexOf(wantFile) >= 0;
              });
            } catch (_) { filePresent = false; }
          }
          const rect = (n) => {
            if (!n) return null;
            const r = n.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left),
              inView: r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0 };
          };
          // Does this pane PAINT the marked node at all? A node can be in the
          // document and painted nowhere: an ancestor is display: none or
          // visibility: hidden (a nav that only exists in the wide layout, a
          // drawer that only exists in the narrow one), or it has no box of
          // its own. That is the case a fold answers, and the check has to be
          // able to tell it apart from a mark with a real box that no light
          // was placed on.
          const painted = (n) => {
            if (!n) return false;
            try {
              if (!n.getClientRects().length) return false;
              let m = n;
              for (let k = 0; m && m.nodeType === 1 && k < 40; m = m.parentElement, k++) {
                const cs = win.getComputedStyle(m);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
                if (Number(cs.opacity) === 0) return false;
                if (m === doc.body) break;
              }
              const r = n.getBoundingClientRect();
              return r.width >= 2 && r.height >= 2;
            } catch (_) { return false; }
          };
          // Is there a PAINTED copy of the change elsewhere in the pane? If
          // the same link or picture is on screen somewhere in this snapshot,
          // the click has to have gone there and lit it: landing on nothing
          // while a copy of the change is on screen is a miss, whatever the
          // page does with its layout. Matched on tag plus the words or the
          // file the change is about - the same identity
          // findVisibleEquivalent uses - so text that merely happens to
          // appear in a footer does not confuse it.
          const visibleTwin = (() => {
            if (!wantText && !wantFile) return false;
            const tag = String(c.tag || '').toLowerCase();
            // A duplicated element (the same link shipped in a desktop bar and
            // in a phone drawer) is a different change in each container, and
            // the app routes each row to its own copy (twinAccepts). A footer
            // that happens to say "Ask a Question" is not the change this row
            // names, so it must not be counted as a copy the click missed.
            const sameChange = (n) => {
              if (!c.duplicate) return true;
              try {
                if (typeof PdiffSelection === 'undefined' || !PdiffSelection.twinAccepts) return true;
                return PdiffSelection.twinAccepts(c.path, PdiffSelection.livePathOf(n), true);
              } catch (_) { return true; }
            };
            const cands = Array.from(doc.querySelectorAll('[data-pdiff-id]'));
            return cands.some((n) => {
              if (n === marked) return false;
              if (!sameChange(n)) return false;
              if (String(n.tagName || '').toLowerCase() !== tag) return false;
              if (wantFile) {
                const f = fileOf(n.getAttribute('src') || n.getAttribute('poster') || '');
                if (f !== wantFile) return false;
              } else {
                const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
                if (t !== wantText) return false;
              }
              return painted(n);
            });
          })();
          // A change the page never paints - leftover hidden markup with no
          // rule that ever shows it at any width - is left exactly as the
          // Archive recorded it. Nothing is forced open and nothing is lit,
          // by design; that is a settled answer, not a miss.
          let neverShows = false;
          try {
            const p = revealPlanFor(iframe, c, side);
            neverShows = !!(p && p.neverShows);
          } catch (_) { neverShows = false; }
          out.sides[side] = {
            vw,
            vh,
            marked: rect(marked),
            neverShows,
            visibleTwin,
            // Why a side came back with no light at all, so the failure says
            // which of the two it is: the mark itself is gone (the page
            // rewrote the subtree, or the pane never painted), or the mark is
            // there and no light was placed on it. Both used to read as the
            // same sentence, and they are opposite bugs.
            markPresent: !!marked,
            markPainted: painted(marked),
            textPresent,
            filePresent,
            paneReady: doc.readyState || '',
            lit: lits.length ? { tag: lits[0].tagName, ...rect(lits[0]),
              isMarked: lits[0] === marked, holds: marked ? lits[0].contains(marked) : false } : null,
            litInView: lits.some((n) => { const r = rect(n); return r && r.inView; }),
          };
        }
        return out;
      };
      // A side the stage has folded away is settled by definition: there is
      // nothing to wait for in a snapshot that is off screen, and polling it
      // for the full thirty seconds is how a sweep of forty rows took twenty
      // minutes.
      const settledSide = (s) => !!(s.folded || s.neverShows);
      let out = read();
      for (let k = 0; k < 60; k++) {
        const bad = ['old', 'new'].some((side) => {
          const s = out.sides[side];
          if (!s || s.skip || settledSide(s)) return false;
          if (!s.lit || !s.litInView) return true;
          if (s.lit.isMarked || s.lit.holds) return false;
          return !!(s.marked && s.marked.w && s.marked.h && s.marked.inView);
        });
        if (!bad) break;
        await new Promise((r) => setTimeout(r, 500));
        out = read();
      }
      // The archived page is often still arriving when the last look happens,
      // and a snapshot caught mid-reflow reads worse than the one the reader
      // ends up with. One more look after the page has had a beat decides it.
      await new Promise((r) => setTimeout(r, 1200));
      out = read();
      return { i, text, type: c.type, ...out };
    }, i);

    const bad = [];
    const explain = [];
    for (const side of ['old', 'new']) {
      const s = info.sides[side];
      if (!s || s.skip) continue;
      // Folded away for this change: the snapshot the change is laid out in is
      // the one on the stage, and the page painted it there by itself.
      if (s.folded) { explain.push(side + ': folded away for this change'); continue; }
      if (s.none) { bad.push(side + ':no document'); continue; }
      if (!s.lit && s.neverShows) {
        explain.push(side + ': never painted by the page, so nothing was forced open');
        continue;
      }
      if (!s.lit) {
        const why = s.markPainted ? 'the mark is painted in the pane and no light was placed on it'
          : (s.markPresent ? 'the mark is in the pane and nothing on screen was marked for it'
            : (s.paneReady !== 'complete' ? `the pane was still ${s.paneReady}` : 'the mark is gone from the pane'));
        bad.push(side + ':nothing marked (' + why + ')');
        continue;
      }
      if (!s.litInView) {
        // Both axes, in the pane's own pixels: a light can miss vertically
        // (below the fold, the case this message was written for) or
        // horizontally (an element inside a strip wider than the pane), and
        // the two need opposite corrections. A vertical-only reading sent
        // one investigation looking at a light that was 210px down in a
        // 697px frame - on screen - while its left edge sat past the right
        // of the pane.
        const at = 'at x' + s.lit.left + ' y' + s.lit.top + ' in ' + s.vw + '\u00d7' + s.vh;
        bad.push(side + ':the mark is off screen (' + at + ', ' + s.lit.w + '\u00d7' + s.lit.h + ')' +
          (s.marked ? ' [change at x' + s.marked.left + ' y' + s.marked.top + ', ' + s.marked.w + '\u00d7' + s.marked.h + ']' : ''));
        continue;
      }
      if (!s.lit.isMarked && !s.lit.holds && s.marked && s.marked.w && s.marked.h && s.marked.inView) {
        bad.push(side + ':marked ' + s.lit.tag + ' instead of the change');
      }
    }
    const label = `${i} [${info.type}] ${info.text}`;
    if (bad.length) {
      failures.push({ label, bad });
      console.log('FAIL ' + label + '  ' + bad.join(', '));
    } else {
      console.log('ok   ' + label + (explain.length ? '  (' + explain.join('; ') + ')' : ''));
    }
  }

  await browser.close();
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 3).join(' | '));
  console.log(`\n${indices.length - failures.length}/${indices.length} picked rows landed on the change` +
    (failures.length ? `; ${failures.length} did not` : ''));
  process.exit(failures.length ? 1 : 0);
})();
