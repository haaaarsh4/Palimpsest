// public/app.js
// No framework here on purpose — this is a focused enough UI that vanilla
// DOM code stays readable, and it keeps the whole app to one dependency-free
// static bundle.

const state = {
  url: null,
  snapshots: [],       // [{timestamp, original, date}] ascending by date
  fromIndex: null,
  toIndex: null,
  currentDiff: null,   // { oldHtml, newHtml, changes, counts }
  viewMode: 'side',     // 'side' | 'overlay'
  notesTimer: null,
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- URL form
el('urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = el('urlInput').value.trim();
  if (!raw) return;
  await loadSite(raw);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const url = chip.dataset.url;
    el('urlInput').value = url;
    await loadSite(url);
  });
});

async function loadSite(raw) {
  setError(null);
  el('timelineSection').hidden = true;
  el('workspace').hidden = true;
  paneOldNav.reset();
  paneNewNav.reset();
  state.currentDiff = null;

  el('traceBtn').disabled = true;
  el('traceBtnText').textContent = 'Tracing\u2026';
  el('siteLoading').hidden = false;

  try {
    const res = await fetch(`/api/snapshots?url=${encodeURIComponent(raw)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    if (!data.snapshots.length) {
      setError("The Wayback Machine doesn't have any snapshots for that address yet.");
      return;
    }

    state.url = data.url;
    state.snapshots = data.snapshots
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    state.fromIndex = 0;
    state.toIndex = state.snapshots.length - 1;

    el('timelineSiteName').textContent = state.url;
    el('timelineMeta').textContent =
      `${state.snapshots.length} recorded change${state.snapshots.length === 1 ? '' : 's'} on file, ` +
      `spanning ${formatDate(state.snapshots[0].date)} to ${formatDate(state.snapshots[state.snapshots.length - 1].date)}`;

    el('timelineSection').hidden = false;
    renderTimeline();
    el('timelineSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setError(err.message || 'Could not load that site.');
  } finally {
    el('traceBtn').disabled = false;
    el('traceBtnText').textContent = 'Trace this site';
    el('siteLoading').hidden = true;
  }
}

function setError(msg) {
  const box = el('urlError');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

// ---------------------------------------------------------------- Timeline
function renderTimeline() {
  const track = el('timelineTrack');
  const trackWidth = track.clientWidth || 1000;
  const minTime = new Date(state.snapshots[0].date).getTime();
  const maxTime = new Date(state.snapshots[state.snapshots.length - 1].date).getTime();
  const span = Math.max(1, maxTime - minTime);

  const xFor = (i) => {
    const t = new Date(state.snapshots[i].date).getTime();
    return ((t - minTime) / span) * trackWidth;
  };
  state._xFor = xFor;
  state._trackWidth = trackWidth;

  const tickLayer = el('tickLayer');
  tickLayer.innerHTML = '';
  state.snapshots.forEach((s, i) => {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = xFor(i) + 'px';
    tickLayer.appendChild(tick);
  });

  el('earliestLabel').textContent = formatDate(state.snapshots[0].date);
  el('latestLabel').textContent = formatDate(state.snapshots[state.snapshots.length - 1].date);

  positionHandles();
}

function positionHandles() {
  const xFrom = state._xFor(state.fromIndex);
  const xTo = state._xFor(state.toIndex);
  el('handleFrom').style.left = xFrom + 'px';
  el('handleTo').style.left = xTo + 'px';
  el('rangeFill').style.left = xFrom + 'px';
  el('rangeFill').style.width = Math.max(0, xTo - xFrom) + 'px';

  el('fromDate').textContent = formatDate(state.snapshots[state.fromIndex].date);
  el('toDate').textContent = formatDate(state.snapshots[state.toIndex].date);

  // Highlight the ticks currently selected as endpoints.
  const ticks = el('tickLayer').children;
  Array.from(ticks).forEach((t, i) => {
    t.classList.toggle('tick-hit', i === state.fromIndex || i === state.toIndex);
  });

  const distinct = state.fromIndex !== state.toIndex;
  el('compareBtn').disabled = !distinct;
}

function nearestIndexForClientX(clientX) {
  const track = el('timelineTrack');
  const rect = track.getBoundingClientRect();
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < state.snapshots.length; i++) {
    const d = Math.abs(state._xFor(i) - x);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function makeDraggable(handleEl, which) {
  handleEl.addEventListener('pointerdown', (e) => {
    handleEl.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const idx = nearestIndexForClientX(ev.clientX);
      if (which === 'from') {
        state.fromIndex = Math.min(idx, state.toIndex);
      } else {
        state.toIndex = Math.max(idx, state.fromIndex);
      }
      positionHandles();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
makeDraggable(el('handleFrom'), 'from');
makeDraggable(el('handleTo'), 'to');

window.addEventListener('resize', () => {
  if (state.snapshots.length) renderTimeline();
});

// ---------------------------------------------------------------- Compare
el('compareBtn').addEventListener('click', loadDiff);

async function loadDiff() {
  const from = state.snapshots[state.fromIndex];
  const to = state.snapshots[state.toIndex];

  el('workspace').hidden = false;
  el('loadingDiff').hidden = false;
  el('viewerPanes').style.visibility = 'hidden';
  el('compareBtn').disabled = true;
  el('compareBtn').textContent = 'Comparing\u2026';
  resetInsightPanel();
  showPaneLoading('paneOldLoading');
  showPaneLoading('paneNewLoading');

  try {
    const res = await fetch(
      `/api/diff?url=${encodeURIComponent(state.url)}&from=${from.timestamp}&to=${to.timestamp}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not build that comparison.');

    state.currentDiff = data;
    el('paneOldDate').textContent = formatDate(from.date);
    el('paneNewDate').textContent = formatDate(to.date);
    paneOldNav.setHome(data.oldHtml);
    paneNewNav.setHome(data.newHtml);

    renderChangeCounts(data.counts);
    renderChangesList(data.changes);
    loadNotes();

    el('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setError(err.message);
    hidePaneLoading('paneOldLoading');
    hidePaneLoading('paneNewLoading');
  } finally {
    el('loadingDiff').hidden = true;
    el('viewerPanes').style.visibility = 'visible';
    el('compareBtn').disabled = false;
    el('compareBtn').textContent = 'Compare snapshots';
  }
}

function showPaneLoading(id) { el(id).classList.remove('hidden'); }
function hidePaneLoading(id) { el(id).classList.add('hidden'); }

// The iframe's own load event fires once the archived HTML, its CSS, and
// its images have actually painted, which is the honest signal to hide the
// per-pane spinner (srcdoc assignment itself is instant, but fetching the
// original site's stylesheet and images from web.archive.org takes a beat).
el('paneOld').addEventListener('load', () => { hidePaneLoading('paneOldLoading'); hydrateBlockedStylesheets(el('paneOld')); });
el('paneNew').addEventListener('load', () => { hidePaneLoading('paneNewLoading'); hydrateBlockedStylesheets(el('paneNew')); });

// Now that archived pages render with their real links intact, clicking one
// navigates the iframe away to an actual page on web.archive.org, same as
// clicking a link anywhere. This controller gives each pane a tiny
// browser-style toolbar for that: back and forward walk the iframe's own
// navigation history (both are legitimate cross-origin-safe calls per the
// spec, so this works even once the iframe has wandered off to a real
// archive.org page), and the third button snaps straight back to the
// original diffed comparison by re-applying the saved home HTML directly,
// which is more reliable than trying to count "how many backs" that would take.
// srcdoc documents are their own separate browsing context — CSS on the
// <iframe> element from the host page (e.g. `.pane-frame { overflow-x:
// hidden }`) has zero effect on scrollbars *inside* that document. If the
// archived page has anything wider than the pane (an old fixed-width
// table, a missing box-sizing reset, a banner, etc.) the inner document
// becomes horizontally scrollable regardless of our outer CSS, which is
// why you can drag a scrollbar into what looks like empty space. The only
// reliable fix is to make the rule live *inside* that document, so we
// inject a tiny style block into the HTML before it ever becomes srcdoc.
function injectScrollFix(html) {
  if (!html) return html;
  const fixStyle =
    '<style>' +
    'html,body{overflow-x:hidden !important;}' +
    'img,video,table,iframe,pre{max-width:100%;}' +
    '</style>';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + fixStyle);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + fixStyle);
  }
  return fixStyle + html;
}

