// lib/reviveWidgets.js
//
// Two kinds of content a capture arrives without, because the thing that would
// have shown it was a script, and nothing here runs a capture's scripts.
//
// 1. Pictures that were waiting for a lazy loader.
//
//    From 2017 on, images are marked with a 1x1 transparent PNG in `src` and the
//    real address in `data-src`; a loader copies it across when the picture nears
//    the viewport. Nothing ever copies it here, so the page arrives with eleven
//    invisible pictures. Measured on this record: 694 of the 749 cached captures
//    carry a `data-src`.
//
//    The address also has to be rewritten on the way in, and that is not
//    cosmetic. The Archive rewrites the attributes it knows, `src`, `href`,
//    `srcset`, and leaves the rest exactly as the site wrote it, so
//    `data-src="/Content/slider/pics/apr-tax-return.jpg"` arrives root-relative.
//    Against this app's base that resolves to web.archive.org/Content/... , which
//    is a 404 with the Archive's own error page behind it. It is rewritten to the
//    form the page's own `src` attributes already use, so it resolves to the
//    capture's own copy of the file.
//
// 2. A carousel that was hidden until its plugin started.
//
//    `.owl-carousel` is `display: none` in owl's stylesheet; the plugin trades
//    that for `.owl-loaded` when it runs. Stripping scripts therefore does not
//    merely leave the band empty, it leaves twelve slides in the markup that no
//    reader can reach. Measured: 722 of the 749 cached captures carry the
//    carousel, so this is most of the record.
//
//    Both halves of the repair come from the page, never from a guess. The slides
//    are all present in document order; the *window*, which few of them were on
//    screen at once, comes from the plugin's own configuration
//    (`items: 1/2/3` at 0/600/1000px, `startPosition: 6`, `center: true`) while
//    the script is still in hand, and otherwise from the page's own statement of
//    which slide is current: this carousel marks it `<span class="currentmonth">`
//    inside an anchor pointing at the slide's `data-hash`.
//
//    Those two sources have to agree, and they were checked against each other
//    rather than assumed: across all 722 captures the marked slide is at index 6,
//    which is exactly what `startPosition: 6` says. That agreement is the point.
//    A window that came out differently for a capture prepared from the cache than
//    for one prepared from the network would put different slides on screen in two
//    frames of the same film, which reads as a change in the record that never
//    happened.
//
//    The window is expressed as CSS rather than by moving nodes: the slides keep
//    their document order, and the track is shifted by the equivalent of a scroll
//    offset. Nothing about a document's structure changes on the way to a diff,
//    and the geometry is the plugin's own, three slides across at 1000px, two at
//     600px, one below, centered on the current one, clipped by the container the
//    way the plugin clipped it.

const REVIVE_STYLE_ID = 'palimpsest-revive';
const REVIVED_CLASS = 'palimpsest-revived';

// owl's own defaults, which is also this record's configuration: measured
// identical in captures from 2015 and from 2026, so a document prepared from the
// cache (no script left to read) and one prepared from the network plan the same
// window.
const DEFAULT_TIERS = [
  { min: 0, items: 1 },
  { min: 600, items: 2 },
  { min: 1000, items: 3 },
];
const DEFAULT_MARGIN = 10;

// Attributes a lazy loader leaves the real address in. `data-src` is the one this
// record uses; the rest are the same idea under the names the common libraries
// gave it, and reading them costs nothing.
const LAZY_SRC_ATTRS = [
  'data-src', 'data-lazy-src', 'data-original', 'data-lazy',
  'data-echo', 'data-url', 'data-flickity-lazyload', 'data-hi-res-src',
];

// A `src` that is not a picture: the 1x1 placeholder every lazy loader ships, or
// a data: URI standing in for one. Anything recognised here is what gets replaced.
const PLACEHOLDER_RE =
  /^(?:data:)|(?:^|\/)(?:blank|spacer|pixel|transparent|clear|empty)(?:[-_.]?\d*x?\d*)?\.(?:gif|png|jpe?g)|(?:^|\/)1x1\.|^about:blank$/i;

function isElement(node) {
  return node && node.nodeType === 1;
}

function attrs(node) {
  const out = {};
  for (const a of Array.from(node.attributes || [])) out[a.name.toLowerCase()] = a.value;
  return out;
}

// ---------------------------------------------------------------------------
// Lazy pictures
// ---------------------------------------------------------------------------

