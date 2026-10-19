/* The reveal engine: how a hidden element is *exactly* revealed, and the live
   performance of it.
   ---------------------------------------------------------------------------
   The changes list is full of things that are in the document but invisible
   in the pane: dropdown items (like the newer snapshot's Search link sitting
   in `ul#sub-nav`), mobile drawers, modals, tab panels. Saying "hidden by
   CSS, probably needs a click" is a guess, and a guess is useless the moment
   someone needs to actually see the thing. So this module answers the exact
   question, from the live document, in three parts:

     1. WHAT HIDES IT: the nearest ancestor-or-self whose computed style is
        display:none / visibility:hidden / ~zero opacity, plus the exact
        stylesheet rule that says so (selector text, declaration, and any
        @media condition), found by searching the pane's own stylesheets.

     2. WHAT REVEALS IT: the exact counterpart rule. Pages that hide things
        with CSS reveal them with CSS, and the reveal rule is almost always
        shaped like the hiding rule plus an interaction: `li:hover ul`,
        `.modal.open`, `details[open]`, `:focus-within`. We find rules whose
        selector is the hiding shape plus an interactive pseudo or a state
        class, whose base still matches the hidden node, and which set a
        visibility-affecting declaration. No match means the reveal is
        JavaScript-driven (the site's scripts are stripped here, so no rule
        could exist), and we say exactly that instead of guessing.

     3. DOING IT LIVE: applying the reveal rule's *own declarations* as
        inline !important styles on the hidden node. That is precisely what
        the browser would compute if the interaction happened
        (`li:hover ul#sub-nav { display: block }` becomes display:block on
        that ul), so the pane shows exactly what changes and nothing else.
        Only when no reveal rule exists do we fall back to a generic
        display/visibility override, and we label it as such.

   Everything here is pure DOM-and-CSSOM work, which is why it lives in its
   own file: it runs in the browser against the live panes, and it runs in
   node under test against jsdom with no changes. UMD wrapper for exactly
   that reason: a browser global here, a module in test. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PdiffReveal = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_WALK_DEPTH = 14;

  // Interactive pseudos: states a real pointer/keyboard can put an element
  // in. :visited and :target are included because pages do use them to show
  // things; anything else (structural, functional) is not an interaction.
  var INTERACTIVE_PSEUDO_RE = /::?(hover|focus|focus-within|focus-visible|active|visited|target)\b/gi;

  // State classes by which pages toggle visibility. Open/expanded first
  // because they are unambiguous; bare .active/.on/.show last because they
  // also mean "currently selected tab" and friends, so they only count when
  // the rule actually sets a visibility-affecting declaration (enforced by
  // the caller, not by this regex alone).
  var STATE_CLASS_RE = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
  var STATE_CLASS_NAMES = [
    'open', 'opened', 'expanded', 'expand', 'visible', 'shown', 'show',
    'active', 'activated', 'selected', 'on', 'in', 'drop', 'dropped',
    'toggled', 'expanded',
  ];

  // Declarations that can take something from hidden to shown. display and
  // visibility are the honest pair; opacity/height/clip are the animated
  // equivalents (a menu that fades or slides in hides with these instead).
  var REVEAL_PROPS = ['display', 'visibility', 'opacity', 'max-height', 'height', 'clip-path', 'clip', 'transform'];

  function shortDescribe(node) {
    if (!node || node.nodeType !== 1) return '';
    var label = node.tagName.toLowerCase();
    if (node.id) return label + '#' + node.id;
    var cls = node.className && node.className.toString ? node.className.toString().trim().split(/\s+/) : [];
    if (cls.length) label += '.' + cls.slice(0, 2).join('.');
    return label;
  }

  function labelOf(node) {
    if (!node || node.nodeType !== 1) return null;
    var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 40) : null;
  }

  // ---- 1. What hides it ---------------------------------------------------

  // The computed-style truth about one node: how it is hidden, or null when
  // it isn't. opacity is a threshold because fades rest at 0, not near it.
  function hiddenCause(win, node) {
    var cs;
    try {
      cs = win.getComputedStyle(node);
    } catch (_) {
      return null;
    }
    if (!cs) return null;
    if (cs.display === 'none') return { prop: 'display', value: 'none' };
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return { prop: 'visibility', value: cs.visibility };
    var opacity = parseFloat(cs.opacity);
    if (!isNaN(opacity) && opacity < 0.05) return { prop: 'opacity', value: cs.opacity };
    return null;
  }

  // The node whose hiding must actually be beaten, with how it is hidden.
  // display:none sits where it sits (display is not inherited: a child of a
  // display:none parent still computes its own display), so the first hit is
  // the setter. visibility and opacity ARE inherited: a hidden link inside a
  // hidden submenu computes hidden without any rule touching the link, and
  // naming the link would point the reveal at the wrong box. So for those,
  // the walk climbs the unbroken hidden chain to the topmost hidden node  
  // the one that sets it, whose parent is visible. Measured on a real
  // dropdown: the Search link inherits visibility:hidden through
  // li.item-primary from ul#sub-nav, which carries `.sub { visibility:
  // hidden }`; only the ul is a useful answer.
  function findHiddenNode(win, target) {
    // Every hidden node up the chain, topmost wins: it is the setter the
    // reveal must beat first. (A visibility-hidden link inside a
    // display:none drawer is hidden twice; naming the link would point the
    // reveal at the wrong box, and revealing the link while the drawer
    // stays shut changes nothing visible.) Children of a display:none
    // parent keep scanning rather than breaking: display is not inherited,
    // so they compute "visible" while showing nothing.
    var node = target;
    var depth = 0;
    var hit = null;
    while (node && node.nodeType === 1 && depth < MAX_WALK_DEPTH) {
      var cause = null;
      try {
        cause = hiddenCause(win, node);
      } catch (_) {
        cause = null;
      }
      if (cause) hit = { node: node, cause: cause, depth: depth };
      node = node.parentElement;
      depth++;
    }
    if (!hit) return null;
    hit.onSelf = hit.node === target;
    return hit;
  }

  // ---- Rule plumbing ------------------------------------------------------

  // Every style rule in the document as flat {selectorText, style,
  // mediaText, cssText, href} records, recursing into @media. Stylesheets
  // the browser won't let us read (cross-origin without CORS) throw on
  // access and are skipped here; the caller passes already-proxied
  // equivalents as extraLists, either bare rule lists or {list, href}
  // pairs. href is the stylesheet's own address: relative url()s inside a
  // cloned rule mean nothing without it (see cloneCssForSim).
  function collectRules(doc, extraLists) {
    var out = [];
    var pushFrom = function (rules, mediaText, href) {
      if (!rules) return;
      var list = null;
      try {
        list = Array.from(rules);
      } catch (_) {
        return;
      }
      list.forEach(function (rule) {
        var type = rule.type;
        // 4 is MEDIA_RULE everywhere; comparing against the CSSRule constant
        // when available keeps this honest across environments.
        var MEDIA = (typeof CSSRule !== 'undefined' && CSSRule.MEDIA_RULE) || 4;
        if (type === MEDIA) {
          var media = '';
          try {
            media = rule.media ? rule.media.mediaText : '';
          } catch (_) {
            media = '';
          }
          var combined = mediaText ? mediaText + ' and ' + media : media;
          var inner = null;
          try {
            inner = rule.cssRules;
          } catch (_) {
            inner = null;
          }
          pushFrom(inner, combined, href);
        } else if (rule.selectorText && rule.style) {
          // cssText carries the rule's FULL declarations (backgrounds,
          // colors, borders, everything the hover state restyles), not
          // just the visibility pair. The reveal needs the whole rule to
          // restage a hover exactly; see cloneCssForSim below.
          var full = '';
          try {
            full = rule.cssText || '';
          } catch (_) {
            full = '';
          }
          out.push({ selectorText: rule.selectorText, style: rule.style, mediaText: mediaText || '', cssText: full, href: href || '' });
        }
      });
    };
    try {
      Array.from(doc.styleSheets || []).forEach(function (sheet) {
        var rules = null;
        try {
          rules = sheet.cssRules;
        } catch (_) {
          rules = null; // blocked cross-origin sheet: caller-supplied lists cover it
        }
        var href = '';
        try {
          href = sheet.href || '';
        } catch (_) {
          href = '';
        }
        pushFrom(rules, '', href);
      });
    } catch (_) {
      // a document with no readable sheets at all still gets extraLists
    }
    (extraLists || []).forEach(function (entry) {
      if (entry && entry.list) pushFrom(entry.list, '', entry.href || '');
      else pushFrom(entry, '');
    });
    return out;
  }

  function ruleDeclares(rule, prop) {
    try {
      return rule.style.getPropertyValue(prop) || '';
    } catch (_) {
      return '';
    }
  }

  function declarationText(rule, prop) {
    var v = ruleDeclares(rule, prop);
    return v ? prop + ': ' + v : '';
  }

  // The exact rule hiding this node: the first stylesheet rule that matches
  // it and sets display:none or visibility:hidden. First, because the
  // cascade's winner is what the computed style already reflects; we only
  // need one rule worth naming, the one a person would open devtools to.
  function hidingRule(doc, node, extraLists) {
    var rules = collectRules(doc, extraLists);
    // Whether an @media condition holds right now, asked of the pane's own
    // window. A selector match alone is not enough: a display:none rule
    // inside a max-width block that does not currently match never hides
    // anything, and naming it is how a visible element got blamed on a rule
    // that cannot apply, was flagged viewport-gated, and was then refused
    // and widened for no reason. Untestable environments (no matchMedia)
    // keep the old behavior rather than dropping every conditioned rule.
    var mediaMatches = function (mediaText) {
      if (!mediaText) return true;
      try {
        var w = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
        if (!w || typeof w.matchMedia !== 'function') return true;
        return !!w.matchMedia(mediaText).matches;
      } catch (_) {
        return true;
      }
    };
    for (var i = 0; i < rules.length; i++) {
      var matches = false;
      try {
        matches = node.matches(rules[i].selectorText);
      } catch (_) {
        matches = false; // selector the engine can't parse: skip, never crash
      }
      if (!matches) continue;
      if (!mediaMatches(rules[i].mediaText)) continue;
      if (ruleDeclares(rules[i], 'display') === 'none') {
        return { selectorText: rules[i].selectorText, declaration: 'display: none', mediaText: rules[i].mediaText };
      }
      var vis = ruleDeclares(rules[i], 'visibility');
      if (vis === 'hidden' || vis === 'collapse') {
        return { selectorText: rules[i].selectorText, declaration: 'visibility: ' + vis, mediaText: rules[i].mediaText };
      }
    }
    return null;
  }

  // ---- 2. What reveals it --------------------------------------------------

  // The selector with every interactive pseudo removed: `li.top:hover >
  // ul#sub-nav` becomes `li.top > ul#sub-nav`. When the base matches the
  // hidden node, the full selector is the same shape plus an interaction,
  // which is exactly the reveal counterpart we are looking for.
  function stripInteractive(selector) {
    return (selector || '').replace(INTERACTIVE_PSEUDO_RE, '').replace(/\s+/g, ' ').trim();
  }

  function hasInteractivePseudo(selector) {
    INTERACTIVE_PSEUDO_RE.lastIndex = 0;
    return INTERACTIVE_PSEUDO_RE.test(selector || '');
  }

  function stateClassesIn(selector) {
    var found = [];
    var m;
    STATE_CLASS_RE.lastIndex = 0;
    var s = selector || '';
    while ((m = STATE_CLASS_RE.exec(s)) !== null) {
      var name = m[1].toLowerCase();
      if (STATE_CLASS_NAMES.indexOf(name) !== -1 && found.indexOf(name) === -1) found.push(name);
    }
    return found;
  }

  function setsRevealDeclaration(rule) {
    for (var i = 0; i < REVEAL_PROPS.length; i++) {
      var v = ruleDeclares(rule, REVEAL_PROPS[i]);
      if (!v) continue;
      if (REVEAL_PROPS[i] === 'display' && v === 'none') continue;
      if (REVEAL_PROPS[i] === 'visibility' && (v === 'hidden' || v === 'collapse')) continue;
      if (REVEAL_PROPS[i] === 'opacity' && parseFloat(v) < 0.05) continue;
      return true;
    }
    return false;
  }

  // The human half of a selector: which element the person touches. For
  // `li.top:hover > ul#sub-nav` that is the li.top: the ancestor of the
  // hidden node that the pre-interaction part of the selector names. We
  // find it by testing each ancestor against the selector's context (the
  // full selector minus its last compound, pseudos stripped); when that
  // fails we fall back to the nearest trigger-like sibling control.
  // A state class is the page's way of saying "not yet": `.modal.open`
  // names the same box as `.modal`, only after the interaction. Stripping
  // the state classes answers "which box does this rule reveal" so the
  // base can match the hidden node as it is right now.
  function stripStateClasses(selector) {
    var s = selector || '';
    STATE_CLASS_NAMES.forEach(function (name) {
      s = s.replace(new RegExp('\\.' + name + '(?![_a-zA-Z0-9-])', 'gi'), '');
    });
    return s.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ').trim();
  }

  function triggerFor(hiddenNode, selector) {
    var doc = hiddenNode.ownerDocument;
    var base = stripInteractive(selector);
    // Split off the last compound (the part naming the hidden node itself);
    // what remains is the context the interaction happens in.
    var parts = base.split(/[\s>+~]+/).filter(Boolean);
    var contextParts = parts.slice(0, -1);
    if (contextParts.length && doc) {
      var node = hiddenNode.parentElement;
      var guard = 0;
      while (node && node.nodeType === 1 && guard < 8) {
        for (var i = 0; i < contextParts.length; i++) {
          var simple = contextParts[i].replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
          if (!simple) continue;
          var matches = false;
          try {
            matches = node.matches(simple);
          } catch (_) {
            matches = false;
          }
          // The context names the container (li.top), but the person
          // touches its control (the Services link inside it), so name the
          // control: the whole subtree's text would read "Services Search"
          // and point at two things at once.
          if (matches) {
            var control = triggerControlWithin(node, hiddenNode);
            if (control) return control;
            return { node: node, label: labelOf(node), desc: shortDescribe(node) };
          }
        }
        node = node.parentElement;
        guard++;
      }
    }
    return siblingTrigger(hiddenNode);
  }

  // The classic shape: <li><a>Services</a><ul id="sub-nav">…, a trigger
  // element with visible text sitting next to the hidden container under
  // the same parent. Searches the hidden node's parent, then one level up.
  // The clickable thing inside a container that is not the hidden content
  // itself: the first link/button/summary that doesn't contain the hidden
  // node and has visible text. `li.top` holds `a[Services]` this way.
  function triggerControlWithin(container, hiddenNode) {
    var els = null;
    try {
      els = container.querySelectorAll('a, button, summary, [aria-haspopup], [data-toggle]');
    } catch (_) {
      return null;
    }
    for (var i = 0; i < els.length; i++) {
      var kid = els[i];
      if (kid === hiddenNode || (kid.contains && kid.contains(hiddenNode))) continue;
      var label = labelOf(kid);
      if (label) return { node: kid, label: label, desc: shortDescribe(kid) };
    }
    return null;
  }

  function siblingTrigger(hiddenNode) {
    var levels = [hiddenNode.parentElement, hiddenNode.parentElement && hiddenNode.parentElement.parentElement];
    for (var l = 0; l < levels.length; l++) {
      var parent = levels[l];
      if (!parent) continue;
      var kids = Array.from(parent.children || []);
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (kid === hiddenNode || kid.contains(hiddenNode)) continue;
        if (!/^(a|button|summary)$/i.test(kid.tagName)) continue;
        var label = labelOf(kid);
        if (label) return { node: kid, label: label, desc: shortDescribe(kid) };
      }
    }
    return null;
  }

  function interactionWord(selector, states) {
    var s = selector || '';
    if (/:\s*hover/i.test(s) || /hover/i.test(s)) {
      var m = s.match(/([^\s>+~,]+):hover/i);
      return { verb: 'hovering', over: m ? m[1] : null };
    }
    if (/focus-within/i.test(s)) return { verb: 'focusing inside', over: null };
    if (/focus/i.test(s)) return { verb: 'focusing', over: null };
    if (/:active/i.test(s)) return { verb: 'pressing', over: null };
    if (states.length) return { verb: 'activating', over: null, state: states[0] };
    return { verb: 'interacting with', over: null };
  }

  // Every rule that could reveal this node, best first: an interactive
  // pseudo whose base matches beats a bare state class (hover is a real
  // interaction; .open only counts because the rule sets a revealing
  // declaration), and a display/visibility declaration beats opacity/size.
  function revealCandidates(doc, hiddenNode, extraLists) {
    var rules = collectRules(doc, extraLists);
    var found = [];
    for (var i = 0; i < rules.length; i++) {
      var sel = rules[i].selectorText;
      var interactive = hasInteractivePseudo(sel);
      var states = stateClassesIn(sel);
      if (!interactive && !states.length) continue;
      if (!setsRevealDeclaration(rules[i])) continue;
      var base = stripInteractive(sel);
      var matches = false;
      try {
        matches = hiddenNode.matches(base);
      } catch (_) {
        matches = false;
      }
      // State-class rules never match the node as it stands (the class is
      // the interaction's product, e.g. `.modal.open` on a plain `.modal`),
      // so test the shape with the state removed too.
      if (!matches && states.length) {
        try {
          matches = hiddenNode.matches(stripStateClasses(base));
        } catch (_) {
          matches = false;
        }
      }
      if (!matches) continue;
      var decls = [];
      REVEAL_PROPS.forEach(function (p) {
        var d = declarationText(rules[i], p);
        if (d) decls.push(d);
      });
      // A state class that merely restates the hiding (`.x.collapsed {
      // display:none }`) is not a reveal; drop it.
      var undoesHiding = decls.some(function (d) {
        return (/^display:\s*(block|flex|grid|inline|inline-block|list-item|table|contents)/i.test(d) ||
          /^visibility:\s*visible/i.test(d) ||
          /^opacity:\s*1/i.test(d) ||
          /^max-height:\s*[^0]/i.test(d));
      });
      var score = (interactive ? 10 : 0) + (undoesHiding ? 5 : 0) +
        (/^display:/i.test(decls[0] || '') ? 2 : 0);
      found.push({
        selectorText: sel,
        declarations: decls,
        mediaText: rules[i].mediaText,
        interactive: interactive,
        states: states,
        undoesHiding: undoesHiding,
        trigger: triggerFor(hiddenNode, sel),
        score: score,
      });
    }
    found.sort(function (a, b) { return b.score - a.score; });
    return found;
  }

  // One analysis: everything the interface needs to explain AND perform.
  // extraLists are proxied cross-origin rule lists (see hydrateBlocked
  // Stylesheets in app.js); win defaults to the document's own window.
  function analyze(doc, target, extraLists, win) {
    var w = win || (doc && doc.defaultView);
    if (!doc || !w || !target) return { visible: true };
    var hidden = findHiddenNode(w, target);
    if (!hidden) {
      // Zero size alone is not hiddenness: empty spans and layout without a
      // box engine (jsdom, print) all measure 0×0. It only means
      // "deliberately visually hidden" with the screen-reader-only
      // fingerprint: taken out of flow and clipped to ~nothing.
      var rect = null;
      var csZero = null;
      try {
        rect = target.getBoundingClientRect();
        csZero = w.getComputedStyle(target);
      } catch (_) {
        rect = null;
      }
      if (rect && (rect.width === 0 || rect.height === 0) && csZero) {
        var ww = parseFloat(csZero.width) || 0;
        var hh = parseFloat(csZero.height) || 0;
        // clip-path reads 'none' in browsers but '' where there is no box
        // engine; only a real value means clipped.
        var clipped = /rect\(/.test(csZero.clip || '') || (!!csZero.clipPath && csZero.clipPath !== 'none');
        if ((csZero.position === 'absolute' && ww <= 1 && hh <= 1) || clipped) {
          return {
            visible: false,
            hiddenNode: target,
            onSelf: true,
            cause: { prop: 'zero-size', value: '0×0' },
            hidingRule: null,
            candidates: [],
            note: 'Renders at zero size. Typical of a screen reader only label, not a breakpoint.',
          };
        }
      }
      return { visible: true };
    }
    var hide = hidingRule(doc, hidden.node, extraLists);
    var candidates = revealCandidates(doc, hidden.node, extraLists);
    var paneWidth = null;
    try {
      if (w && typeof w.innerWidth === 'number') paneWidth = Math.round(w.innerWidth);
    } catch (_) {
      paneWidth = null;
    }
    var result = {
      visible: false,
      extraLists: extraLists || [],
      responsive: !!(hide && hide.mediaText),
      paneWidth: paneWidth,
      // The marked node itself, not just the ancestor whose rule hides it:
      // a generic reveal has to clear the whole path between the two (see
      // clearHiddenPath), and the caller needs to know where it ends.
      target: target,
      hiddenNode: hidden.node,
      hiddenDesc: shortDescribe(hidden.node),
      onSelf: hidden.onSelf,
      cause: hidden.cause,
      hidingRule: hide,
      candidates: candidates,
      best: candidates[0] || null,
      note: null,
    };
    if (!hide && !candidates.length) {
      var inline = '';
      try {
        inline = hidden.node.getAttribute('style') || '';
      } catch (_) {
        inline = '';
      }
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(inline)) {
        result.note = 'Hidden by an inline style (style="' + inline.trim() +
          '"), not a stylesheet rule. Likely toggled by JavaScript rather than screen width.';
      }
    }
    return result;
  }

  // ---- 3. Doing it live --------------------------------------------------------

  // Applies the analysis in two layers. The visibility pair from the best
  // reveal rule becomes inline !important styles on the hidden node, as
  // before, that alone makes the node appear. But appearing is not the
  // same as looking right: on a real hover the page also restyles the
  // node and everything inside it (the green dropdown background, the
  // white item text, the item borders all live under `li:hover`-qualified
  // rules), and none of those selectors match without the hover. So when
  // the reveal is interaction-driven, a second layer restages the
  // interaction itself (see simulateInteraction below) instead of leaving
  // the node visibly unstyled. Returns an undo function plus a report of
  // the computed change (display: none → block), so the interface can say
  // precisely what changed, truthfully.
  // The marker class a simulated interaction wears. Cloned hover rules
  // name it where the original named :hover/:focus/:active, so they match
  // exactly the elements a real pointer would put in that state, and
  // nothing else on the page, which keeps the rest of the snapshot
  // pixel-identical to the archive.
  var SIM_CLASS = 'pdiff-sim-hover';

  function compoundsOf(selector) {
    return String(selector || '').split(/[\s>+~]+/).filter(Boolean);
  }

  // Every interactive rule restyling the hidden node or anything inside
  // it: the best candidate opens the menu, but the item colors, borders
  // and backgrounds live in sibling rules under the same hover (e.g.
  // `.menu li:hover .sub li a`), and restaging only the opener is what
  // leaves a correctly-placed but ghost-white dropdown. The stripped
  // selector is tested against the live DOM, so scoping stays exact.
  function hoverCompanionRules(doc, hiddenNode, extraLists) {
    var rules = collectRules(doc, extraLists);
    var pool = [hiddenNode];
    try {
      pool = pool.concat(Array.from(hiddenNode.querySelectorAll('*')).slice(0, 80));
    } catch (_) {
      // a node that cannot be walked still gets its own rule cloned
    }
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      INTERACTIVE_PSEUDO_RE.lastIndex = 0;
      if (!INTERACTIVE_PSEUDO_RE.test(rules[i].selectorText)) continue;
      var stripped = stripInteractive(rules[i].selectorText);
      if (!stripped) continue;
      for (var j = 0; j < pool.length; j++) {
        var hit = false;
        try {
          hit = pool[j].matches(stripped);
        } catch (_) {
          hit = false;
        }
        if (hit) {
          out.push(rules[i]);
          break;
        }
      }
    }
    return out;
  }

  // A url() inside a cloned rule, made absolute against the stylesheet it
  // came from. Clones live in an injected <style>, whose base is the
  // document (for srcdoc panes: this app's own origin), while the
  // original resolved against its stylesheet's address. Without this a
  // relative background-image 404s against us and the menu opens with no
  // background at all. Absolute, data:, and fragment URLs pass through.
  function absolutizeUrlsInCss(css, baseHref) {
    if (!css || !baseHref) return css;
    return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, u) {
      var url = String(u || '').trim();
      if (!url || /^data:/i.test(url) || /^#/i.test(url)) return m;
      if (/^https?:\/\//i.test(url)) return m;
      var abs = url;
      try {
        abs = new URL(url, baseHref).href;
      } catch (_) {
        return m;
      }
      return 'url("' + abs + '")';
    });
  }

  // A rule's selector list, split at top-level commas only: `a:hover, a:link`
  // is two selectors, the comma inside `:not(a, b)` is not a split.
  function selectorParts(selectorText) {
    var text = String(selectorText || '');
    var parts = [];
    var depth = 0;
    var buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        parts.push(buf);
        buf = '';
      } else {
        buf += ch;
      }
    }
    parts.push(buf);
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }

  // Only the selectors in a list that are actually an interaction. A clone
  // restages the hover, not the page: `a:hover, a:link` must contribute
  // `a.pdiff-sim-hover` alone, never a bare `a` or `a:link` that would
  // restyle every link on the page. (That leak took the white background and
  // arrow off the CTAs of settlement.org's 2015 hero: the page's own
  // `a:link, a:hover` rule came back as a global `a:link` with higher
  // specificity than `.btn-cta`.)
  function interactiveSelectorParts(selectorText) {
    return selectorParts(selectorText).filter(function (part) {
      INTERACTIVE_PSEUDO_RE.lastIndex = 0;
      return INTERACTIVE_PSEUDO_RE.test(part);
    });
  }

  // The clone text for those rules: same declarations in full, only the
  // interactive pseudos renamed to the marker class. Equal specificity to
  // the originals (a class weighs what :hover weighs), injected after the
  // page's own stylesheets, so they win exactly where the hover would.
  // @media conditions ride along unchanged.
  function cloneCssForSim(rules) {
    return rules.map(function (r) {
      var simSel = '';
      try {
        simSel = interactiveSelectorParts(r.selectorText).map(function (part) {
          return part.replace(INTERACTIVE_PSEUDO_RE, '.' + SIM_CLASS);
        }).join(', ');
      } catch (_) {
        return '';
      }
      if (!simSel) return '';
      var block = '';
      try {
        var idx = String(r.cssText || '').indexOf('{');
        block = idx >= 0 ? String(r.cssText).slice(idx) : '';
      } catch (_) {
        block = '';
      }
      if (!block) return '';
      var rule = simSel + ' ' + block;
      if (r.href) rule = absolutizeUrlsInCss(rule, r.href);
      if (r.mediaText) rule = '@media ' + r.mediaText + ' { ' + rule + ' }';
      return rule;
    }).filter(Boolean).join('\n');
  }

  // Marks the elements a real interaction would put in-state: for each
  // compound of each cloned selector that carried an interactive pseudo,
  // the ancestor matching everything up to that compound. For
  // `.menu li:hover .sub` that is the li, not the Services link inside
  // it, which the sentence names but the selector never touches.
  function markHoverTargets(hiddenNode, rules) {
    var marked = [];
    rules.forEach(function (r) {
      // Only the interactive selectors of the list name a state to enter; a
      // sibling like `a:link` in `a:hover, a:link` names nothing to mark.
      interactiveSelectorParts(r.selectorText).forEach(function (part) {
        var comps = compoundsOf(part);
        for (var i = 0; i < comps.length; i++) {
          INTERACTIVE_PSEUDO_RE.lastIndex = 0;
          if (!INTERACTIVE_PSEUDO_RE.test(comps[i])) continue;
          var prefix = comps.slice(0, i + 1).join(' ').replace(INTERACTIVE_PSEUDO_RE, '');
          var node = hiddenNode.parentElement;
          var guard = 0;
          while (node && node.nodeType === 1 && guard < 8) {
            var m = false;
            try {
              m = node.matches(prefix);
            } catch (_) {
              m = false;
            }
            if (m) {
              try {
                if (node.classList && !node.classList.contains(SIM_CLASS)) {
                  node.classList.add(SIM_CLASS);
                  marked.push(node);
                }
              } catch (_) {
                // a node that cannot take a class still keeps the inline half
              }
              break;
            }
            node = node.parentElement;
            guard++;
          }
        }
      });
    });
    return marked;
  }

  // Background pictures referenced by the freshly matched rules start
  // loading now, not on first paint: the dropdown's green wash arriving
  // seconds after its text is the "no background, then fixed" flash.
  // Computed style already resolves each url() to an absolute address, so
  // there is nothing to resolve by hand.
  function warmBackgrounds(win, nodes) {
    if (!win) return;
    for (var i = 0; i < nodes.length; i++) {
      var bg = '';
      try {
        bg = win.getComputedStyle(nodes[i]).backgroundImage || '';
      } catch (_) {
        continue;
      }
      var m = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
      var hit = null;
      while ((hit = m.exec(bg)) !== null) {
        var url = hit[1];
        if (!url || url.indexOf('data:') === 0) continue;
        try {
          var img = new win.Image();
          img.src = url;
        } catch (_) {
          // warming is best effort; the image arrives on paint regardless
        }
      }
    }
  }

  // Restages the winning interaction live in the document. Hover-shaped
  // wins clone every hover rule touching the hidden subtree and mark the
  // hovered ancestors; state-class wins (`.modal.open`) simply add the
  // state classes to the hidden node, which the page's own rules then
  // match as if the interaction happened. Either way the return undoes
  // exactly what was done, or null when there was nothing to restage.
  function simulateInteraction(doc, win, analysis) {
    var best = analysis.best;
    var undos = [];
    var hiddenNode = analysis.hiddenNode;
    // No winning rule (JS-driven hiding): the generic inline half still
    // opens the node, but it opens unstyled — the item colors, borders
    // and the dropdown's background all live under hover-qualified rules
    // that match nothing without the hover. So the styling companions are
    // restaged even with no opener, the same clones the interactive path
    // applies below, only without a precise mark target from `best`.
    if (!best) {
      var styling = hoverCompanionRules(doc, hiddenNode, analysis.extraLists || []);
      var stylingCss = cloneCssForSim(styling);
      if (stylingCss) {
        var stylingEl = null;
        try {
          stylingEl = doc.createElement('style');
          stylingEl.setAttribute('data-pdiff-reveal', 'sim-hover');
          stylingEl.textContent = stylingCss;
          (doc.head || doc.documentElement || doc).appendChild(stylingEl);
        } catch (_) {
          stylingEl = null;
        }
        if (stylingEl) {
          undos.push(function () {
            try {
              if (stylingEl.parentNode) stylingEl.parentNode.removeChild(stylingEl);
            } catch (_) {
              // already gone with a navigation
            }
          });
        }
      }
      var stylingMarked = markHoverTargets(hiddenNode, styling.length ? styling : []);
      if (!stylingMarked.length && styling.length) {
        var stylingNode = hiddenNode.parentElement;
        var stylingGuard = 0;
        while (stylingNode && stylingNode.nodeType === 1 && stylingGuard < 8) {
          try {
            if (stylingNode.classList && !stylingNode.classList.contains(SIM_CLASS)) {
              stylingNode.classList.add(SIM_CLASS);
              stylingMarked.push(stylingNode);
            }
          } catch (_) {
            // a node that cannot take a class still keeps the inline half
          }
          stylingNode = stylingNode.parentElement;
          stylingGuard++;
        }
      }
      if (stylingMarked.length) {
        undos.push(function () {
          stylingMarked.forEach(function (node) {
            try {
              node.classList.remove(SIM_CLASS);
            } catch (_) {
              // already gone with a navigation
            }
          });
        });
      }
      try {
        var stylingPool = [hiddenNode].concat(Array.from(hiddenNode.querySelectorAll('*')).slice(0, 80));
        warmBackgrounds(win, stylingPool);
      } catch (_) {
        // warming is best effort
      }
      if (!undos.length) return null;
      return function () {
        undos.forEach(function (undo) {
          try {
            undo();
          } catch (_) {
            // best effort to the end
          }
        });
      };
    }
    if (best.interactive) {
      // The same rule lists analyze() consulted, hydrated cross-origin
      // sheets included, the opener often lives there, and without it
      // the clone set silently misses the very rule being restaged.
      var companions = hoverCompanionRules(doc, hiddenNode, analysis.extraLists || []);
      var css = cloneCssForSim(companions);
      if (css) {
        var styleEl = null;
        try {
          styleEl = doc.createElement('style');
          styleEl.setAttribute('data-pdiff-reveal', 'sim-hover');
          styleEl.textContent = css;
          (doc.head || doc.documentElement || doc).appendChild(styleEl);
        } catch (_) {
          styleEl = null;
        }
        if (styleEl) {
          undos.push(function () {
            try {
              if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            } catch (_) {
              // already gone with a navigation
            }
          });
        }
      }
      var marked = markHoverTargets(hiddenNode, companions.length ? companions : [{
        selectorText: best.selectorText,
      }]);
      // Belt and braces: the precise mark above can miss on exotic shapes
      // (combinators the prefix walk cannot follow), and a clone whose
      // context matches nothing styles nothing. Marking every ancestor
      // cannot overreach, the clones only ever name the hidden subtree,
      // so an empty precise pass falls back to the whole chain.
      if (!marked.length && companions.length) {
        var fallbackNode = hiddenNode.parentElement;
        var fallbackGuard = 0;
        while (fallbackNode && fallbackNode.nodeType === 1 && fallbackGuard < 8) {
          try {
            if (fallbackNode.classList && !fallbackNode.classList.contains(SIM_CLASS)) {
              fallbackNode.classList.add(SIM_CLASS);
              marked.push(fallbackNode);
            }
          } catch (_) {
            // a node that cannot take a class still keeps the inline half
          }
          fallbackNode = fallbackNode.parentElement;
          fallbackGuard++;
        }
      }
      if (marked.length) {
        undos.push(function () {
          marked.forEach(function (node) {
            try {
              node.classList.remove(SIM_CLASS);
            } catch (_) {
              // already gone with a navigation
            }
          });
        });
      }
      try {
        var pool = [hiddenNode].concat(Array.from(hiddenNode.querySelectorAll('*')).slice(0, 80));
        warmBackgrounds(win, pool);
      } catch (_) {
        // warming is best effort
      }
    }
    if (best.states && best.states.length && !best.interactive) {
      var added = [];
      best.states.forEach(function (name) {
        try {
          if (hiddenNode.classList && !hiddenNode.classList.contains(name)) {
            hiddenNode.classList.add(name);
            added.push(name);
          }
        } catch (_) {
          // a node that cannot take a class keeps the inline half
        }
      });
      if (added.length) {
        undos.push(function () {
          added.forEach(function (name) {
            try {
              hiddenNode.classList.remove(name);
            } catch (_) {
              // already gone with a navigation
            }
          });
        });
      }
    }
    if (!undos.length) return null;
    return function () {
      undos.forEach(function (undo) {
        try {
          undo();
        } catch (_) {
          // best effort to the end
        }
      });
    };
  }

  // The hiding rule's screen condition in plain words: `(max-width:
  // 767px)` hides things on narrow screens, `(min-width: 1024px)` on wide
  // ones. Anything else is quoted rather than guessed at.
  function describeWidths(mediaText) {
    var max = /max-width:\s*([\d.]+)\s*(px|em|rem)/i.exec(mediaText || '');
    var min = /min-width:\s*([\d.]+)\s*(px|em|rem)/i.exec(mediaText || '');
    if (max && min) return 'screens between ' + min[1] + min[2] + ' and ' + max[1] + max[2] + ' wide';
    if (max) return 'screens ' + max[1] + max[2] + ' wide or narrower';
    if (min) return 'screens ' + min[1] + min[2] + ' wide or wider';
    return 'certain screen sizes';
  }

  // The animation a reveal opens and closes with. The declarations flip
  // display/visibility instantly, which on its own snaps a dropdown open
  // and shut like a broken toggle. A slow fade-and-settle over the top
  // (injected into the pane's own document, where the reveal lives) makes
  // the same open read as a menu unfolding. Closing fades first and only
  // then restores the hiding, so it settles shut rather than blinking out.
  // Reduced-motion readers get the instant version: the animation is
  // decoration, the reveal is not.
  var ANIM_IN_MS = 600;
  var ANIM_OUT_MS = 320;
  var ANIM_CLASS_IN = 'pdiff-reveal-in';
  var ANIM_CLASS_OUT = 'pdiff-reveal-out';

  function ensureAnimStyle(doc) {
    try {
      if (!doc || doc.querySelector('style[data-pdiff-reveal-anim]')) return;
      var styleEl = doc.createElement('style');
      styleEl.setAttribute('data-pdiff-reveal-anim', 'true');
      styleEl.textContent =
        '@keyframes pdiffRevealIn {' +
        ' from { opacity: 0; transform: translateY(-10px); }' +
        ' 60% { opacity: 1; }' +
        ' to { opacity: 1; transform: none; }' +
        '}' +
        '.' + ANIM_CLASS_IN + ' {' +
        ' animation: pdiffRevealIn ' + ANIM_IN_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1) both;' +
        ' transform-origin: top center;' +
        '}' +
        '.' + ANIM_CLASS_OUT + ' {' +
        ' transition: opacity ' + ANIM_OUT_MS + 'ms ease, transform ' + ANIM_OUT_MS + 'ms ease !important;' +
        ' opacity: 0 !important;' +
        ' transform: translateY(-8px) !important;' +
        '}' +
        '@media (prefers-reduced-motion: reduce) {' +
        ' .' + ANIM_CLASS_IN + ' { animation: none; }' +
        ' .' + ANIM_CLASS_OUT + ' { transition: none !important; }' +
        '}';
      (doc.head || doc.documentElement || doc).appendChild(styleEl);
    } catch (_) {
      // no animation: the reveal still stands on its own
    }
  }

  // The display a cleared node should take. Most containers want block, a
  // list item wants its marker back, and an inline element (a link inside a
  // hidden submenu) must not become a block and break its own line box.
  function clearedDisplay(node) {
    var tag = String((node && node.tagName) || '').toUpperCase();
    if (tag === 'LI') return 'list-item';
    if (tag === 'A' || tag === 'SPAN' || tag === 'EM' || tag === 'STRONG' || tag === 'B' || tag === 'I') return 'inline';
    return 'block';
  }

  // Opens every level between the marked node and the topmost ancestor that
  // hides it: a JS-only menu routinely hides twice (a drawer at
  // display:none, its submenu at visibility:hidden, each from its own rule),
  // so clearing the outermost node alone leaves the item exactly as
  // invisible. The caller then judges the reveal a half-reveal and undoes
  // it, and the click reads as dead. Records each step for the undo.
  function clearHiddenPath(win, target, topNode, record) {
    if (!target || !topNode || !record) return;
    var path = [];
    var node = target;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < MAX_WALK_DEPTH) {
      path.push(node);
      if (node === topNode) break;
      node = node.parentElement;
      guard++;
    }
    path.reverse(); // topmost first: a hidden parent cannot undo a child's clear
    path.forEach(function (n) {
      var cause = hiddenCause(win, n);
      if (!cause) return;
      var prop = cause.prop === 'opacity' ? 'opacity' : cause.prop;
      var value = prop === 'display' ? clearedDisplay(n) : (prop === 'opacity' ? '1' : 'visible');
      var prev = '', prio = '';
      try {
        prev = n.style.getPropertyValue(prop);
        prio = n.style.getPropertyPriority(prop);
      } catch (_) { /* read-only style: still open it */ }
      record.push({ node: n, prop: prop, value: prev, prio: prio });
      try {
        n.style.setProperty(prop, value, 'important');
      } catch (_) { /* one stuck level must not block the rest */ }
    });
  }

  // ---- 4. Forcing the exact change on screen ------------------------------
  //
  // The page's own interaction is always tried first. But an archived copy
  // has no scripts, and pages ship content shut with no CSS rule that ever
  // opens it: two nav copies with one dropped at every width, a tab panel
  // chosen by a click handler, a drawer toggled by JS, a modal opened by a
  // router. A click must still land on the change itself, so this layer
  // clears every mechanism that can leave an element in the document and
  // unprinted: display, visibility, opacity, content-visibility, [hidden],
  // closed <details>/<dialog>/popover, clipped or zero boxes, off-screen
  // positioning, transforms, zero-height overflow clips, text-indent and
  // zero font sizes.
  //
  // Only the target's own ancestor chain is touched, so the rest of the
  // snapshot stays exactly as the crawl recorded it, and every change is
  // recorded for an exact undo.

  var FORCE_WALK_DEPTH = 60;

  function forceTouched(actions, node, prop) {
    for (var i = actions.length - 1; i >= 0; i--) {
      var a = actions[i];
      if (a.kind === 'style' && a.node === node && a.prop === prop) return true;
    }
    return false;
  }

  function forceSetStyle(node, prop, value, actions) {
    if (forceTouched(actions, node, prop)) return;
    var prev = '';
    var prio = '';
    try {
      prev = node.style.getPropertyValue(prop);
      prio = node.style.getPropertyPriority(prop);
    } catch (_) { /* read-only style: still try */ }
    actions.push({ kind: 'style', node: node, prop: prop, value: prev, prio: prio });
    try {
      node.style.setProperty(prop, value, 'important');
    } catch (_) { /* one stuck declaration must not stop the walk */ }
  }

  function forceSetAttr(node, name, value, actions) {
    var prev = null;
    try { prev = node.getAttribute(name); } catch (_) { prev = null; }
    actions.push({ kind: 'attr', node: node, name: name, value: prev });
    try { node.setAttribute(name, value); } catch (_) { /* still shown below */ }
  }

  function forceRemoveAttr(node, name, actions) {
    var prev = null;
    try { prev = node.getAttribute(name); } catch (_) { prev = null; }
    if (prev === null) return;
    actions.push({ kind: 'attr', node: node, name: name, value: prev });
    try { node.removeAttribute(name); } catch (_) { /* the display clear below still shows it */ }
  }

  // `revert` rolls the declaration back to the user-agent value, which is
  // exactly what a container hidden by one author rule should return to
  // (a div back to block, a li to list-item, an a to inline). Older engines
  // get the tag-based display as the fallback.
  function forcedValue(prop, node) {
    try {
      if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports(prop, 'revert')) return 'revert';
    } catch (_) { /* fall through to the explicit value */ }
    if (prop === 'display') return clearedDisplay(node);
    if (prop === 'opacity') return '1';
    if (prop === 'visibility') return 'visible';
    if (prop === 'content-visibility') return 'visible';
    return 'initial';
  }

  function transparentColor(value) {
    var v = String(value || '').replace(/\s+/g, '');
    if (!v) return false;
    if (v === 'transparent') return true;
    var m = /rgba\([^)]*,(0|0?\.0+)\)$/.exec(v);
    return !!m && parseFloat(m[1]) === 0;
  }

  function nodeHasText(node) {
    try {
      return !!(node.textContent || '').replace(/\s+/g, '');
    } catch (_) {
      return false;
    }
  }

  // Clears the ways one node can suppress its own content. The caller walks
  // the whole chain, so a hidden drawer and a hidden item inside it are both
  // cleared; only the target itself gets the text-level fixes, which would
  // otherwise restyle a whole container.
  function forceNode(win, node, actions, isTarget) {
    var cs = null;
    try { cs = win.getComputedStyle(node); } catch (_) { return; }
    if (!cs) return;
    var tag = String(node.tagName || '').toUpperCase();
    var rect = null;
    try { rect = node.getBoundingClientRect(); } catch (_) { rect = null; }
    var vw = 0;
    var vh = 0;
    try {
      vw = win.innerWidth || (node.ownerDocument.documentElement && node.ownerDocument.documentElement.clientWidth) || 0;
      vh = win.innerHeight || (node.ownerDocument.documentElement && node.ownerDocument.documentElement.clientHeight) || 0;
    } catch (_) { vw = 0; vh = 0; }

    // Elements whose own semantics suppress rendering.
    if (node.hasAttribute && node.hasAttribute('hidden')) {
      forceRemoveAttr(node, 'hidden', actions);
      forceSetStyle(node, 'display', forcedValue('display', node), actions);
    }
    if (tag === 'DETAILS' && !node.hasAttribute('open')) {
      forceSetAttr(node, 'open', '', actions);
    }
    if (tag === 'DIALOG' && !node.hasAttribute('open')) {
      forceSetAttr(node, 'open', '', actions);
    }
    if (node.hasAttribute && node.hasAttribute('popover')) {
      var isOpen = false;
      try { isOpen = node.matches(':popover-open'); } catch (_) { isOpen = false; }
      if (!isOpen) {
        var shown = false;
        try {
          if (typeof node.showPopover === 'function') { node.showPopover(); shown = true; }
        } catch (_) { shown = false; }
        if (shown) actions.push({ kind: 'popover', node: node });
        else {
          forceSetStyle(node, 'display', forcedValue('display', node), actions);
          forceSetStyle(node, 'position', 'fixed', actions);
          forceSetStyle(node, 'inset', 'auto', actions);
          forceSetStyle(node, 'opacity', '1', actions);
        }
      }
    }
    if (tag === 'INPUT' && String(node.getAttribute('type') || '').toLowerCase() === 'hidden') {
      forceSetAttr(node, 'type', 'text', actions);
    }
    if (tag === 'OPTION') {
      var sel = null;
      try { sel = node.closest ? node.closest('select') : null; } catch (_) { sel = null; }
      if (sel && (!sel.size || sel.size < 2)) {
        var count = 2;
        try { count = Math.max(2, sel.options ? sel.options.length : 2); } catch (_) { count = 2; }
        forceSetAttr(sel, 'size', String(count), actions);
      }
    }

    // Computed suppression.
    if (cs.display === 'none') forceSetStyle(node, 'display', forcedValue('display', node), actions);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      forceSetStyle(node, 'visibility', 'visible', actions);
    }
    if (cs.opacity !== '' && cs.opacity !== undefined && Number(cs.opacity) < 0.05) {
      forceSetStyle(node, 'opacity', '1', actions);
    }
    var rawStyle = String((node.getAttribute && node.getAttribute('style')) || '');
    var inline = function (prop) {
      try { return node.style.getPropertyValue(prop) || ''; } catch (_) { return ''; }
    };
    if (cs.contentVisibility === 'hidden' || /content-visibility\s*:\s*hidden/i.test(rawStyle)) {
      forceSetStyle(node, 'content-visibility', 'visible', actions);
    }
    if (cs.filter && /opacity\(\s*0(?:\.0+)?\s*\)/i.test(cs.filter)) {
      forceSetStyle(node, 'filter', 'none', actions);
    }
    // A mask that erases the subtree is another way to paint nothing while a
    // box remains. It is cleared only on this chain, never globally.
    if ((cs.maskImage && cs.maskImage !== 'none') || (inline('mask-image') && inline('mask-image') !== 'none')) {
      forceSetStyle(node, 'mask-image', 'none', actions);
    }
    if ((cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ||
        (inline('-webkit-mask-image') && inline('-webkit-mask-image') !== 'none')) {
      forceSetStyle(node, '-webkit-mask-image', 'none', actions);
    }

    var boxW = rect ? rect.width : 0;
    var boxH = rect ? rect.height : 0;
    var tiny = !!(rect && (boxW < 2 || boxH < 2));
    var pos = cs.position || '';

    // Clipping a real-sized box to nothing is the other screen-reader shape
    // (clip: rect(0,0,0,0) or clip-path: inset(50%) on an otherwise normal
    // anchor). It applies whatever the box measures, so it is checked before
    // the zero-size branch.
    if ((cs.clip && cs.clip !== 'auto') || /rect\(/.test(inline('clip')) ||
        /clip\s*:\s*rect\(/i.test(rawStyle)) {
      forceSetStyle(node, 'clip', 'auto', actions);
    }
    if ((cs.clipPath && cs.clipPath !== 'none') || /inset\(|circle\(|ellipse\(|polygon\(/.test(inline('clip-path'))) {
      forceSetStyle(node, 'clip-path', 'none', actions);
    }
    if (isTarget) {
      if ((cs.textIndent && parseFloat(cs.textIndent) <= -500) || parseFloat(inline('text-indent')) <= -500) {
        forceSetStyle(node, 'text-indent', '0', actions);
      }
      if (parseFloat(cs.fontSize) === 0) {
        forceSetStyle(node, 'font-size', forcedValue('font-size'), actions);
      }
      if (parseFloat(cs.zoom) === 0) forceSetStyle(node, 'zoom', '1', actions);
      // SVG text can be present and inked with nothing: fill none/transparent
      // or a zero fill-opacity hides the words while the glyph boxes remain.
      if (/svg/i.test(String(node.namespaceURI || '')) && /^(text|tspan)$/i.test(tag)) {
        if (!cs.fill || cs.fill === 'none' || transparentColor(cs.fill) || Number(cs.fillOpacity) === 0) {
          forceSetStyle(node, 'fill', 'currentColor', actions);
          forceSetStyle(node, 'fill-opacity', '1', actions);
        }
      }
    }

    // Parked off screen by a transform or a huge offset while keeping a real
    // box: a carousel band, a slide-out drawer, a mega-menu at left:-9999px.
    // Ordinary content below the fold is static with no offsets, so it is not
    // this case - the pane scrolls to it.
    var fullyOut = !!(rect && (rect.right <= 0 || rect.bottom <= 0 ||
      (vw && rect.left >= vw) || (vh && rect.top >= vh)));
    var moved = (cs.transform && cs.transform !== 'none') ||
      (cs.scale && cs.scale !== 'none') || (cs.translate && cs.translate !== 'none') ||
      parseFloat(cs.left) <= -500 || parseFloat(cs.top) <= -500 ||
      parseFloat(cs.right) <= -500 || parseFloat(cs.bottom) <= -500 ||
      parseFloat(cs.marginLeft) <= -500 || parseFloat(cs.marginTop) <= -500;
    if (fullyOut && moved) {
      if (cs.transform && cs.transform !== 'none') forceSetStyle(node, 'transform', 'none', actions);
      if (cs.scale && cs.scale !== 'none') forceSetStyle(node, 'scale', 'none', actions);
      if (cs.translate && cs.translate !== 'none') forceSetStyle(node, 'translate', 'none', actions);
      if (pos === 'absolute' || pos === 'fixed') {
        forceSetStyle(node, 'position', 'static', actions);
        forceSetStyle(node, 'left', 'auto', actions);
        forceSetStyle(node, 'top', 'auto', actions);
        forceSetStyle(node, 'right', 'auto', actions);
        forceSetStyle(node, 'bottom', 'auto', actions);
        forceSetStyle(node, 'inset', 'auto', actions);
      }
      if (parseFloat(cs.marginLeft) <= -500) forceSetStyle(node, 'margin-left', '0', actions);
      if (parseFloat(cs.marginTop) <= -500) forceSetStyle(node, 'margin-top', '0', actions);
    }

    // A max-height clip can leave padding or a border keeping the box at a
    // measurable size while the content inside is clipped away, so this is
    // checked whether or not the box measures zero.
    if (parseFloat(cs.maxHeight) === 0 && cs.overflow && cs.overflow !== 'visible') {
      forceSetStyle(node, 'max-height', forcedValue('max-height'), actions);
      forceSetStyle(node, 'height', forcedValue('height'), actions);
      forceSetStyle(node, 'overflow', 'visible', actions);
    }
    if (tiny) {
      // A box held at zero by its own size or a max-height clip.
      if (parseFloat(cs.maxHeight) <= 0) {
        forceSetStyle(node, 'max-height', forcedValue('max-height'), actions);
        forceSetStyle(node, 'height', forcedValue('height'), actions);
      }
      if (parseFloat(cs.height) === 0) {
        forceSetStyle(node, 'height', forcedValue('height'), actions);
      }
      // The screen-reader-only shape is a 1px absolutely positioned box
      // clipped to nothing; those 1px sizes are the hiding, not a layout
      // choice, so they come back to auto along with the clip.
      if (parseFloat(cs.width) === 0 || (boxW <= 1 && (pos === 'absolute' || pos === 'fixed'))) {
        forceSetStyle(node, 'width', forcedValue('width'), actions);
      }
      if (parseFloat(cs.height) === 0 || (boxH <= 1 && (pos === 'absolute' || pos === 'fixed'))) {
        forceSetStyle(node, 'height', forcedValue('height'), actions);
      }
      if (cs.overflow && cs.overflow !== 'visible') {
        forceSetStyle(node, 'overflow', 'visible', actions);
      }
      if ((cs.clip && cs.clip !== 'auto') || /rect\(/.test(inline('clip')) ||
          /clip\s*:\s*rect\(/i.test(String(node.getAttribute && node.getAttribute('style') || ''))) {
        forceSetStyle(node, 'clip', 'auto', actions);
      }
      if ((cs.clipPath && cs.clipPath !== 'none') || /inset\(|circle\(|ellipse\(|polygon\(/.test(inline('clip-path'))) {
        forceSetStyle(node, 'clip-path', 'none', actions);
      }
      if ((cs.transform && cs.transform !== 'none') || inline('transform')) {
        forceSetStyle(node, 'transform', 'none', actions);
      }
      if ((cs.scale && cs.scale !== 'none') || inline('scale')) {
        forceSetStyle(node, 'scale', 'none', actions);
      }
      if ((cs.translate && cs.translate !== 'none') || inline('translate')) {
        forceSetStyle(node, 'translate', 'none', actions);
      }
      if (cs.display === 'contents') {
        forceSetStyle(node, 'display', forcedValue('display', node), actions);
      }
      if (cs.rotate && cs.rotate !== 'none') forceSetStyle(node, 'rotate', 'none', actions);
      if (cs.backfaceVisibility === 'hidden') {
        forceSetStyle(node, 'backface-visibility', 'visible', actions);
      }
      if (/(^|\s)paint(\s|$)/.test(cs.contain || '')) {
        forceSetStyle(node, 'contain', 'none', actions);
      }
      if (isTarget && nodeHasText(node)) {
        if ((cs.textIndent && parseFloat(cs.textIndent) < -50) || parseFloat(inline('text-indent')) < -50) {
          forceSetStyle(node, 'text-indent', '0', actions);
        }
        var fontSize = parseFloat(cs.fontSize);
        if (fontSize === 0 || (isNaN(fontSize) && /^0[a-z]*$/i.test(inline('font-size').trim()))) {
          forceSetStyle(node, 'font-size', forcedValue('font-size'), actions);
        }
        if (parseFloat(cs.lineHeight) === 0) {
          forceSetStyle(node, 'line-height', 'normal', actions);
        }
        if (transparentColor(cs.color) || /rgba\([^)]*,\s*0\s*\)/.test(inline('color'))) {
          forceSetStyle(node, 'color', 'inherit', actions);
        }
        if (transparentColor(cs.webkitTextFillColor) || transparentColor(inline('-webkit-text-fill-color'))) {
          forceSetStyle(node, '-webkit-text-fill-color', 'inherit', actions);
        }
      }
    }

    // Parked outside the viewport on purpose: an off-canvas drawer or a
    // mega-menu at left: -9999px. Ordinary content below the fold is not
    // this case - it is static and the pane scrolls to it.
    if (pos === 'absolute' || pos === 'fixed') {
      var left = parseFloat(cs.left);
      var top = parseFloat(cs.top);
      var right = parseFloat(cs.right);
      var bottom = parseFloat(cs.bottom);
      var parked = (left <= -500) || (top <= -500) || (right <= -500) || (bottom <= -500);
      if (!parked && pos === 'fixed' && rect && vw && vh) {
        parked = rect.right < -50 || rect.bottom < -50 || rect.left > vw + 50 || rect.top > vh + 50;
      }
      if (parked) {
        forceSetStyle(node, 'position', 'static', actions);
        forceSetStyle(node, 'left', 'auto', actions);
        forceSetStyle(node, 'top', 'auto', actions);
        forceSetStyle(node, 'right', 'auto', actions);
        forceSetStyle(node, 'bottom', 'auto', actions);
        forceSetStyle(node, 'inset', 'auto', actions);
      }
    }
  }

  function undoForce(actions) {
    for (var i = actions.length - 1; i >= 0; i--) {
      var a = actions[i];
      try {
        if (a.kind === 'style') {
          if (a.value) a.node.style.setProperty(a.prop, a.value, a.prio);
          else a.node.style.removeProperty(a.prop);
        } else if (a.kind === 'attr') {
          if (a.value === null) a.node.removeAttribute(a.name);
          else a.node.setAttribute(a.name, a.value);
        } else if (a.kind === 'popover') {
          if (typeof a.node.hidePopover === 'function') a.node.hidePopover();
        }
      } catch (_) { /* one stuck restore must not block the rest */ }
    }
  }

  // The change itself, on screen: every level of its own chain is cleared.
  // Returns null when there was nothing to clear (a genuinely painted node),
  // so callers can tell "already visible" from "forced".
  // Already on screen, as the page itself paints it. This is the guard that
  // keeps the forced layer from "fixing" a menu the page's own hover has just
  // opened: such a menu routinely has a zero-height wrapper (its items float
  // or are absolutely placed) and an off-screen resting position in the rule
  // that hides it. Reverting those because an ancestor measures 0x0 turns a
  // compact dropdown into a full-width panel over the page. If the change
  // itself has a box and no ancestor is hiding it, there is nothing to force.
  function targetIsPainted(win, target) {
    try {
      var r = target.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var n = target;
      var depth = 0;
      while (n && n.nodeType === 1 && depth++ < 40) {
        var cs = win.getComputedStyle(n);
        if (!cs) break;
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        // Our own unfold starts at opacity 0; that is a frame of the reveal,
        // not a hidden menu, and judging it hidden here made the forced layer
        // "fix" the very menu the interaction had just opened.
        var animating = false;
        try {
          animating = !!(n.classList && (n.classList.contains(ANIM_CLASS_IN) || n.classList.contains(ANIM_CLASS_OUT)));
        } catch (_) { animating = false; }
        if (!animating && cs.opacity !== '' && cs.opacity !== undefined && Number(cs.opacity) === 0) return false;
        if (n === n.ownerDocument.body) break;
        n = n.parentElement;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function forceReveal(doc, win, target) {
    var w = win || (doc && doc.defaultView);
    if (!doc || !w || !target || target.nodeType !== 1) return null;
    if (targetIsPainted(w, target)) return null;
    var actions = [];
    var node = target;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < FORCE_WALK_DEPTH) {
      forceNode(w, node, actions, node === target);
      var parent = node.parentElement;
      if (!parent) {
        try {
          var root = node.getRootNode ? node.getRootNode() : null;
          if (root && root.host) parent = root.host;
        } catch (_) { parent = null; }
      }
      node = parent;
      depth++;
    }
    // A clipping ancestor can hold the change outside its box with no rule
    // naming the change at all (an absolutely placed flyout in a nav that
    // clips its overflow). Once the chain is open, a clip that still cuts the
    // target off is opened up too, so the change can actually paint outside
    // it. Only ancestors whose box truly excludes the target are touched.
    try {
      var tr = target.getBoundingClientRect();
      var up = target.parentElement;
      var guard = 0;
      while (up && up.nodeType === 1 && guard++ < FORCE_WALK_DEPTH) {
        var ucs = w.getComputedStyle(up);
        var ur = up.getBoundingClientRect();
        var clipsX = ucs && /^(hidden|clip)$/.test(ucs.overflowX || '');
        var clipsY = ucs && /^(hidden|clip)$/.test(ucs.overflowY || '');
        var outside = ur.width > 0 && ur.height > 0 &&
          ((clipsX && (tr.right <= ur.left + 1 || tr.left >= ur.right - 1)) ||
           (clipsY && (tr.bottom <= ur.top + 1 || tr.top >= ur.bottom - 1)));
        if (outside) {
          forceSetStyle(up, 'overflow', 'visible', actions);
          if (/(^|\s)paint(\s|$)/.test(ucs.contain || '')) {
            forceSetStyle(up, 'contain', 'none', actions);
          }
        }
        up = up.parentElement;
        guard++;
      }
    } catch (_) { /* a clipping box that cannot be read is left alone */ }
    if (!actions.length) return null;
    return {
      forced: true,
      applied: actions.map(function (a) {
        return a.kind === 'style' ? a.prop + ': ' + a.node.style.getPropertyValue(a.prop) : a.kind + ' ' + a.name;
      }),
      actions: actions,
      undo: function () { undoForce(actions); },
    };
  }

  function applyReveal(doc, win, analysis) {
    if (!analysis || analysis.visible || !analysis.hiddenNode) return null;
    // A viewport-conditioned hiding (a desktop menu under a max-width
    // rule, a mobile drawer under min-width) is never forced open: the
    // override would cram a wide-screen element into a narrow pane and
    // read as broken. The receipt says refused so the interface can
    // widen the pane or explain the widths instead.
    if (analysis.responsive) {
      return { undo: function () {}, applied: [], generic: true, refused: 'responsive', changed: [], simulated: false };
    }
    var node = analysis.hiddenNode;
    var before = {};
    try {
      var cs = win.getComputedStyle(node);
      before.display = cs.display;
      before.visibility = cs.visibility;
      before.opacity = cs.opacity;
    } catch (_) {
      before = { display: '', visibility: '', opacity: '' };
    }
    var decls = (analysis.best && analysis.best.declarations) || [];
    var generic = decls.length === 0;
    var toApply = generic
      ? [{ prop: 'display', value: node.tagName === 'SPAN' || node.tagName === 'A' ? 'inline' : 'block' }, { prop: 'visibility', value: 'visible' }]
      : decls.map(function (d) {
        var idx = d.indexOf(':');
        return { prop: d.slice(0, idx).trim(), value: d.slice(idx + 1).trim() };
      });
    var previous = [];
    toApply.forEach(function (item) {
      var prev = '';
      try {
        prev = node.style.getPropertyValue(item.prop);
      } catch (_) {
        prev = '';
      }
      var prevPrio = '';
      try {
        prevPrio = node.style.getPropertyPriority(item.prop);
      } catch (_) {
        prevPrio = '';
      }
      previous.push({ prop: item.prop, value: prev, prio: prevPrio });
      try {
        node.style.setProperty(item.prop, item.value, 'important');
      } catch (_) {
        // a property the engine rejects (never crash a reveal on one)
      }
    });
    // A node revealed behind a hidden parent stays hidden; lift the whole
    // chain the same way, recording every step for the undo.
    var chainUndone = [];
    if (analysis.hiddenNode !== undefined) {
      var parent = node.parentElement;
      var guard = 0;
      while (parent && parent.nodeType === 1 && guard < MAX_WALK_DEPTH) {
        var c = hiddenCause(win, parent);
        if (!c) break;
        (function (p, prop) {
          var pv = '', pp = '';
          try {
            pv = p.style.getPropertyValue(prop);
            pp = p.style.getPropertyPriority(prop);
          } catch (_) { /* read-only style: still reveal below */ }
          chainUndone.push({ node: p, prop: prop, value: pv, prio: pp });
          try {
            p.style.setProperty(prop, prop === 'display' ? 'block' : (prop === 'opacity' ? '1' : 'visible'), 'important');
          } catch (_) { /* keep going: one stuck ancestor must not block the rest */ }
        })(parent, c.prop === 'opacity' ? 'opacity' : c.prop);
        parent = parent.parentElement;
        guard++;
      }
    }
    // With no stylesheet rule to follow, the page's own script was the
    // thing that opened this menu, and archived scripts never run. The
    // generic clear above only reaches the topmost hidden node, which for a
    // drawer-and-submenu pair is half a reveal: the item stays hidden, the
    // caller undoes it, and picking the row does nothing at all. So the
    // whole hidden path between that node and the item is opened here.
    if (generic) {
      try {
        clearHiddenPath(win, analysis.target || node, node, chainUndone);
      } catch (_) { /* the node reveal above still stands on its own */ }
    }
    // The second layer: restage the interaction itself, so the node opens
    // looking the way the hover leaves it rather than unstyled. Runs after
    // the inline half so the computed "after" below reflects both.
    var undoSim = null;
    try {
      undoSim = simulateInteraction(doc, win, analysis);
    } catch (_) {
      undoSim = null; // the inline half above still stands on its own
    }
    // The last layer: the change itself, exactly where it sits, whatever
    // else the page uses to keep it unprinted. A CSS hover leaves nothing to
    // do here; a JS-only drawer, a clipped panel, a zero-height wrapper or an
    // off-canvas copy is cleared down to the target.
    var undoForced = null;
    try {
      undoForced = forceReveal(doc, win, analysis.target || node);
    } catch (_) {
      undoForced = null;
    }
    var wasForced = !!undoForced;
    // A node still held open by an earlier receipt (two hidden links share
    // one submenu; the post-hydration pass re-reveals the same change):
    // undo from the ORIGINAL pre-reveal inline state, not from this
    // receipt's already-revealed state, or deselecting would "restore"
    // display:block and wedge the menu open. The earlier receipt stood
    // down via its older token, so its sim teardown is adopted here and
    // nothing leaks.
    try {
      var baseline = node.__pdiffRevealBaseline || null;
      if (baseline) {
        previous = baseline.previous;
        chainUndone = baseline.chain;
        (function (firstSim, secondSim) {
          undoSim = function () {
            try { if (secondSim) secondSim(); } catch (_) { /* best effort */ }
            try { if (firstSim) firstSim(); } catch (_) { /* best effort */ }
          };
        })(baseline.sim, undoSim);
      }
      node.__pdiffRevealBaseline = { previous: previous, chain: chainUndone, sim: undoSim };
    } catch (_) {
      // read-only expando: this receipt undoes to its own state instead
    }
    var after = {};
    try {
      var cs2 = win.getComputedStyle(node);
      after.display = cs2.display;
      after.visibility = cs2.visibility;
      after.opacity = cs2.opacity;
    } catch (_) {
      after = { display: '', visibility: '', opacity: '' };
    }
    var changed = [];
    ['display', 'visibility', 'opacity'].forEach(function (p) {
      if (before[p] !== after[p]) changed.push(p + ': ' + before[p] + ' → ' + after[p]);
    });
    // A token per node so a close scheduled by an older selection never
    // tears down a newer reveal on the same node (two hidden links often
    // share one submenu): only the latest reveal owns the restore.
    var token = 0;
    try {
      token = (node.__pdiffRevealToken || 0) + 1;
      node.__pdiffRevealToken = token;
    } catch (_) {
      token = 0; // read-only expando: animation still runs, guard skipped
    }
    try {
      ensureAnimStyle(doc);
      if (node.classList) {
        node.classList.remove(ANIM_CLASS_OUT);
        // Restart the keyframes when the same node reveals twice in a row.
        node.classList.remove(ANIM_CLASS_IN);
        void node.offsetWidth;
        node.classList.add(ANIM_CLASS_IN);
      }
    } catch (_) {
      // no animation: the reveal still stands on its own
    }
    var inTimer = null;
    try {
      inTimer = setTimeout(function () {
        try {
          if (node.__pdiffRevealToken === token && node.classList) node.classList.remove(ANIM_CLASS_IN);
        } catch (_) { /* navigated away since */ }
      }, ANIM_IN_MS + 100);
    } catch (_) {
      inTimer = null;
    }
    function restoreNow() {
      if (inTimer) {
        try { clearTimeout(inTimer); } catch (_) { /* already fired */ }
        inTimer = null;
      }
      try { node.__pdiffRevealBaseline = null; } catch (_) { /* read-only expando */ }
      try {
        if (node.classList) {
          node.classList.remove(ANIM_CLASS_IN);
          node.classList.remove(ANIM_CLASS_OUT);
        }
      } catch (_) { /* best effort */ }
      if (undoForced) {
        try { undoForced(); } catch (_) { /* best effort */ }
        undoForced = null;
      }
      previous.forEach(function (item) {
        try {
          if (item.value) node.style.setProperty(item.prop, item.value, item.prio);
          else node.style.removeProperty(item.prop);
        } catch (_) { /* best effort */ }
      });
      chainUndone.forEach(function (item) {
        try {
          if (item.value) item.node.style.setProperty(item.prop, item.value, item.prio);
          else item.node.style.removeProperty(item.prop);
        } catch (_) { /* best effort */ }
      });
      if (undoSim) {
        try {
          undoSim();
        } catch (_) { /* best effort to the end */ }
      }
    }
    return {
      // Fades the node out, then restores the hiding. Returns a promise
      // for the restore so tests (and anyone sequencing reveals) can wait
      // on it; fire-and-forget callers are unaffected. A reveal applied
      // after this undo reclaims the node via its newer token, and this
      // restore then stands down instead of tearing the new reveal down.
      // Pass instant=true when the next selection re-analyzes the same
      // document synchronously right after: a fading restore leaves stale
      // visible state behind for ~380ms, and the fresh analysis trusts
      // it — a twin mid-fade reads as "already on screen", the reveal
      // is skipped, then the fade completes and shuts the dropdown with
      // the light stranded on a hidden node. Instant restore keeps the
      // DOM truthful for the pass that follows; the fade stays for
      // toggle-off, where someone is actually watching it close.
      undo: function (instant) {
        var done = function () {
          try {
            if (node.__pdiffRevealToken === token) restoreNow();
            // A newer fade owns the outro now: only its owner may end it,
            // or an older timeout would snap the new fade off midway.
            else if (node.classList && node.__pdiffRevealOutToken === token) node.classList.remove(ANIM_CLASS_OUT);
          } catch (_) { /* navigated away since */ }
        };
        if (instant) {
          done();
          return Promise.resolve();
        }
        try {
          if (node.classList) {
            node.classList.remove(ANIM_CLASS_IN);
            node.classList.add(ANIM_CLASS_OUT);
            node.__pdiffRevealOutToken = token;
          }
        } catch (_) {
          return Promise.resolve().then(function () { done(); });
        }
        return new Promise(function (resolve) {
          var settled = false;
          var finish = function () {
            if (settled) return;
            settled = true;
            done();
            resolve();
          };
          try {
            setTimeout(finish, ANIM_OUT_MS + 60);
          } catch (_) {
            finish();
          }
        });
      },
      applied: toApply.map(function (item) { return item.prop + ': ' + item.value; }),
      generic: generic,
      simulated: !!undoSim,
      forced: wasForced,
      changed: changed,
    };
  }

  // A sentence the tooltip can quote verbatim. Exact selectors, exact
  // declarations, exact trigger, never "maybe" or "most likely".
  function sentence(analysis, sideLabel) {
    if (!analysis || analysis.visible) return null;
    var prefix = sideLabel ? sideLabel + ': ' : '';
    if (analysis.note && !analysis.hidingRule && !analysis.best) return prefix + analysis.note;
    // A responsive hiding gets the widths in plain words, never a forced
    // reveal: the element is shown on bigger screens, not missing, and the
    // pane it sits in is named with its actual width so the reader can see
    // why it hides here.
    if (analysis.responsive && analysis.hidingRule) {
      var h = analysis.hidingRule;
      // The widths claim is checked, not assumed: the analysis and its width
      // are recorded together, but a stale analysis quoted after a resize or
      // a widen can otherwise swear a max-width rule applies to a pane far
      // wider than its cutoff.
      var maxNum = /max-width:\s*([\d.]+)/i.exec(h.mediaText || '');
      maxNum = maxNum ? parseFloat(maxNum[1]) : NaN;
      var where = '';
      if (analysis.paneWidth) {
        if (!isNaN(maxNum) && analysis.paneWidth > maxNum) {
          where = ' This pane is ' + analysis.paneWidth + 'px wide now, past the rule\u2019s cutoff' +
            ' \u2014 the hiding was recorded at selection time, before the pane changed.';
        } else {
          where = ' This pane is ' + analysis.paneWidth + 'px wide, so the rule applies here.';
        }
      }
      return prefix + 'hidden by `' + h.selectorText + ' { ' + h.declaration + '}`, ' +
        'which applies on ' + describeWidths(h.mediaText) + '.' + where +
        ' It is shown on wider screens, not missing.';
    }
    var bits = [];
    if (analysis.hidingRule) {
      var h = analysis.hidingRule;
      var cond = h.mediaText ? ', but only whenever ' + h.mediaText : ', not tied to screen width at all';
      bits.push('hidden by `' + h.selectorText + ' { ' + h.declaration + ' }`' + cond);
    } else if (analysis.cause) {
      bits.push('computed ' + analysis.cause.prop + ': ' + analysis.cause.value +
        (analysis.onSelf ? ' on the element itself' : ' on ancestor ' + analysis.hiddenDesc) +
        ', with no matching stylesheet rule found');
    }
    if (analysis.best) {
      var b = analysis.best;
      var iw = interactionWord(b.selectorText, b.states);
      var trig = b.trigger && b.trigger.label ? ' "' + b.trigger.label + '"' : (b.trigger ? ' ' + b.trigger.desc : '');
      var action = iw.verb + trig;
      if (iw.state && !b.trigger) action = 'adding .' + iw.state;
      bits.push('revealed by ' + action + ' (`' + b.selectorText + '` sets ' + b.declarations.join(', ') + ')');
    } else {
      bits.push('no stylesheet rule reveals it: the page opens this one with JavaScript, which an archived copy cannot run, so it stays hidden here \u2014 the page as the crawl recorded it is what is on screen');
    }
    return prefix + bits.join('. ') + '.';
  }

  // Every background picture the page's hover rules can show, absolute
  // addresses, capped. The caller warms them once the stylesheets are
  // readable, long before any reveal, so a dropdown opens with its
  // background already in the cache instead of a second late.
  function collectBackgroundUrls(doc, extraLists) {
    var rules = collectRules(doc, extraLists);
    var urls = [];
    for (var i = 0; i < rules.length; i++) {
      if (urls.length >= 40) break;
      INTERACTIVE_PSEUDO_RE.lastIndex = 0;
      if (!INTERACTIVE_PSEUDO_RE.test(rules[i].selectorText)) continue;
      var css = rules[i].cssText || '';
      var m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
      var hit = null;
      while ((hit = m.exec(css)) !== null) {
        var u = String(hit[1] || '').trim();
        if (!u || /^data:/i.test(u) || /^#/i.test(u)) continue;
        if (!/^https?:\/\//i.test(u)) {
          if (!rules[i].href) continue;
          try {
            u = new URL(u, rules[i].href).href;
          } catch (_) {
            continue;
          }
        }
        if (urls.indexOf(u) === -1) urls.push(u);
        if (urls.length >= 40) break;
      }
    }
    return urls;
  }

  function warmUrls(win, urls) {
    if (!win || !urls) return;
    for (var i = 0; i < urls.length; i++) {
      try {
        var img = new win.Image();
        img.src = urls[i];
      } catch (_) {
        // warming is best effort; the image arrives on paint regardless
      }
    }
  }

  return {
    analyze: analyze,
    applyReveal: applyReveal,
    forceReveal: forceReveal,
    targetIsPainted: targetIsPainted,
    // The interaction layer on its own, for an element the page already has
    // on screen but only styles as a menu under :hover (see app.js).
    restageHover: simulateInteraction,
    sentence: sentence,
    hidingRule: hidingRule,
    revealCandidates: revealCandidates,
    stripInteractive: stripInteractive,
    shortDescribe: shortDescribe,
    hoverCompanionRules: hoverCompanionRules,
    cloneCssForSim: cloneCssForSim,
    collectBackgroundUrls: collectBackgroundUrls,
    warmUrls: warmUrls,
    describeWidths: describeWidths,
  };
}));