function createPaneNavController(iframeId, toolbarId) {
  const iframe = el(iframeId);
  const toolbar = el(toolbarId);
  let homeHtml = '';

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.pane-nav-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    try {
      if (action === 'back') iframe.contentWindow.history.back();
      else if (action === 'forward') iframe.contentWindow.history.forward();
      else if (action === 'reset') iframe.srcdoc = homeHtml;
    } catch (err) {
      // Cross-origin navigation controls can be refused by some browsers;
      // fail quietly rather than surfacing a console error to the person.
    }
  });

  return {
    setHome(html) {
      homeHtml = injectScrollFix(html);
      iframe.srcdoc = homeHtml;
    },
    reset() {
      homeHtml = '';
      iframe.srcdoc = '';
    },
    getHome() {
      return homeHtml;
    },
  };
}

const paneOldNav = createPaneNavController('paneOld', 'paneOldToolbar');
const paneNewNav = createPaneNavController('paneNew', 'paneNewToolbar');
const modalNav = createPaneNavController('modalFrame', 'modalToolbar');

// ---------------------------------------------------------------- Fullscreen modal
function openPaneModal(which) {
  const homeHtml = which === 'old' ? paneOldNav.getHome() : paneNewNav.getHome();
  if (!homeHtml) return;
  el('modalDateLabel').textContent = (which === 'old' ? el('paneOldDate') : el('paneNewDate')).textContent;
  modalNav.setHome(homeHtml);
  el('paneModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePaneModal() {
  el('paneModal').hidden = true;
  modalNav.reset();
  document.body.style.overflow = '';
}

el('paneOldExpand').addEventListener('click', () => openPaneModal('old'));
el('paneNewExpand').addEventListener('click', () => openPaneModal('new'));

// Hiding a snapshot to see the other one full width, and the matching
// restore. Only one side can be hidden at a time - picking a side just
// sets which (or clears it back to side-by-side).
function setSinglePaneView(which) {
  const panes = el('viewerPanes');
  panes.classList.remove('hide-old', 'hide-new');
  if (which === 'old') panes.classList.add('hide-old');
  else if (which === 'new') panes.classList.add('hide-new');
}
el('paneOldHide').addEventListener('click', () => setSinglePaneView('old'));
el('paneNewHide').addEventListener('click', () => setSinglePaneView('new'));
el('paneOldRestore').addEventListener('click', () => setSinglePaneView(null));
el('paneNewRestore').addEventListener('click', () => setSinglePaneView(null));
el('paneModalClose').addEventListener('click', closePaneModal);
el('paneModalBackdrop').addEventListener('click', closePaneModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('paneModal').hidden) closePaneModal();
});

