const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// These tests load the real page markup plus the real page script in jsdom
// and press the real submit button, with fetch stubbed. They fail when a
// submit never reaches the backend (the frozen-page bug: a pause flag that
// silently drops the press, no request, no progress, no error), because
// every assertion below is about observable effects of that request.

function stubResponses(routes) {
  const calls = [];
  const fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, data] of routes) {
      if (url.startsWith(prefix)) {
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { calls, fetch };
}

function loadPageWithScript(htmlFile, jsFile, { url, fetch } = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', htmlFile), 'utf8');
  // Strip the page's own <script src> tags and run the file under test as an
  // inline script instead: window.eval does not wire the window globals
  // (bare `document` is undefined there), while a parsed <script> runs with
  // the real page globals. beforeParse installs the fetch stub first, so the
  // page wiring that runs at parse time already sees it.
  const bare = html.replace(/<script[^>]*src="[^"]*"[^>]*>\s*<\/script>/g, '');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', jsFile), 'utf8');
  if (/<\/script/i.test(src) || /<!--/.test(src)) {
    throw new Error(`${jsFile} cannot be inlined into the test page`);
  }
  const withInline = bare.replace('</body>', `<script>${src}</script></body>`);
  return new JSDOM(withInline, {
    url: url || 'http://localhost:3000/',
    runScripts: 'dangerously',
    beforeParse(window) {
      if (fetch) window.fetch = fetch;
    },
  });
}

async function waitFor(cond, label) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TWO_SNAPS = {
  snapshots: [{ timestamp: '20200101000000' }, { timestamp: '20210101000000' }],
};

function emptyReport() {
  return {
    report: {
      coverage: {
        captures: 2,
        analyzedTimestamps: ['20200101000000', '20210101000000'],
        first: '20200101000000',
        last: '20210101000000',
        spanDays: 366,
      },
      summary: {
        threads: 0, erased: 0, softened: 0, live: 0, index: 0,
        band: 'Quiet', specificErasures: 0, clusters: 0,
        quantified: 0, withDeadline: 0, confidence: 'low',
      },
      categories: [], clusters: [], deadlineBuckets: [], survival: [], threads: [],
      url: 'example.com',
    },
  };
}

describe('claims page submit', () => {
  it('pressing Read its claims reaches the backend and shows progress', async () => {
    const { calls, fetch } = stubResponses([
      ['/api/snapshots', TWO_SNAPS],
      ['/api/claims', emptyReport()],
    ]);
    const dom = loadPageWithScript('claims.html', 'claims.js', {
      url: 'http://localhost:3000/claims',
      fetch,
    });
    const doc = dom.window.document;
    doc.getElementById('cwInput').value = 'example.com';
    doc.getElementById('cwForm').dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );
    // The sync half of the submit paints progress before the first await.
    assert.equal(
      doc.getElementById('cwProgress').hidden, false,
      'submitting must unhide the progress card instead of sitting silent'
    );
    await waitFor(() => calls.some((u) => u.startsWith('/api/snapshots')), 'snapshots request');
    await waitFor(() => calls.some((u) => u.startsWith('/api/claims')), 'claims analysis request');
    await waitFor(
      () => doc.getElementById('cwEmpty').hidden === false,
      'empty-result state'
    );
    assert.equal(doc.getElementById('cwProgress').hidden, true);
    assert.match(doc.getElementById('cwEmptyText').textContent, /2 captures/);
  });

  it('a backend failure surfaces as an error, not silence', async () => {
    const failing = async () => ({ ok: false, status: 502, json: async () => ({ error: 'boom' }) });
    const dom = loadPageWithScript('claims.html', 'claims.js', {
      url: 'http://localhost:3000/claims',
      fetch: failing,
    });
    const doc = dom.window.document;
    doc.getElementById('cwInput').value = 'example.com';
    doc.getElementById('cwForm').dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => doc.getElementById('cwError').hidden === false, 'error text');
    assert.match(doc.getElementById('cwError').textContent, /boom|Could not/);
  });
});

describe('settlement page submit', () => {
  it('answers the press instead of ignoring it', () => {
    const dom = loadPageWithScript('settlement.html', 'settlement.js', {
      url: 'http://localhost:3000/settlement',
    });
    const doc = dom.window.document;
    doc.getElementById('srInput').value = 'settlement.org';
    doc.getElementById('srForm').dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );
    const note = doc.getElementById('srNote');
    assert.ok(note, 'expected a status element for the settlement form');
    assert.equal(note.hidden, false, 'submitting must show a notice instead of doing nothing');
    assert.match(note.textContent, /not built yet/i);
  });
});
