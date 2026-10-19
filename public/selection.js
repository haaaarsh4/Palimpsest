/* Selection helpers: the plain-language name of whatever changed, the box
   arithmetic a pick is judged against, and the slide a fragment link names.
   ---------------------------------------------------------------------------
   Two gaps this closes, both about the interface telling the truth:

   1. A tooltip that says "changed · <title>" with a before/after pair of
      tab texts means nothing to anyone who doesn't already know what a
      <title> is. describeElement() names the element the way a person
      would: the browser tab title, the main heading, a link, an image.

   2. A click on the edge of a marked box is a click on the change, not on
      the link under it, and the box a pick has to reach is the box the pane
      actually shows (isEdgeClick, computeCenteredScroll, canReachScroll,
      rectInPaneViewport), which is what makes a pick land instead of
      stopping next to the change.

   None of it touches a snapshot: the word "SELECTED" and the layer it is
   drawn in are the comparison's own chrome (see paneBadgeLayer in app.js).

   Pure DOM work with no app state, UMD so it runs in the browser and under
   test unchanged. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PdiffSelection = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The element in the tooltip header, named the way a person would name
  // it. Tags a reader will know (link, image, button, heading) get one
  // plain clause; page machinery a reader never sees (title, meta) gets
  // told where it actually appears.
  function describeElement(tag) {
    var t = String(tag || '').toLowerCase();
    switch (t) {
      case 'title':
        return 'The browser tab title. That is the text on the tab itself, not words on the page.';
      case 'meta':
        return 'A page setting in the document head. It never shows on the page itself.';
      case 'h1':
        return 'The page\u2019s main heading.';
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'A section heading on the page.';
      case 'p':
        return 'A paragraph of text.';
      case 'a':
        return 'A link.';
      case 'img':
        return 'An image.';
      case 'button':
        return 'A button.';
      case 'input':
      case 'textarea':
      case 'select':
        return 'A form field.';
      case 'option':
      case 'optgroup':
        return 'An option in a dropdown list. The dropdown itself is highlighted, since a closed list never shows its options.';
      case 'label':
        return 'A form label.';
      case 'li':
        return 'An item in a list.';
      case 'ul':
      case 'ol':
        return 'A list.';
      case 'table':
        return 'A table.';
      case 'td':
      case 'th':
        return 'A table cell.';
      case 'span':
        return 'A run of text.';
      case 'div':
        return 'A section of the page.';
      case 'iframe':
      case 'video':
      case 'audio':
        return 'Embedded media.';
      default:
        return t ? 'An <' + t + '> element on the page.' : 'An element on the page.';
    }
  }

  // Whether a click lands on the outline frame of a marked element rather
  // than its content. The change ring is drawn inside the element's own
  // box, so clicks on it hit the element itself (a link would navigate).
  // Pure over rects so it tests without a layout engine: rects are
  // {left, top, right, bottom, width, height} like getClientRects gives.
  // Tiny controls keep their native click: on a 16px icon nearly everything
  // is "edge", and navigating is what a person means there.
  function isEdgeClick(rects, x, y, zone) {
    var z = (zone == null ? 6 : zone);
    if (!rects || !rects.length) return false;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) continue;
      if (Math.min(r.width, r.height) < 24) continue;
      if (x - r.left <= z || r.right - x <= z || y - r.top <= z || r.bottom - y <= z) return true;
    }
    return false;
  }

  // Which change a pane click refers to, resolved for the side that was
  // clicked. Leaf ids are numbered per document, so "pdiff-9" names an
  // element in each snapshot: an id read off the later pane must only ever
  // match a change's new end, and one off the earlier pane only its old
  // end. Matching either end from either pane is how clicking an image in
  // one snapshot lights up a removed link in the other whose old id
  // happens to share the number. A falsy side keeps the old either-end
  // behavior for callers with no pane (the fullscreen modal resolves its
  // own side before calling).
  function paneChangeIndex(changes, id, side) {
    if (!changes || !id) return -1;
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (!c) continue;
      if (side === 'old') {
        if (c.oldId === id) return i;
      } else if (side === 'new') {
        if (c.newId === id) return i;
      } else if (c.oldId === id || c.newId === id) {
        return i;
      }
    }
    return -1;
  }

  // The element a selection should actually show for a marked node. An
  // <option> (or <optgroup>) inside a closed dropdown has no box of its
  // own: scrolling to it moves nothing and highlighting it lights nothing,
  // which reads as "clicking the row does nothing". The enclosing <select>
  // is the thing a person can see, so it is what gets scrolled to and lit.
  // Every other node shows itself. Pure structure, no site knowledge: any
  // site's dropdown options resolve the same way.
  function showTargetFor(node) {
    if (!node || node.nodeType !== 1) return node;
    var tag = String(node.tagName || '').toUpperCase();
    if (tag !== 'OPTION' && tag !== 'OPTGROUP') return node;
    try {
      var sel = node.closest ? node.closest('select') : null;
      if (sel) return sel;
    } catch (_) {
      // no closest (or a hostile DOM): the node itself still stands
    }
    return node;
  }

  // The ancestor breadcrumb of a live node, in exactly the format the diff
  // engine's buildPathContext writes into each change's `path` (up to three
  // ancestors, tag[#id][.class1.class2], joined with ' > '). Same format on
  // both sides is what makes a stored path comparable to a live node.
  function livePathOf(node, maxDepth) {
    var parts = [];
    var depth = 0;
    var max = (maxDepth == null ? 3 : maxDepth);
    var n = null;
    try {
      n = node ? node.parentElement : null;
    } catch (_) {
      return '';
    }
    while (n && n.tagName && String(n.tagName).toUpperCase() !== 'BODY' && depth < max) {
      var label = String(n.tagName).toLowerCase();
      try {
        if (n.id) {
          label += '#' + n.id;
        } else if (n.classList && n.classList.length) {
          var cls = [];
          try {
            cls = Array.prototype.slice.call(n.classList, 0, 2);
          } catch (_) {
            cls = [];
          }
          if (cls.length) label += '.' + cls.join('.');
        }
      } catch (_) {
        // unreadable ancestor: keep the bare tag
      }
      parts.unshift(label);
      try {
        n = n.parentElement;
      } catch (_) {
        break;
      }
      depth++;
    }
    return parts.join(' > ');
  }

  function idTokensOf(path) {
    var out = [];
    String(path || '').split('>').forEach(function (seg) {
      var m = /#([^.\s#]+)/.exec(seg);
      if (m) out.push(m[1].toLowerCase());
    });
    return out;
  }

  function classTokensOf(path) {
    var out = [];
    String(path || '').split('>').forEach(function (seg) {
      var dot = seg.indexOf('.');
      if (dot < 0) return;
      seg.slice(dot + 1).split('.')[0].split(/\s+/).forEach(function (c) {
        var clean = String(c || '').trim().toLowerCase();
        if (clean) out.push(clean);
      });
    });
    return out;
  }

  // Whether a visible candidate may stand in for a change as its "twin".
  // Non-duplicates keep the old behavior (any same-text node qualifies:
  // there is only one copy, so any visible copy is the element). For
  // duplicates the page repeats the same words in distinct containers (a
  // desktop nav and a responsive submenu both holding "News"), and a
  // text-only match lets every row resolve to whichever copy is visible
  // first, so two rows light the same box. There the candidate must live
  // in the same container: every #id in the stored path must appear in
  // the candidate's live path, else (no ids to go on) at least one class
  // token must be shared. Bare-tag paths with nothing distinctive accept,
  // since there is nothing to distinguish with.
  function twinAccepts(changePath, candidatePath, duplicate) {
    if (!duplicate) return true;
    var want = String(changePath || '');
    var got = String(candidatePath || '');
    if (!want || !got) return false;
    if (want === got) return true;
    var wantIds = idTokensOf(want);
    if (wantIds.length) {
      var gotLower = got.toLowerCase();
      for (var i = 0; i < wantIds.length; i++) {
        if (gotLower.indexOf('#' + wantIds[i]) < 0) return false;
      }
      return true;
    }
    var wantCls = classTokensOf(want);
    if (!wantCls.length) return true;
    var gotCls = classTokensOf(got);
    for (var j = 0; j < wantCls.length; j++) {
      if (gotCls.indexOf(wantCls[j]) >= 0) return true;
    }
    return false;
  }

  // Center math for scrolling a node into view inside its own scroller,
  // pure numbers so it tests without a layout engine. scrollPos is where
  // the scroller is now, targetStart/targetSize the node's rect edge and
  // extent along one axis, viewSize the scroller's visible extent. The
  // answer centers the node, clamped at zero: a node already above the top
  // never asks for a negative scroll.
  function computeCenteredScroll(scrollPos, targetStart, boxStart, targetSize, viewSize) {
    var spare = Math.max(0, viewSize / 2 - targetSize / 2);
    return Math.max(0, scrollPos + (targetStart - boxStart) - spare);
  }

  // Whether a scroller can actually express a scroll position: a nested
  // clipping box (a carousel viewport, a panel) happily accepts scrollTo
  // and clamps it to its own tiny range, silently swallowing a scroll meant
  // for the page. Only a box whose range reaches the target may carry it.
  function canReachScroll(scrollHeight, clientHeight, top) {
    return top <= Math.max(0, scrollHeight - clientHeight) + 1;
  }

  // Whether a measured rect is on screen inside its pane viewport. Pure
  // numbers, same reason as above. A zero-area rect is never "in view":
  // there is no position to see it at.
  //
  // "Visible" means a real sliver of it, not an overlap counted from forty
  // pixels outside the frame. The old test asked whether the rect reached
  // within 40px of the viewport, so a change sitting twenty-five pixels
  // below the fold - its badge and its first line under the fold - answered
  // yes: the scroll watch stopped correcting and the row read as picked with
  // nothing visible to show for it (measured on apple.com's card grid, a
  // 130x82 picture at 722 in a 697-tall pane). The handful of pixels below
  // is the tolerance, and it is deliberately smaller than one line of text.
  function rectInPaneViewport(rect, viewWidth, viewHeight, sliver) {
    if (!rect || !(rect.width || rect.height)) return false;
    var least = (sliver == null ? 6 : sliver);
    var seenY = Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0);
    var seenX = Math.min(rect.right, viewWidth) - Math.max(rect.left, 0);
    return seenY >= Math.min(least, rect.height) && seenX >= Math.min(least, rect.width);
  }

  // A month strip under a revived carousel - Apr, May, Jun… each one a link
  // to a slide's `data-hash` - is a link to a spot in the page, not to
  // another page. The archived page's own plugin listens for the hash and
  // slides the band; scripts do not run in a pane, so the two numbers the
  // band was laid out with are moved instead: how many slides are across,
  // and which one sits at the left edge. The band then slides the way it
  // does on the live site, in place, with no reload.
  //
  // The picked month also takes the `currentmonth` the page drew on the
  // month it started at (the same mark lib/reviveWidgets.js reads to place
  // the band at capture time), so the strip shows where the reader is
  // instead of staying on the month the capture happened to open at.
  //
  // Returns true only when a band actually moved: the caller keeps the
  // browser's native in-page jump for every other `#name`.
  function slideCarouselTo(doc, hash) {
    if (!doc || !hash) return false;
    var slide = null;
    var box = null;
    try {
      slide = doc.querySelector('.owl-carousel .item[data-hash="' + hash + '"]');
      if (!slide) return false;
      box = slide.closest('.owl-carousel');
    } catch (_) {
      return false;
    }
    if (!box) return false;
    if (!moveCarouselToNode(slide)) return false;
    try {
      var nav = box.parentElement ? box.parentElement.querySelectorAll('a[href^="#"]') : [];
      Array.prototype.forEach.call(nav, function (a) {
        var on = a.getAttribute('href') === '#' + hash;
        try { a.classList.toggle('current', on); } catch (_) { /* strip is optional */ }
        Array.prototype.forEach.call(a.querySelectorAll('*'), function (child) {
          if (child.classList) child.classList.toggle('currentmonth', on);
        });
      });
    } catch (_) { /* the band still moved */ }
    return true;
  }

  // Keeps a hash-addressed strip (Apr, May, Jun...) in step with the band: the
  // picked month takes the `current` the page draws on the one it opened at,
  // and the `currentmonth` its contents carry, so the strip does not point at
  // a month the band is not showing. Returns the undo.
  function markStripCurrent(box, hash) {
    if (!box || !hash) return null;
    var saved = [];
    var nav = [];
    try {
      nav = box.parentElement ? box.parentElement.querySelectorAll('a[href^="#"]') : [];
    } catch (_) {
      return null;
    }
    Array.prototype.forEach.call(nav, function (a) {
      var on = a.getAttribute('href') === '#' + hash;
      try {
        saved.push({ node: a, cls: 'current', had: a.classList.contains('current') });
        a.classList.toggle('current', on);
      } catch (_) { /* the band still moved */ }
      Array.prototype.forEach.call(a.querySelectorAll('*'), function (child) {
        if (!child.classList) return;
        try {
          saved.push({ node: child, cls: 'currentmonth', had: child.classList.contains('currentmonth') });
          child.classList.toggle('currentmonth', on);
        } catch (_) { /* that item still moved */ }
      });
    });
    if (!saved.length) return null;
    return function () {
      saved.forEach(function (s) {
        try { s.node.classList.toggle(s.cls, s.had); } catch (_) { /* pane gone */ }
      });
    };
  }

  // Moves the band so the slide that CONTAINS `node` sits in the window,
  // centred the way the plugin centres it, and hands back the undo.
  //
  // Whole slides are moved, by index. Aligning the node's own left edge to
  // the band's left edge is what slid a picked card half out of frame: a
  // caption is inset inside its picture, so aligning the caption moved the
  // picture off the left edge - the words started mid-sentence and the card
  // read as broken, while the same card picked by its picture looked right.
  // A slide is the unit the band is built from, so a slide is what moves.
  //
  // Returns null when there is no band, no matching slide, or no window to
  // read (the caller then falls back to its own measurement).
  function moveCarouselToNode(node, opts) {
    if (!node || !node.closest) return null;
    var track = null;
    var box = null;
    try {
      track = node.closest('.pal-track');
      box = track ? node.closest('.owl-carousel') : null;
    } catch (_) {
      track = null;
      box = null;
    }
    if (!track || !box) return null;
    var items = Array.prototype.filter.call(track.children, function (el) {
      return el.classList && el.classList.contains('owl-item');
    });
    if (!items.length) return null;
    var index = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].contains(node)) { index = i; break; }
    }
    if (index < 0) return null;
    // How many slides are across right now, read off the custom property the
    // capture's stylesheet wrote per breakpoint. An unreadable number means
    // one slide across, which is the safe window for a phone.
    var visible = 1;
    try {
      var n = parseFloat(box.ownerDocument.defaultView.getComputedStyle(box).getPropertyValue('--pal-n'));
      if (n > 0) visible = Math.min(Math.round(n), items.length);
    } catch (_) {
      visible = 1;
    }
    // The picked slide is centred the way the plugin centres it, then pulled
    // back inside the run at either end - the same arithmetic as shiftFor()
    // in lib/reviveWidgets.js, which placed the band at capture time.
    var shift = Math.max(0, Math.min(items.length - visible, index - Math.floor((visible - 1) / 2)));
    var before = { transform: track.style.transform || '', transition: track.style.transition || '', active: [] };
    items.forEach(function (w) {
      before.active.push({
        node: w,
        active: !!(w.classList && w.classList.contains('active')),
        center: !!(w.classList && w.classList.contains('center')),
      });
    });
    // A selection reads the target's box immediately after the move, so that
    // call passes `instant`: with the 0.35s ease still running the band is
    // measured at its old place and the change still looks parked. The month
    // strip keeps the glide, because nothing is measured there.
    var instant = !!(opts && opts.instant);
    try {
      track.style.transition = instant ? 'none' : 'transform 0.35s ease';
      track.style.transform = 'translateX(calc(-100% * ' + shift + ' / ' + visible + '))';
    } catch (_) {
      return null;
    }
    items.forEach(function (w, at) {
      try {
        w.classList.toggle('active', at >= shift && at < shift + visible);
        w.classList.toggle('center', at === index);
      } catch (_) { /* a wrapper that cannot take a class still moves */ }
    });
    // The strip the band is navigated by follows the slide that was picked.
    var hash = '';
    try {
      var named = items[index].querySelector('[data-hash]');
      hash = (named && named.getAttribute('data-hash')) || items[index].getAttribute('data-hash') || '';
    } catch (_) { hash = ''; }
    var undoStrip = null;
    try { undoStrip = markStripCurrent(box, hash); } catch (_) { undoStrip = null; }
    return {
      undo: function () {
        try {
          track.style.transform = before.transform;
          if (before.transition) track.style.transition = before.transition;
          else track.style.removeProperty('transition');
        } catch (_) { /* pane gone */ }
        before.active.forEach(function (p) {
          try {
            p.node.classList.toggle('active', p.active);
            p.node.classList.toggle('center', p.center);
          } catch (_) { /* pane gone */ }
        });
        try { if (undoStrip) undoStrip(); } catch (_) { /* strip is optional */ }
      },
    };
  }

  return {
    computeCenteredScroll: computeCenteredScroll,
    canReachScroll: canReachScroll,
    rectInPaneViewport: rectInPaneViewport,
    describeElement: describeElement,
    isEdgeClick: isEdgeClick,
    paneChangeIndex: paneChangeIndex,
    showTargetFor: showTargetFor,
    slideCarouselTo: slideCarouselTo,
    moveCarouselToNode: moveCarouselToNode,
    livePathOf: livePathOf,
    twinAccepts: twinAccepts,
  };
}));