function renderChangeCounts(counts) {
  el('changeCounts').innerHTML =
    `<span><b>${counts.added}</b> added</span>` +
    `<span><b>${counts.removed}</b> removed</span>` +
    `<span><b>${counts.changed}</b> changed</span>`;
}

function renderChangesList(changes) {
  clearSelection();
  const list = el('changesList');
  list.innerHTML = '';
  el('noChangesMsg').hidden = changes.length > 0;

  changes.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'change-row';

    const marker = document.createElement('i');
    marker.className = `change-marker ${c.type}`;

    const body = document.createElement('div');
    body.className = 'change-body';

    const kind = document.createElement('div');
    kind.className = 'change-kind';
    kind.textContent = `${c.type} \u00b7 <${c.tag}>`;

    const text = document.createElement('p');
    text.className = 'change-text';
    if (c.type === 'changed') {
      text.innerHTML = `<span class="before">${escapeHtml(truncate(c.before, 60))}</span> &rarr; <span class="after">${escapeHtml(truncate(c.after, 60))}</span>`;
    } else if (c.type === 'added') {
      text.innerHTML = `<span class="after">${escapeHtml(truncate(c.after, 90))}</span>`;
    } else {
      text.innerHTML = `<span class="before">${escapeHtml(truncate(c.before, 90))}</span>`;
    }

    body.appendChild(kind);
    body.appendChild(text);
    li.appendChild(marker);
    li.appendChild(body);

    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => jumpToChange(c, li));
    li.addEventListener('mouseenter', () => { cancelTooltipHide(); showChangeTooltip(c, li); });
    li.addEventListener('mouseleave', scheduleTooltipHide);
    li.addEventListener('focus', () => showChangeTooltip(c, li));
    li.addEventListener('blur', scheduleTooltipHide);
    list.appendChild(li);
  });
}

// Tracks whatever is currently marked "selected" so clicking a new change
// clears the old highlight properly instead of leaving multiple things lit
// up at once.
let selectedRowEl = null;
let selectedOldTarget = null;
let selectedNewTarget = null;

function clearSelection() {
  if (selectedRowEl) selectedRowEl.classList.remove('selected');
  if (selectedOldTarget) selectedOldTarget.classList.remove('pdiff-selected');
  if (selectedNewTarget) selectedNewTarget.classList.remove('pdiff-selected');
  selectedRowEl = null;
  selectedOldTarget = null;
  selectedNewTarget = null;
}

// Finds a diffed leaf inside a pane's live document without mutating
// anything — used both for the actual "jump and highlight" action and for
// silently asking "is this thing even visible right now," which is a
// different question (a menu item can be perfectly findable in the DOM
// and still be display:none behind a hamburger button at this width).
function findInPane(iframe, dataId) {
  if (!dataId) return null;
  try {
    const doc = iframe.contentDocument;
    return (doc && doc.querySelector(`[data-pdiff-id="${dataId}"]`)) || null;
  } catch (_) {
    return null; // cross-origin safety net, shouldn't happen with srcdoc
  }
}

// A short, readable tag[#id][.class] label for a node, for naming it in
// plain sentences.
function describeNode(node) {
  let label = node.tagName.toLowerCase();
  if (node.id) label += `#${node.id}`;
  else if (node.classList && node.classList.length) label += `.${Array.from(node.classList).slice(0, 2).join('.')}`;
  return label;
}

// Common naming conventions for the kind of container that's hidden by
// design until some interaction reveals it - a dropdown, a mobile drawer,
// a modal, a tab panel, an accordion. This is read straight off the id and
// class names, which are part of the DOM and always readable no matter
// what CORS says about the stylesheet that actually hides it.
const HIDDEN_CONTAINER_PATTERNS = [
  { re: /sub-?nav|dropdown|submenu|flyout|mega-?menu/i, kind: 'a dropdown submenu', action: 'hovering or clicking' },
  { re: /mobile|hamburger|offcanvas|drawer|burger/i, kind: 'a mobile navigation drawer', action: 'tapping the menu button (usually only at narrow widths)' },
  { re: /modal|dialog|popup|overlay|lightbox/i, kind: 'a modal or popup', action: 'a specific action elsewhere on the page' },
  { re: /tab-?panel|tab-?content/i, kind: 'a tab panel', action: 'selecting its tab' },
  { re: /accordion|collapse|collapsible/i, kind: 'an accordion panel', action: 'expanding it' },
  { re: /tooltip|popover/i, kind: 'a tooltip or popover', action: 'hovering or focusing its trigger' },
];

function classifyHiddenContainer(node) {
  const idClass = `${node.id || ''} ${(node.className && node.className.toString()) || ''}`;
  for (const p of HIDDEN_CONTAINER_PATTERNS) {
    if (p.re.test(idClass)) return p;
  }
  return null;
}

// Most dropdown/submenu markup follows the same shape: a trigger element
// (an <a> or <button> with visible text, like "SERVICES") sitting right
// next to the hidden container as a sibling under the same parent, e.g.
// <li><a>Services</a><ul id="sub-nav">...</ul></li>. Finding that sibling
// means the explanation can name the exact thing to hover or click,
// instead of describing the hiding mechanism in the abstract.
function findTriggerLabel(hiddenNode) {
  const parent = hiddenNode.parentElement;
  if (!parent) return null;
  const trigger = Array.from(parent.children).find(
    (el) => el !== hiddenNode && /^(a|button|summary)$/i.test(el.tagName) && el.textContent.trim().length > 0
  );
  return trigger ? trigger.textContent.trim().slice(0, 40) : null;
}