// The captured page's own address, with a scheme on it.
//
// The record's key is scheme-less (`settlement.org`), and a relative `data-src`
// cannot be resolved against it, `new URL('/Content/a.jpg', 'settlement.org')`
// throws, and a thrown resolution is a picture that silently stays a placeholder.
// That bug was real: the promotion worked against a hand-written full URL and did
// nothing against the key the running app actually passes.
//
// The scheme comes from the page itself rather than from a guess: every absolute
// link in a capture has been rewritten by the Archive to `/web/<ts>/<scheme>://
// <host>/…`, so the capture's own links say which scheme it was taken over. A
// third-party link (a Facebook one) says nothing about this host, so the host is
// matched, and a `www.` on either side is not a difference.
function captureOrigin(doc, url) {
  const raw = String(url || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

  const host = raw.replace(/^\/+/, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  if (host && doc) {
    const html = doc.documentElement ? doc.documentElement.outerHTML : '';
    const re = /\/web\/\d{14}(?:[a-z]{2,3}_)?\/([a-z]+:\/\/[^\/"'?#\s]+)/gi;
    for (const m of html.matchAll(re)) {
      let candidate = null;
      try { candidate = new URL(m[1]); } catch (_) { continue; }
      const h = candidate.hostname.replace(/^www\./i, '').toLowerCase();
      if (h === host) return candidate.origin;
    }
  }
  return raw ? 'http://' + raw : '';
}

// The address as the capture would have asked for it. A URL that already points
// back into the Archive is left alone; anything else is resolved against the
// captured page's own address and written in the form the page's rewritten
// `src` attributes use, so the image the reader gets is the one that capture saw.
function archiveAssetUrl(candidate, { origin, timestamp }) {
  const raw = (candidate || '').trim();
  if (!raw || /^(?:data|blob|javascript|mailto|about):/i.test(raw) || raw.charAt(0) === '#') return null;
  if (/^https?:\/\/web\.archive\.org\//i.test(raw) || /^\/web\/\d{14}/.test(raw)) return raw;
  if (!timestamp || !origin) return raw;
  let abs;
  try {
    abs = new URL(raw, origin).toString();
  } catch (_) {
    return null;
  }
  // `im_` is the modifier the page's own image tags carry, and it is the one this
  // app's asset route understands for a picture.
  return `/web/${timestamp}im_/${abs}`;
}

function promoteLazyImages(doc, capture) {
  let promoted = 0;
  let srcsets = 0;
  const origin = captureOrigin(doc, capture.url);
  const where = { origin, timestamp: capture.timestamp };

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const map = attrs(img);
    const src = (map.src || '').trim();
    const srcMissing = !src || PLACEHOLDER_RE.test(src);
    let candidate = null;
    for (const name of LAZY_SRC_ATTRS) {
      if (map[name]) { candidate = map[name]; break; }
    }
    // Only ever replaces a placeholder or an absent address: a picture that is
    // already pointing somewhere is the picture the page chose to show.
    const rewritten = srcMissing ? archiveAssetUrl(candidate, where) : null;
    if (rewritten) {
      img.setAttribute('src', rewritten);
      promoted++;
    }
    // `srcset` wins over `src` in a browser, so a lazy `srcset` behind a live one
    // is the same blank picture by another route.
    const set = (map.srcset || '').trim();
    const lazySet = (map['data-srcset'] || map['data-lazy-srcset'] || '').trim();
    if (lazySet && (!set || PLACEHOLDER_RE.test(set))) {
      img.setAttribute('srcset', rewriteSrcset(lazySet, where));
      srcsets++;
      img.removeAttribute('data-srcset');
      img.removeAttribute('data-lazy-srcset');
    }
    // A picture the browser has been told to fetch only when it comes near the
    // viewport is a picture the film never gets: a still is laid out once, with
    // nothing scrolled and nothing waited for.
    if ((map.loading || '').toLowerCase() === 'lazy') img.setAttribute('loading', 'eager');
  }

  // `<source>` inside `<picture>` carries the same `data-srcset` idea.
  for (const source of Array.from(doc.querySelectorAll('source'))) {
    const map = attrs(source);
    const lazySet = (map['data-srcset'] || map['data-lazy-srcset'] || '').trim();
    if (!lazySet || (map.srcset || '').trim()) continue;
    source.setAttribute('srcset', rewriteSrcset(lazySet, where));
    srcsets++;
  }

  return { promoted, srcsets };
}

// `srcset` is a list of candidate addresses, each with an optional width or
// density descriptor that has to survive the rewrite.
function rewriteSrcset(value, where) {
  return value
    .split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const one = archiveAssetUrl(bits[0], where);
      return one ? [one].concat(bits.slice(1)).join(' ') : part.trim();
    })
    .filter(Boolean)
    .join(', ');
}

// ---------------------------------------------------------------------------
// The carousel
// ---------------------------------------------------------------------------

// The plugin's own configuration, read out of the inline script while it is still
// there. Only the four values the layout needs, and only from the first call: a
// page with two differently configured carousels is not a case this record has,
// and the wrong window for the second one is a smaller error than no window for
// either.
function readOwlConfig(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml) return null;
  const at = rawHtml.search(/owlCarousel\s*\(\s*\{/);
  if (at < 0) return null;
  const block = balancedBlock(rawHtml, rawHtml.indexOf('{', at));
  if (!block) return null;

  const cfg = { items: [], startPosition: null, center: null, margin: null };
  const sp = /\bstartPosition\s*:\s*(\d+)/.exec(block);
  if (sp) cfg.startPosition = Number(sp[1]);
  const ce = /\bcenter\s*:\s*(true|false)/.exec(block);
  if (ce) cfg.center = ce[1] === 'true';
  const mg = /\bmargin\s*:\s*(\d+)/.exec(block);
  if (mg) cfg.margin = Number(mg[1]);
  const rp = /\bresponsive\s*:\s*\{/.exec(block);
  if (rp) {
    const inner = balancedBlock(block, block.indexOf('{', rp.index));
    if (inner) {
      for (const m of inner.matchAll(/(\d+)\s*:\s*\{([^{}]*)\}/g)) {
        const items = /\bitems\s*:\s*(\d+)/.exec(m[2]);
        if (items) cfg.items.push({ min: Number(m[1]), items: Number(items[1]) });
      }
    }
  }
  const single = /\bitems\s*:\s*(\d+)/.exec(block);
  if (single && !cfg.items.length) cfg.items.push({ min: 0, items: Number(single[1]) });
  return cfg;
}

// The text between a `{` and its matching `}`, with strings skipped so a brace
// inside a string cannot end the block early.
function balancedBlock(text, openAt) {
  if (openAt < 0 || text.charAt(openAt) !== '{') return null;
  let depth = 0;
  let quote = null;
  for (let i = openAt; i < text.length && i < openAt + 20000; i++) {
    const c = text.charAt(i);
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) return text.slice(openAt, i + 1);
    }
  }
  return null;
}

function resolveTiers(cfg) {
  const tiers = (cfg && cfg.items && cfg.items.length ? cfg.items : DEFAULT_TIERS)
    .map((t) => ({ min: Number(t.min) || 0, items: Math.max(1, Number(t.items) || 1) }))
    .sort((a, b) => a.min - b.min);
  // The widths below the narrowest configured breakpoint inherit it, which is how
  // the plugin behaves: a responsive map that starts at 600 leaves the phone
  // showing the 600px count.
  if (tiers[0].min > 0) tiers.unshift({ min: 0, items: tiers[0].items });
  return tiers;
}

function marksCurrent(anchor) {
  const test = (cls) => /current|active|selected/i.test(cls || '');
  if (test(anchor.className)) return true;
  for (const child of Array.from(anchor.children)) if (test(child.className)) return true;
  return false;
}

// Which slide the plugin would have centered, from the page itself: the anchor
// that points at a slide (`data-hash`) and declares itself the current one. The
// configuration wins when it is available, because it is the plugin's own word on
// the matter; the marker is what a document prepared from the cache has left.
function pickAnchor(doc, slides, cfg) {
  const count = slides.length;
  const clamp = (i) => Math.max(0, Math.min(count - 1, i));
  if (cfg && cfg.startPosition !== null) return clamp(cfg.startPosition);

  const byHash = new Map();
  slides.forEach((el, i) => {
    const hash = el.getAttribute('data-hash');
    if (hash) byHash.set('#' + hash, i);
  });
  if (byHash.size) {
    for (const anchor of Array.from(doc.querySelectorAll('a[href^="#"]'))) {
      const i = byHash.get(anchor.getAttribute('href'));
      if (i === undefined) continue;
      if (marksCurrent(anchor)) return clamp(i);
    }
  }
  return 0;
}

// Which slide the window starts at. Centering is the plugin's `center: true`  
// the current slide in the middle of the ones on screen; a window that would
// start before the first slide or end past the last one is pulled back inside the
// run, which is what the plugin does at the ends of a non-looping carousel.
function shiftFor(tier, anchor, count, center) {
  const visible = Math.max(1, Math.min(tier.items, count));
  const raw = center ? anchor - Math.floor((visible - 1) / 2) : anchor;
  return Math.max(0, Math.min(count - visible, raw));
}

function planCarousel(doc, box, cfg, index) {
  const slides = Array.from(box.children).filter(isElement);
  if (!slides.length) return null;

  const anchor = pickAnchor(doc, slides, cfg);
  const center = cfg && cfg.center !== null ? cfg.center : true;
  // Per breakpoint: how many slides are across, and how far the track is pulled
  // left, counted in slides. Those two numbers are the whole window, the slides
  // on screen are `shift` up to `shift + items - 1`, and they are what the
  // stylesheet below is built from.
  const tiers = resolveTiers(cfg).map((tier) => {
    const items = Math.max(1, Math.min(tier.items, slides.length));
    const shift = shiftFor({ items }, anchor, slides.length, center);
    return { min: tier.min, items, shift };
  });

  // The plugin moves the slides into wrappers and styles the wrapper, so the same
  // wrapper is built here, this site's own stylesheet sizes and dims `.owl-item`,
  // and a slide in a bare `<div class="item">` would be neither sized nor dimmed.
  const track = doc.createElement('div');
  track.className = 'pal-track';
  slides.forEach((slide, i) => {
    const wrap = doc.createElement('div');
    wrap.className = i === anchor ? 'owl-item active center' : 'owl-item';
    wrap.appendChild(slide);
    track.appendChild(wrap);
  });
  box.appendChild(track);
  // The plugin's own class is added as well as this app's marker: the site's
  // stylesheet hangs `.owl-carousel` layout off `.owl-loaded`, and half of what
  // makes the band look like itself comes from there.
  box.classList.add('owl-loaded', REVIVED_CLASS);
  box.setAttribute('data-pal', String(index));

  return { index, anchor, count: slides.length, tiers };
}

// Every slide in a row, each one exactly `1/n` of the band, and the row pulled
// left by `shift` of those widths. The band clips what falls outside it, which is
// the only thing `overflow` is doing here, the plugin had the same arrangement,
// one `.owl-stage` inside one `.owl-stage-outer`.
//
// This is the third version of the window and the first one that holds, so both
// earlier failures are worth writing down.
//
// The first laid the slides in a row and shifted it with a negative left margin.
// A slide's width is a percentage of the track's width, and a negative left
// margin on a block *widens* that block, its width is its containing block's
// width minus its margins, so the shift made every slide bigger instead of
// moving the row. Measured: a 1442px frame showed Aug/Sep/Oct where the plugin
// showed Dec/Jan/Feb.
//
// The second showed the slides in the window and hid the rest with
// `:nth-child(n+A):nth-child(-n+B)`. It looks airtight and is not: a tier's rules
// can only ever *add* visible slides, because the rules that hid everything else
// are outside the media query and still apply. Every narrower tier therefore
// inherits the widest tier's window. Measured on a real frame: at 413px across,
// with `--pal-n` correctly reading 1, three slides were still on screen.
//
// `transform` is not a trick to avoid either mistake, it is the shape that does
// not have them. A translation is drawn, not laid out, so it cannot change any
// width; percentages in it resolve against the element's own width, which is the
// band's; and both numbers it is computed from are set per tier on the same
// selector, so a narrower tier replaces its wider neighbour instead of adding to
// it. The media queries carry only the two numbers, and the rule that uses them
// is written once.
function buildCss(plans, margin) {
  if (!plans.length) return '';
  const out = [
    `.owl-carousel.${REVIVED_CLASS}{display:block!important;overflow:hidden!important;position:relative;}`,
    `.owl-carousel.${REVIVED_CLASS}>.pal-track{display:flex;flex-wrap:nowrap;align-items:stretch;}`,
    `.owl-carousel.${REVIVED_CLASS}>.pal-track>.owl-item{flex:0 0 calc(100%/var(--pal-n));max-width:calc(100%/var(--pal-n));box-sizing:border-box;min-width:0;}`,
    // The plugin's own structural contract, restated: owl's stylesheet puts
    // `position: relative` on its item wrappers, and in-slide content hangs
    // off it, a caption absolutely pinned to the slide's bottom edge, an
    // arrow centered on it. The wrappers here are rebuilt by hand, so the
    // contract has to be restated by hand too, or that content positions
    // against some distant ancestor and lands outside its picture (a banner
    // above the image instead of across its foot). Relative with no offsets
    // lays out exactly as before; it only fixes what `absolute` resolves
    // against. This names the plugin's structure, never any one site.
    `.owl-carousel.${REVIVED_CLASS}>.pal-track>.owl-item{position:relative;}`,
  ];
  if (margin > 0) {
    out.push(`.owl-carousel.${REVIVED_CLASS}>.pal-track>.owl-item{padding-right:${margin}px;}`);
  }

  for (const plan of plans) {
    const sel = `.owl-carousel[data-pal="${plan.index}"]`;
    // The widest tier is the one with no media query around it: a page whose
    // window is two slides across at every width gets one rule and nothing else.
    const base = plan.tiers[plan.tiers.length - 1];
    out.push(`${sel}{--pal-n:${base.items};--pal-shift:${base.shift};}`);
    out.push(`${sel}>.pal-track{transform:translateX(calc(-100% * var(--pal-shift) / var(--pal-n)));}`);
    for (let i = plan.tiers.length - 2; i >= 0; i--) {
      const tier = plan.tiers[i];
      out.push(`@media (max-width:${plan.tiers[i + 1].min - 1}px){${sel}{--pal-n:${tier.items};--pal-shift:${tier.shift};}}`);
    }
  }
  return out.join('\n');
}

// Undo a revival, so the plan can be made again from the page.
//
// This runs over every row an older revision prepared as well as over a fresh
// fetch, and the difference between rebuilding and skipping matters more than it
// looks. Skipping, which is what this did first, makes the plan a memory of
// the pass that wrote the row rather than a function of the page: revision 4
// wrote a window that landed two months off the slides the plugin showed, and
// because that pass had already marked the container as its own, re-preparing
// those rows left the bad geometry exactly where it was while reporting the row
// as repaired. Undoing first makes a change here reach every cached row, which is
// the whole reason the repair happens in place at all.
//
// The slide elements themselves are never touched, only the wrapper this file
// put around them, the index the stylesheet is scoped to, and the stylesheet.
// That is what makes the second pass byte-identical to the first rather than a
// wrapper around a wrapper; test/reviveWidgets.test.js holds it to that.
function unwrapRevival(doc) {
  // The wrappers first, and the order is the whole trick: the slides are inside
  // them, so taking the track apart without this moves a level of nesting up into
  // the container instead of removing it. That is not a cosmetic difference, the
  // anchor is found by looking for the slide that carries the marker's
  // `data-hash`, and a container holding wrappers rather than slides matches
  // nothing, so the window silently fell back to the first slide. The first
  // version of this did exactly that.
  for (const wrapper of Array.from(doc.querySelectorAll('.pal-track > .owl-item'))) {
    wrapper.replaceWith(...Array.from(wrapper.children));
  }
  // Then the track, which by now holds the slides themselves.
  for (const track of Array.from(doc.querySelectorAll('.pal-track'))) {
    track.replaceWith(...Array.from(track.children));
  }
  doc.querySelectorAll('.owl-carousel[data-pal]').forEach((box) => box.removeAttribute('data-pal'));
  doc.querySelectorAll(`#${REVIVE_STYLE_ID}`).forEach((n) => n.remove());
}

function reviveOwlCarousels(doc, cfg) {
  const plans = [];
  const boxes = Array.from(doc.querySelectorAll('.owl-carousel'));
  boxes.forEach((box) => {
    const plan = planCarousel(doc, box, cfg, plans.length);
    if (plan) plans.push(plan);
  });
  return plans;
}

function injectStyle(doc, css) {
  const head = doc.head || doc.querySelector('head');
  // One block per document, replaced rather than added: unwrapRevival removed the
  // previous one along with the wrappers it described, and this is the single new
  // copy. Nothing is skipped when there is no css, a document with no carousel
  // left in it must not keep a stylesheet written for one that was there before.
  if (!head || !css) return;
  const style = doc.createElement('style');
  style.setAttribute('id', REVIVE_STYLE_ID);
  style.textContent = css;
  head.appendChild(style);
}

/**
 * Revive what a capture needed a script to show.
 *
 * `rawHtml` is the document as the Archive served it, before anything here
 * touched it, the carousel's configuration only exists there. It is optional:
 * every row an older build already cached is re-prepared from the prepared form,
 * which has no script left in it, and the marker on the page says the same thing
 * the script did.
 */
function reviveWidgets(doc, { rawHtml, url, timestamp } = {}) {
  const capture = { url, timestamp };
  const cfg = readOwlConfig(rawHtml);
  const lazy = promoteLazyImages(doc, capture);
  unwrapRevival(doc);
  const plans = reviveOwlCarousels(doc, cfg);
  const margin = cfg && cfg.margin !== null ? cfg.margin : DEFAULT_MARGIN;
  injectStyle(doc, buildCss(plans, margin));
  return {
    lazyImages: lazy.promoted,
    lazySrcsets: lazy.srcsets,
    carousels: plans.length,
  };
}

module.exports = {
  reviveWidgets,
  readOwlConfig,
  REVIVE_STYLE_ID,
  REVIVED_CLASS,
};