// Digs into the *actual, live* stylesheets of the rendered snapshot to
// explain why something is invisible. The DOM-structure read (what kind
// of container is this, what's the trigger) never depends on CORS and
// always has something to say. The CSS-rule lookup - including
// stylesheets fetched through our own backend proxy to get past a missing
// CORS header - is layered on top as a confirming detail when it
// succeeds, but the explanation never dead-ends on "couldn't check" as
// its only answer.
async function explainHiddenness(iframe, dataId) {
  const target = findInPane(iframe, dataId);
  if (!target) return null;

  let win, doc;
  try {
    win = iframe.contentWindow;
    doc = iframe.contentDocument;
  } catch (_) {
    return null;
  }

  let hiddenNode = null;
  let node = target;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 14) {
    const cs = win.getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      hiddenNode = node;
      break;
    }
    node = node.parentElement;
    depth++;
  }

  if (!hiddenNode) {
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return 'Renders at zero size. Typical of a screen reader only label, not a breakpoint.';
    }
    return null; // genuinely visible
  }

  const onSelf = hiddenNode === target;
  const where = onSelf ? '' : `Sits inside ${describeNode(hiddenNode)}. `;
  const classified = classifyHiddenContainer(hiddenNode);
  const trigger = findTriggerLabel(hiddenNode);

  let structural;
  if (classified) {
    structural = `${where}${describeNode(hiddenNode)} looks like ${classified.kind} by its name.`;
    structural += trigger ? ` Likely shown by ${classified.action} "${trigger}".` : ` Likely shown by ${classified.action} its trigger element.`;
  } else if (trigger) {
    structural = `${where}Hidden by CSS. A nearby "${trigger}" element may be what reveals it.`;
  } else {
    const inlineStyle = hiddenNode.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(inlineStyle)) {
      structural = `${where}Hidden by an inline style (style="${inlineStyle.trim()}"), not a stylesheet rule. Likely toggled by JavaScript rather than screen width.`;
    } else {
      structural = `${where}Hidden by CSS, most likely revealed by an interaction (click, hover, or focus) rather than by screen width.`;
    }
  }

  await waitForHydration(iframe);
  const rule = findHidingRule(doc, hiddenNode);
  if (rule && rule !== 'blocked') {
    const ruleDesc = `\`${rule.selectorText} { ${rule.declaration} }\``;
    const cond = describeMediaCondition(rule.mediaText);
    structural += cond ? ` Confirmed: hidden by ${ruleDesc}, but only whenever ${cond}.` : ` Confirmed: hidden by ${ruleDesc}, not tied to screen width at all.`;
  }

  return structural.trim();
}

// Cross-origin stylesheets without CORS headers can't be read through
// document.styleSheets at all. That's the browser enforcing it, not
// something a client-side trick can talk its way around directly - so
// instead, right when a pane finishes loading, this finds every
// stylesheet the browser refuses to let us read, fetches its raw text
// through our own backend (a server-to-server request, which CORS has no
// say over at all), and parses that text with the Constructable
// Stylesheets API into a standalone, unattached CSSStyleSheet object. It's
// never adopted into the live page, so there's no risk of re-applying
// styles or shifting cascade order - it exists purely so its rules are
// queryable the normal way.
const cssProxyCache = new Map(); // href -> Promise<string|null>, shared across reloads
const hydratedRulesByDoc = new WeakMap(); // Document -> array of CSSRuleList
const hydrationPromiseByDoc = new WeakMap(); // Document -> Promise, so callers can wait on it

function fetchCssViaProxy(href) {
  if (cssProxyCache.has(href)) return cssProxyCache.get(href);
  const p = fetch(`/api/css?url=${encodeURIComponent(href)}`)
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  cssProxyCache.set(href, p);
  return p;
}

function waitForHydration(iframe) {
  let doc;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return Promise.resolve();
  }
  if (!doc) return Promise.resolve();
  return hydrationPromiseByDoc.get(doc) || Promise.resolve();
}

function hydrateBlockedStylesheets(iframe) {
  let doc;
  try {
    doc = iframe.contentDocument;
  } catch (_) {
    return;
  }
  if (!doc || typeof CSSStyleSheet === 'undefined') return;

  const promise = (async () => {
    const blockedHrefs = [];
    Array.from(doc.styleSheets || []).forEach((sheet) => {
      try {
        void sheet.cssRules;
      } catch (_) {
        if (sheet.href) blockedHrefs.push(sheet.href);
      }
    });
    if (!blockedHrefs.length) return;

    const texts = await Promise.all(blockedHrefs.map(fetchCssViaProxy));
    const parsed = [];
    texts.forEach((text) => {
      if (!text) return;
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        parsed.push(sheet.cssRules);
      } catch (_) {
        // malformed CSS, or an environment without Constructable Stylesheets - skip it
      }
    });
    if (parsed.length) hydratedRulesByDoc.set(doc, parsed);
  })();

  hydrationPromiseByDoc.set(doc, promise);
}

function findHidingRule(doc, element) {
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue;
    }
    if (!rules) continue;
    const hit = searchRulesForHidingMatch(rules, element, null);
    if (hit) return hit;
  }

  const hydrated = hydratedRulesByDoc.get(doc);
  if (hydrated) {
    for (const rules of hydrated) {
      const hit = searchRulesForHidingMatch(rules, element, null);
      if (hit) return hit;
    }
    return null; // checked everything we could get to, directly or via proxy - genuinely no match
  }

  // Hydration never ran for this document (still in flight, or every
  // blocked stylesheet's fetch failed outright) and at least one
  // stylesheet threw on direct access - can't say more than that.
  let blocked = false;
  for (const sheet of Array.from(doc.styleSheets || [])) {
    try {
      void sheet.cssRules;
    } catch (_) {
      blocked = true;
      break;
    }
  }
  return blocked ? 'blocked' : null;
}

function searchRulesForHidingMatch(rules, element, mediaText) {
  for (const rule of Array.from(rules)) {
    if (rule.type === CSSRule.MEDIA_RULE) {
      const combined = mediaText ? `${mediaText} and ${rule.media.mediaText}` : rule.media.mediaText;
      const hit = searchRulesForHidingMatch(rule.cssRules, element, combined);
      if (hit) return hit;
    } else if (rule.type === CSSRule.STYLE_RULE) {
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch (_) {
        continue; // unsupported/invalid selector text - skip safely
      }
      if (!matches) continue;
      const display = rule.style.getPropertyValue('display');
      const visibility = rule.style.getPropertyValue('visibility');
      if (display === 'none') return { mediaText, selectorText: rule.selectorText, declaration: 'display: none' };
      if (visibility === 'hidden') return { mediaText, selectorText: rule.selectorText, declaration: 'visibility: hidden' };
    }
  }
  return null;
}

function describeMediaCondition(mediaText) {
  if (!mediaText) return null;
  const maxMatch = mediaText.match(/max-width:\s*([\d.]+)(px|em|rem)/i);
  const minMatch = mediaText.match(/min-width:\s*([\d.]+)(px|em|rem)/i);
  if (maxMatch && minMatch) return `the browser width is between ${minMatch[1]}${minMatch[2]} and ${maxMatch[1]}${maxMatch[2]}`;
  if (maxMatch) return `the browser width is ${maxMatch[1]}${maxMatch[2]} or narrower`;
  if (minMatch) return `the browser width is ${minMatch[1]}${minMatch[2]} or wider`;
  return `this condition is met: \`${mediaText}\``;
}

// Classifies what actually changed about a URL rather than just showing
// the raw before/after strings: a different domain, a different page on
// the same site, the same page with different query parameters, or just a
// different #fragment on the same page. Each of those means something
// different and deserves a different sentence.
function classifyUrlChange(before, after, baseHref) {
  let a, b;
  try {
    a = new URL(before, baseHref);
    b = new URL(after, baseHref);
  } catch (_) {
    return null; // not a resolvable URL (mailto:, javascript:void(0), etc.) - nothing useful to say
  }
  if (a.hostname !== b.hostname) {
    return { text: `This now points to a different domain entirely: ${a.hostname} \u2192 ${b.hostname}.`, traceUrl: null };
  }
  if (a.pathname !== b.pathname) {
    return {
      text: `Same site, but it now points to a different page: ${a.pathname} \u2192 ${b.pathname}.`,
      traceUrl: b.href,
    };
  }
  if (a.search !== b.search) {
    return {
      text: `Same page, just different URL parameters attached: ${a.search || '(none)'} \u2192 ${b.search || '(none)'}.`,
      traceUrl: b.href,
    };
  }
  if (a.hash !== b.hash) {
    return {
      text: `Same page, it just jumps to a different section of it now: ${a.hash || '(top of page)'} \u2192 ${b.hash || '(top of page)'}.`,
      traceUrl: b.href,
    };
  }
  if (a.protocol !== b.protocol) {
    return { text: `Only the protocol changed (${a.protocol} \u2192 ${b.protocol}). Same destination either way.`, traceUrl: b.href };
  }
  return { text: `The URL text differs slightly (formatting, encoding, or a trailing slash), but it resolves to the same place.`, traceUrl: b.href };
}

const APPEARANCE_PROPS = [
  ['color', 'text color'],
  ['background-color', 'background color'],
  ['font-weight', 'font weight'],
  ['font-size', 'font size'],
  ['text-decoration-line', 'underline / strikethrough'],
  ['font-style', 'italic style'],
];

// Compares the two live, rendered elements directly - real computed
// styles from each snapshot's own CSS, not a guess based on class names.
function compareLeafAppearance(oldIframe, oldId, newIframe, newId) {
  const oldEl = findInPane(oldIframe, oldId);
  const newEl = findInPane(newIframe, newId);
  if (!oldEl || !newEl) return [];
  let winOld, winNew;
  try {
    winOld = oldIframe.contentWindow;
    winNew = newIframe.contentWindow;
  } catch (_) {
    return [];
  }
  const csOld = winOld.getComputedStyle(oldEl);
  const csNew = winNew.getComputedStyle(newEl);
  const diffs = [];
  APPEARANCE_PROPS.forEach(([prop, label]) => {
    const a = csOld.getPropertyValue(prop);
    const b = csNew.getPropertyValue(prop);
    if (a && b && a !== b) diffs.push({ label, before: a, after: b });
  });
  return diffs;
}

function selectInPane(iframe, dataId) {
  const target = findInPane(iframe, dataId);
  if (!target) return null;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('pdiff-selected');
  return target;
}

function jumpToChange(c, rowEl) {
  const alreadySelected = rowEl && rowEl === selectedRowEl;
  clearSelection();
  if (alreadySelected) return; // clicking the same row again deselects it

  if (rowEl) {
    rowEl.classList.add('selected');
    selectedRowEl = rowEl;
  }

  selectedNewTarget = selectInPane(el('paneNew'), c.newId);
  selectedOldTarget = selectInPane(el('paneOld'), c.oldId);
}

// ---------------------------------------------------------------- Change detail modal
// The sidebar list is deliberately compact (truncated, two-line-clamped)
// so a long page's worth of changes stays scannable. That's exactly what
// makes it useless the moment someone actually needs to read one change
// carefully, so hovering a row shows a small tooltip with the complete
// text, a plain explanation of why something like "Etablissement.Org to
// Etablissement.Org" still counts as changed when the words match, and a
// quick note if the element just isn't visible in its pane right now.
const ATTR_LABELS = {
  href: 'link goes to',
  src: 'source',
  alt: 'alt text',
  title: 'title',
  target: 'opens in',
  poster: 'poster image',
  type: 'input type',
  placeholder: 'placeholder',
  value: 'value',
  name: 'name',
};

function attrLabel(name) { return ATTR_LABELS[name] || name; }
function displayAttrValue(v) { return v === null || v === undefined || v === '' ? '(none)' : v; }
function formatInlineCode(text) { return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>'); }

let tooltipHideTimer = null;
let tooltipToken = 0;
function cancelTooltipHide() { if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; } }
function scheduleTooltipHide() { tooltipHideTimer = setTimeout(hideChangeTooltip, 150); }

function showChangeTooltip(c, anchorEl) {
  const tooltip = el('changeDetailTooltip');

  el('changeDetailBadge').textContent = c.type;
  el('changeDetailBadge').className = `change-badge ${c.type}`;
  el('changeDetailTag').textContent = `<${c.tag}>`;
  el('changeDetailPath').textContent = c.path || '';
  el('changeDetailPath').hidden = !c.path;

  const pair = el('changeDetailTextPair');
  const beforeBlock = el('changeDetailBefore');
  const afterBlock = el('changeDetailAfter');
  const arrow = el('changeDetailArrow');
  const sameBlock = el('changeDetailSameText');

  const textIsSame = c.type === 'changed' && c.textChanged === false;

  // When the text hasn't actually changed, showing it twice as a fake
  // before/after just repeats the confusion. Show it once, plainly, and
  // let the sections below do the explaining of what actually did change.
  pair.hidden = textIsSame;
  sameBlock.hidden = !textIsSame;

  if (textIsSame) {
    sameBlock.innerHTML = `<span class="change-detail-label">Text (unchanged)</span><p>${escapeHtml(c.after || '(empty)')}</p>`;
  } else {
    beforeBlock.hidden = c.type === 'added';
    afterBlock.hidden = c.type === 'removed';
    arrow.hidden = c.type !== 'changed';
    if (!beforeBlock.hidden) {
      beforeBlock.innerHTML = `<span class="change-detail-label">Before</span><p>${escapeHtml(c.before || '(empty)')}${c.beforeTruncated ? '\u2026' : ''}</p>`;
    }
    if (!afterBlock.hidden) {
      afterBlock.innerHTML = `<span class="change-detail-label">After</span><p>${escapeHtml(c.after || '(empty)')}${c.afterTruncated ? '\u2026' : ''}</p>`;
    }
  }

  // ---- attribute changes: pull href/src out into the URL classifier
  // below, since "it goes somewhere different now" deserves a real
  // sentence, not a raw string diff. Everything else (title, target, alt,
  // etc.) stays in the plain list.
  let urlAttrChange = null;
  let attrRows = [];
  if (c.type === 'changed' && Array.isArray(c.attrChanges)) {
    c.attrChanges.forEach((a) => {
      if ((a.name === 'href' || a.name === 'src') && !urlAttrChange) urlAttrChange = a;
      else attrRows.push({ name: a.name, before: a.before, after: a.after, isDiff: true });
    });
  } else if (c.type === 'added' && c.attrsAfter) {
    attrRows = Object.entries(c.attrsAfter).map(([name, after]) => ({ name, after, isDiff: false }));
  } else if (c.type === 'removed' && c.attrsBefore) {
    attrRows = Object.entries(c.attrsBefore).map(([name, before]) => ({ name, before, isDiff: false }));
  }

  const attrSection = el('changeDetailAttrSection');
  const attrList = el('changeDetailAttrList');
  attrList.innerHTML = '';
  attrSection.hidden = attrRows.length === 0;
  attrRows.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'change-attr-row';
    if (row.isDiff) {
      li.innerHTML =
        `<span class="change-attr-name">${escapeHtml(attrLabel(row.name))}</span>` +
        `<span class="change-attr-value before">${escapeHtml(displayAttrValue(row.before))}</span>` +
        `<span class="change-attr-sep">&rarr;</span>` +
        `<span class="change-attr-value after">${escapeHtml(displayAttrValue(row.after))}</span>`;
    } else {
      const val = row.after !== undefined ? row.after : row.before;
      li.innerHTML =
        `<span class="change-attr-name">${escapeHtml(attrLabel(row.name))}</span>` +
        `<span class="change-attr-value">${escapeHtml(displayAttrValue(val))}</span>`;
    }
    attrList.appendChild(li);
  });

  // ---- link/src destination classification (domain vs page vs query vs
  // fragment), resolved against the *new* snapshot's own <base> so
  // relative paths resolve to something real.
  const linkSection = el('changeDetailLinkSection');
  const linkNote = el('changeDetailLinkNote');
  const traceBtn = el('changeDetailTraceBtn');
  let classified = null;
  if (urlAttrChange) {
    let baseHref = null;
    try {
      baseHref = (el('paneNew').contentDocument || el('paneOld').contentDocument).baseURI;
    } catch (_) {
      baseHref = null;
    }
    classified = classifyUrlChange(urlAttrChange.before, urlAttrChange.after, baseHref);
  }
  linkSection.hidden = !classified;
  if (classified) {
    linkNote.textContent = classified.text;
    if (classified.traceUrl && urlAttrChange.name === 'href') {
      traceBtn.hidden = false;
      traceBtn.onclick = () => {
        hideChangeTooltip();
        el('urlInput').value = classified.traceUrl;
        loadSite(classified.traceUrl);
      };
    } else {
      traceBtn.hidden = true;
      traceBtn.onclick = null;
    }
  }

  // ---- appearance diff: compare the two *live rendered* elements
  // directly, real computed styles from each snapshot's own CSS.
  const appearanceSection = el('changeDetailAppearanceSection');
  const appearanceList = el('changeDetailAppearanceList');
  appearanceList.innerHTML = '';
  let appearanceDiffs = [];
  if (c.type === 'changed' && c.oldId && c.newId) {
    appearanceDiffs = compareLeafAppearance(el('paneOld'), c.oldId, el('paneNew'), c.newId);
  }
  appearanceSection.hidden = appearanceDiffs.length === 0;
  appearanceDiffs.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'change-attr-row';
    li.innerHTML =
      `<span class="change-attr-name">${escapeHtml(d.label)}</span>` +
      `<span class="change-attr-value before">${escapeHtml(d.before)}</span>` +
      `<span class="change-attr-sep">&rarr;</span>` +
      `<span class="change-attr-value after">${escapeHtml(d.after)}</span>`;
    appearanceList.appendChild(li);
  });

  // ---- visibility: a real, CSS-grounded reason per side, not a guess.
  // Old and new can be hidden for entirely different reasons, so each
  // gets its own line, labeled, when both apply. This can involve an
  // in-flight fetch (for a stylesheet the browser won't let us read
  // directly), so it's resolved after the rest of the tooltip is already
  // showing, and discarded if the person has moved on to a different row
  // by the time it settles.
  const visList = el('changeDetailVisibilityList');
  visList.innerHTML = '';
  visList.hidden = true;
  const myTooltipToken = ++tooltipToken;

  Promise.all([
    c.oldId ? explainHiddenness(el('paneOld'), c.oldId) : null,
    c.newId ? explainHiddenness(el('paneNew'), c.newId) : null,
  ]).then(([oldReason, newReason]) => {
    if (myTooltipToken !== tooltipToken || tooltip.hidden) return;
    const notes = [];
    if (oldReason) notes.push({ label: 'Earlier snapshot', reason: oldReason });
    if (newReason) notes.push({ label: 'Later snapshot', reason: newReason });
    visList.hidden = notes.length === 0;
    notes.forEach((n) => {
      const li = document.createElement('li');
      const prefix = notes.length > 1 ? `<strong>${escapeHtml(n.label)}:</strong> ` : '';
      li.innerHTML = `${prefix}${formatInlineCode(n.reason)}`;
      visList.appendChild(li);
    });
    positionTooltip(tooltip, anchorEl.getBoundingClientRect());
  });

  tooltip.style.visibility = 'hidden';
  tooltip.hidden = false;
  requestAnimationFrame(() => {
    positionTooltip(tooltip, anchorEl.getBoundingClientRect());
    tooltip.style.visibility = '';
  });
}

function positionTooltip(tooltip, anchorRect) {
  const margin = 10;
  const width = tooltip.offsetWidth || 300;
  const height = tooltip.offsetHeight || 160;

  let left = anchorRect.left - width - margin;
  if (left < margin) left = Math.max(margin, Math.min(anchorRect.right + margin, window.innerWidth - width - margin));

  let top = anchorRect.top + anchorRect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideChangeTooltip() {
  el('changeDetailTooltip').hidden = true;
}

el('changeDetailTooltip').addEventListener('mouseenter', cancelTooltipHide);
el('changeDetailTooltip').addEventListener('mouseleave', scheduleTooltipHide);

function truncate(s, n) { return (s || '').length > n ? s.slice(0, n).trim() + '\u2026' : (s || ''); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- View toggle
el('viewSideBySide').addEventListener('click', () => setViewMode('side'));
el('viewOverlay').addEventListener('click', () => setViewMode('overlay'));

function setViewMode(mode) {
  state.viewMode = mode;
  el('viewSideBySide').classList.toggle('active', mode === 'side');
  el('viewOverlay').classList.toggle('active', mode === 'overlay');
  el('viewerPanes').classList.toggle('overlay-mode', mode === 'overlay');
}

// ---------------------------------------------------------------- Side tabs
const tabs = { changes: el('tabChanges'), notes: el('tabNotes'), insight: el('tabInsight') };
const panels = { changes: el('panelChanges'), notes: el('panelNotes'), insight: el('panelInsight') };
el('panelChanges').addEventListener('scroll', hideChangeTooltip, { passive: true });

Object.keys(tabs).forEach((key) => {
  tabs[key].addEventListener('click', () => {
    Object.keys(tabs).forEach((k) => {
      tabs[k].classList.toggle('active', k === key);
      panels[k].hidden = k !== key;
    });
  });
});

// ---------------------------------------------------------------- Notes
//
// Notes are an append-only log per site now: saving always adds a new
// dated card rather than overwriting the last one, and there's always an
// open composer below the list ready for the next entry. Each existing
// card can still be edited or cleared individually, independent of the
// composer. Keyed by the site's URL alone, not by which two dates are
// being compared, so the whole log follows you regardless of date range.
let notesList = [];
let composerDirty = false;

function setComposerDirty(dirty) {
  composerDirty = dirty;
  el('notesSaveBtn').disabled = !dirty;
}

window.addEventListener('beforeunload', (e) => {
  if (!composerDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

function noteDateLabel(note) {
  return `Saved ${formatDate(new Date(note.updatedAt).toISOString())} \u00b7 ${timeAgo(note.updatedAt)}`;
}

async function loadNotes() {
  el('notesStatus').textContent = '';
  el('notesArea').value = '';
  setComposerDirty(false);
  try {
    const res = await fetch(`/api/notes?url=${encodeURIComponent(state.url)}`);
    const data = await res.json();
    notesList = data.notes || [];
  } catch (_) {
    notesList = [];
    el('notesStatus').textContent = "Couldn't load notes for this site just now.";
  }
  renderNotesList();
}

function renderNotesList() {
  const container = el('notesList');
  container.innerHTML = '';
  notesList.forEach((note) => container.appendChild(buildNoteCard(note)));
}

// Each card is self-contained: it knows how to switch itself into an
// inline editor (its own textarea + Save/Cancel) and back into read mode,
// independent of every other card and of the composer at the bottom.
function buildNoteCard(note) {
  const card = document.createElement('div');
  card.className = 'notes-card';

  const renderReadMode = () => {
    card.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'notes-card-header';
    const dateSpan = document.createElement('span');
    dateSpan.className = 'notes-card-date mono';
    dateSpan.textContent = noteDateLabel(note);
    const editBtn = document.createElement('button');
    editBtn.className = 'text-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', renderEditMode);
    header.appendChild(dateSpan);
    header.appendChild(editBtn);

    const body = document.createElement('p');
    body.className = 'notes-card-body';
    body.textContent = note.body;

    card.appendChild(header);
    card.appendChild(body);
  };

  const renderEditMode = () => {
    card.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'notes-area';
    textarea.value = note.body;

    const actions = document.createElement('div');
    actions.className = 'notes-edit-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'text-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', renderReadMode);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-btn notes-save-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      el('notesStatus').textContent = 'Saving\u2026';
      try {
        const res = await fetch(`/api/notes/${note.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: state.url, body: textarea.value }),
        });
        const data = await res.json();
        el('notesStatus').textContent = '';
        if (data.deleted) {
          notesList = notesList.filter((n) => n.id !== note.id);
          renderNotesList();
          return;
        }
        note.body = data.body;
        note.updatedAt = data.updatedAt;
        renderReadMode();
      } catch (_) {
        el('notesStatus').textContent = "Couldn't save just now.";
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    card.appendChild(textarea);
    card.appendChild(actions);
    textarea.focus();
  };

  renderReadMode();
  return card;
}

el('notesArea').addEventListener('input', () => setComposerDirty(el('notesArea').value.trim().length > 0));

el('notesSaveBtn').addEventListener('click', async () => {
  const body = el('notesArea').value;
  if (!body.trim()) return;
  el('notesStatus').textContent = 'Saving\u2026';
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: state.url, body }),
    });
    const note = await res.json();
    notesList.unshift(note); // newest on top, composer always stays below the whole list
    renderNotesList();
    el('notesArea').value = '';
    setComposerDirty(false);
    el('notesStatus').textContent = '';
  } catch (_) {
    el('notesStatus').textContent = "Couldn't save just now.";
  }
});

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- Insight
function resetInsightPanel() {
  el('insightIdle').hidden = false;
  el('insightLoading').hidden = true;
  el('insightResult').hidden = true;
  el('insightError').hidden = true;
}

el('generateInsightBtn').addEventListener('click', () => generateInsight());
el('regenerateInsightBtn').addEventListener('click', () => generateInsight(true));

async function generateInsight() {
  const from = state.snapshots[state.fromIndex];
  const to = state.snapshots[state.toIndex];

  el('insightIdle').hidden = true;
  el('insightResult').hidden = true;
  el('insightError').hidden = true;
  el('insightLoading').hidden = false;

  try {
    const res = await fetch('/api/insight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.url,
        from: from.timestamp,
        to: to.timestamp,
        dateFrom: formatDate(from.date),
        dateTo: formatDate(to.date),
        changes: state.currentDiff.changes,
        counts: state.currentDiff.counts,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not generate an insight.');

    el('insightText').textContent = data.summary;
    el('insightSources').innerHTML = '';
    (data.sources || []).forEach((s) => {
      const a = document.createElement('a');
      a.className = 'insight-source';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title;
      el('insightSources').appendChild(a);
    });

    el('insightLoading').hidden = true;
    el('insightResult').hidden = false;
  } catch (err) {
    el('insightLoading').hidden = true;
    el('insightError').hidden = false;
    el('insightError').textContent = err.message;
  }
}
