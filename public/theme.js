// public/theme.js
//
// The few things the shell's own look needs that CSS cannot do by itself. It is
// deliberately short: the layout is a grid, the plate band is a CSS animation,
// and everything else on this site is still driven by the script that owns it.
// Nothing here talks to the server, and no page depends on it to be readable ,
// with this file missing, the page is the same page with the film staying where
// it started and the banner word standing still.

(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------- the opening
  // The opening screen is scrubbed rather than scrolled: how far the reader has
  // moved into the section is written onto it as --p, and theme.css turns that
  // one number into the film's size, the word's scale and the row's fade. The
  // number IS the page's position, so there is nothing to keep in step with it
  // and nothing to run when the reader stops.
  //
  // Below the width where the section unpins (see theme.css) the number is
  // simply left at zero: the film is a panel in a column there, and there is
  // nothing for the scroll to change.
  var stage = document.getElementById('stage');
  var pin = stage ? stage.querySelector('.stage-pin') : null;
  var filmSlot = document.getElementById('filmSlot');
  var filmScreen = document.getElementById('filmScreen');
  var film = filmScreen ? filmScreen.querySelector('video') : null;
  var filmSound = document.getElementById('filmSound');
  var filmPlay = document.getElementById('filmPlay');
  // ----------------------------------------------------------------- the set
  // The set is ONE object, the machine on its desk and the screen drawn over
  // the machine's glass, and it arrives as one. It did not: the picture is a
  // file and the screen is a gradient the browser paints, so the drawn half was
  // ready the moment the page was, and for as long as the file took to arrive
  // the reader was looking at a small colour-filled screen standing in the
  // middle of the opening page with no computer around it, and then at a
  // computer. Everything that puts the set on the page goes through here, so
  // there is one answer to when it lands rather than three.
  var rigOnPage = function () {
    return !filmSlot || filmSlot.classList.contains('rig-in');
  };
  // The photograph may be unloadable where it is going: missing from the
  // machine (a deploy whose history never received public/media/), or wider
  // than the reader's own graphics chip can hold, which decodes and lays out
  // fine and then paints nothing. Either way the screen would stand alone
  // with no computer under it, so fall back to the drawn set, which carries
  // its own glass and keeps the two arriving as one.
  var useDrawnSet = function () {
    if (filmSlot) filmSlot.setAttribute('data-art', 'drawn');
  };
  var texMax = 0;
  try {
    var texGl = document.createElement('canvas').getContext('webgl');
    texMax = texGl ? (texGl.getParameter(texGl.MAX_TEXTURE_SIZE) || 0) : 0;
    if (texMax && texMax < 3200 && filmSlot && filmSlot.getAttribute('data-art') === 'photo') useDrawnSet();
  } catch (texErr) { /* an unanswerable chip keeps the photograph */ }
  // True when the picture is wider than the chip can upload: it will decode,
  // lay out, warm a bitmap, pass every software check — and paint nothing.
  // Measured against the file's own pixels once they are known, not against
  // a guess, because a 3200px photograph on a 2048-limit chip is exactly the
  // floating screen in the report. Unknown limits (no WebGL answer) keep the
  // photograph: most of those chips composite images just fine.
  var rigPhotoTooBig = function (img) {
    try {
      if (texMax && img && img.naturalWidth) {
        return texMax < Math.max(img.naturalWidth, img.naturalHeight || 0);
      }
    } catch (_) { /* fall through to the photograph */ }
    return false;
  };
  // Called the moment the set finally lands, so a scroll position that was
  // held at rest while the picture was still arriving can be repainted at its
  // real value. Assigned by the scrub block below once stageUpdate exists;
  // null anywhere the scrub never runs.
  // The opening scroll lock. While the intro is playing the page does not
  // move: no wheel, touch, or key may scroll until the writing has finished
  // AND the machine has landed, so nobody can scroll into a half-written
  // hero or a lone screen. Armed only inside the animated branch below;
  // everywhere else these are safe no-ops and the page scrolls as ever.
  // The scrollbar waits for the opening: it appears only once the writing
  // has finished AND the machine has landed. The head script adds
  // intro-hide-scroll before the first paint whenever the sequence will
  // play (see index.html), so no scrollbar ever shows over the blank hold
  // or the half-written hero; theme.css hides it under that class, and it
  // comes off here at the end of the arrival, with a failsafe that lets go
  // on its own. scrollbar-gutter: stable (styles.css) reserves the track
  // meanwhile, so its arrival moves nothing on the page.
  // The veil's ruling phase. The wait covers the slot with the sheet's own
  // ruling (see theme.css), and for the lines to continue across its edge
  // its background must be shifted by the slot's own distance from the top
  // of the page, modulo one ruling period. Recomputed whenever the layout
  // may have moved while the wait is still standing; once the veil is gone
  // there is nothing to align. The period lives here as a number rather
  // than read off the stylesheet because it is a fact about the artwork.
  var alignVeil = function () {
    if (!filmSlot || !filmSlot.classList.contains('rig-wait')) return;
    // The veil is the slot's own box (see the veil's inset), so the phase is
    // measured from the one edge it shares with the slot.
    var gap = 18.4;
    var box = filmSlot.getBoundingClientRect();
    var shift = -(((box.top % gap) + gap) % gap);
    filmSlot.style.setProperty('--veil-y', shift.toFixed(2) + 'px');
  };
  var introBatchDone = false;
  var showIntroScroll = function () {
    document.documentElement.classList.remove('intro-hide-scroll');
  };
  var maybeReleaseIntro = function () {
    if (introBatchDone && rigOnPage()) showIntroScroll();
  };
  var rigRelock = null;
  // Called the moment the set is on the page, with the arrival's own move
  // already running. Assigned by the banner's belt below, which is the one
  // thing on the page that waits for it: the word stands still while the
  // machine lands and sets off when it has. Null anywhere there is no belt.
  var rigLanded = null;
  // If the 4 MiB photograph still has not rasterized seconds after it was
  // asked for (slow decode, a busy compositor while the reader scrolls), stop
  // waiting on it: the drawn set carries its own glass and keeps the arrival
  // to one object rather than stranding the screen alone.
  var rigStall = 0;
  var rigStallDisarm = function () {
    if (rigStall) { window.clearTimeout(rigStall); rigStall = 0; }
  };
  var rigStallArm = function (put) {
    if (rigStall || rigOnPage()) return;
    rigStall = window.setTimeout(function () {
      rigStall = 0;
      if (rigOnPage()) return;
      useDrawnSet();
      put();
    }, 2500);
  };
  // The slot fades in only after the photograph has been given two frames to
  // rasterize and composite, so the first visible frame holds the machine and
  // its screen together. Decoding is not painting: on a 4 MiB photograph the
  // decode promise resolves while the raster is still on its way, and the
  // cheap CSS screen would fade up alone with no computer under it.
  var rigPainted = function (done) {
    var frames = 0;
    var raf = (window.requestAnimationFrame || function (fn) { window.setTimeout(fn, 50); });
    var tick = function () {
      if (++frames >= 2) { done(); return; }
      raf(tick);
    };
    raf(tick);
  };
  // Rasterize the photograph off the reveal path: an ImageBitmap is decoded
  // and uploaded before its promise resolves, so by the time the slot fades
  // in the picture is ready to composite in the same frame as the screen.
  // Anything the browser cannot answer (no bitmap API, an unloadable file)
  // falls through to the decode/load path below rather than never landing.
  var warmRigBitmap = function (img, done) {
    try {
      if (img && img.naturalWidth && typeof window.createImageBitmap === 'function') {
        window.createImageBitmap(img).then(
          function (bmp) { try { bmp.close(); } catch (_) { /* freed either way */ } done(); },
          function () { done(); }
        );
        return;
      }
    } catch (_) { /* fall through to the plain reveal below */ }
    done();
  };
  // impatient: the scrub is already asking for growth, so a photograph still
  // on the wire is the wrong thing to wait on — take the drawn set now and
  // stay one object rather than hold the page for a download mid-scroll.
  var landRig = function (impatient) {
    if (!filmSlot) return;
    // The set is one object and it lands as one: the fade-in runs only after
    // the picture below is ready to paint, so the reader never meets a screen
    // floating with no computer under it. Waiting here is the whole of the
    // fix; the slot stays hidden (rig-wait) until both halves can arrive.
    var put = function () {
      if (filmSlot.classList.contains('rig-in')) return;
      rigStallArm(put);
      rigPainted(function () {
        if (filmSlot.classList.contains('rig-in')) return;
        rigStallDisarm();
        // Last look before the fade: a file that broke while it was being
        // waited on, or pixels wider than the chip, must not be what fades
        // up. The drawn set is already in the page and paints anywhere.
        var finalArt = filmSlot.querySelector('.rig-art-photo');
        if (filmSlot.getAttribute('data-art') === 'photo' && finalArt) {
          if ((finalArt.complete && !finalArt.naturalWidth) || rigPhotoTooBig(finalArt)) {
            useDrawnSet();
          } else if (!finalArt.complete) {
            // Still on the wire: fading now is the screen arriving without
            // its computer, seconds ahead of it. Wait for the load (or its
            // failure) instead; the stall above bounds the wait and supplies
            // the drawn set, so this cannot hold the page for ever.
            finalArt.addEventListener('load', putWarmed, { once: true });
            finalArt.addEventListener('error', function () { useDrawnSet(); put(); }, { once: true });
            return;
          }
        }
        filmSlot.classList.remove('rig-wait');
        filmSlot.classList.add('rig-in');
        // ...and once the veil has finished dissolving, it stops existing (see
        // .rig-clear in theme.css). A faded-out veil is still a ruled layer at
        // the top of the slot, and the reader caught it painting its own
        // version of the sheet over the copy beside the machine. The fade and
        // the visibility switch take 0.45s and 0.5s in the stylesheet; this
        // runs a breath after both.
        window.setTimeout(function () { filmSlot.classList.add('rig-clear'); }, 560);
        if (typeof rigRelock === 'function') rigRelock();
        if (typeof rigLanded === 'function') rigLanded();
        maybeReleaseIntro();
      });
    };
    var putWarmed = function () {
      if (filmSlot.classList.contains('rig-in')) return;
      if (filmSlot.getAttribute('data-art') !== 'photo') { put(); return; }
      var img = filmSlot.querySelector('.rig-art-photo');
      // Pixels or patience, never a fade on a promise: without a natural
      // width there is nothing to paint yet, so wait for the load rather
      // than put an empty frame on the page ahead of the computer.
      if (!img) { put(); return; }
      if (img.complete && !img.naturalWidth) { useDrawnSet(); put(); return; }
      if (!img.complete) {
        img.addEventListener('load', putWarmed, { once: true });
        img.addEventListener('error', function () { useDrawnSet(); put(); }, { once: true });
        return;
      }
      if (rigPhotoTooBig(img)) { useDrawnSet(); put(); return; }
      warmRigBitmap(img, put);
    };
    if (rigOnPage()) return;
    // The stall is armed up front, not inside put: a decode that never
    // settles and a load event that never comes would otherwise wait for
    // ever with the slot hidden and the scrub held. Whatever is still
    // missing after the wait, the drawn set supplies.
    rigStallArm(put);
    var art = filmSlot.querySelector('.rig-art-photo');
    if (art && art.complete && !art.naturalWidth) { useDrawnSet(); art = null; }
    if (art && rigPhotoTooBig(art)) { useDrawnSet(); art = null; }
    // Nothing to wait for when the browser has already got it, or when it will
    // not say: the machine lands on the timer it was given rather than never.
    if (!art) { put(); return; }
    if (art.complete && art.naturalWidth) { putWarmed(); return; }
    if (impatient) { useDrawnSet(); put(); return; }
    if (art.decode) {
      art.decode().then(putWarmed, function () { useDrawnSet(); put(); });
      return;
    }
    art.addEventListener('load', putWarmed, { once: true });
    art.addEventListener('error', function () { useDrawnSet(); put(); }, { once: true });
  };
  var filmPlaying = false;
  // The reader's own answer to the film's sound, and nothing else. It starts
  // off, and every way of leaving the film, past it, or back up the page ,
  // takes it back: a film nobody is looking at should not be talking.
  var filmSoundOn = false;
  // Set when the reader stops the film with its own controls. The scroll does
  // not get to start it again until they have been away from it and come back:
  // a pause the page undoes a moment later is worse than no pause at all.
  var filmHold = false;

  // The film's two controls say what the film is doing, and they are the only
  // place the sound state lives on the page: aria-pressed is the switch, the
  // stylesheet draws the icon for it, so the two cannot disagree, and the
  // label is what a reader on a screen reader is told.
  var paintFilmControls = function () {
    if (film) film.muted = !filmSoundOn;
    if (filmSound) {
      filmSound.setAttribute('aria-pressed', filmSoundOn ? 'true' : 'false');
      filmSound.setAttribute('aria-label', filmSoundOn ? 'Film sound on. Turn it off' : 'Film sound off. Turn it on');
    }
    if (filmPlay) {
      filmPlay.setAttribute('aria-pressed', filmPlaying ? 'true' : 'false');
      filmPlay.setAttribute('aria-label', filmPlaying ? 'Pause the film' : 'Play the film');
    }
  };

  var setFilmPlaying = function (want) {
    if (!film || want === filmPlaying) return;
    // The film plays on the machine, never without it: a play asked for
    // before the set has landed starts the landing instead and leaves the
    // screen on its promise until the computer is there to keep it.
    if (want && !rigOnPage()) { landRig(); return; }
    filmPlaying = want;
    // The line on the screen is a promise the film keeps, so it goes the first
    // time the film really runs and does not come back: words over a film that
    // is already showing are the page promising the thing it is already doing.
    // The class carries the film's own controls too, which arrive with it.
    if (want && filmSlot) filmSlot.classList.add('film-open');
    if (want) {
      var started = film.play();
      if (started && started.catch) started.catch(function () { /* autoplay refused; the reader's own play control is the answer */ });
    } else {
      film.pause();
      // ...and it takes its sound with it. Leaving the film is the one thing
      // that mutes it, whoever turned the sound on.
      filmSoundOn = false;
    }
    paintFilmControls();
  };

  if (film) {
    // The film is its own control as well as the page's: a click on it stops it
    // or starts it again, and a click on one of its buttons is a click on that
    // button. Pressing play is a question asked directly and the answer is yes;
    // pressing pause is a pause, and the scroll does not get to overrule either
    // of them until the reader has been away from the film.
    var filmToggle = function () {
      if (filmPlaying) {
        filmHold = true;
        setFilmPlaying(false);
      } else {
        filmHold = false;
        setFilmPlaying(true);
      }
    };
    if (filmScreen) {
      filmScreen.addEventListener('click', function (event) {
        if (event.target.closest && event.target.closest('.film-btn')) return;
        filmToggle();
      });
    }
    if (filmPlay) filmPlay.addEventListener('click', filmToggle);
    if (filmSound) {
      filmSound.addEventListener('click', function () {
        filmSoundOn = !filmSoundOn;
        // Asking for the sound is asking for the film, so it plays, which is
        // the whole point of asking. Turning it off only turns it off.
        if (filmSoundOn && !filmPlaying) {
          filmHold = false;
          setFilmPlaying(true);
        } else {
          paintFilmControls();
        }
      });
    }
    paintFilmControls();
  }

  // How much of the film is in the window, as a share of the window itself.
  // This is the question the reader answers just by scrolling: while the screen
  // is opening the film covers all of it, and once it has gone by, over the
  // top, or back down past the bottom on the way up, this falls away and the
  // film goes with it.
  var filmVisible = function () {
    if (!filmScreen) return true;
    var rect = filmScreen.getBoundingClientRect();
    var vh = window.innerHeight || 0;
    if (!vh || !rect.height) return true;
    var seen = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    return seen > 0 && seen / vh >= 0.34;
  };

  if (stage && pin && !reduce) {
    var narrow = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;

    // Below this width there is no scrub and so no screen being opened: the
    // film is a panel standing in the row, and it runs the way a panel of film
    // runs, while it is on the screen, in either direction. (Without this the
    // play state was never asked for at all on a phone, and the film sat on its
    // colour field for as long as the page was open.)
    var paintNarrow = function () {
      stage.style.setProperty('--p', '0');
      document.documentElement.style.setProperty('--dark', '0');
      if (document.documentElement.style.colorScheme !== 'light') {
        document.documentElement.style.colorScheme = 'light';
      }
      if (!rigOnPage()) landRig();
      var panel = filmSlot ? filmSlot.getBoundingClientRect() : null;
      setFilmPlaying(rigOnPage() && !!panel && panel.bottom > window.innerHeight * 0.2 && panel.top < window.innerHeight * 0.8);
      if (typeof overDark === 'function') overDark();
    };

    // Everything the opening screen is drawn from, for one value of the
    // reader's position in it. It is only ever ONE number, the section's own
    // --p, so there is still nothing to keep in step: the number below is the
    // whole of the move, and this writes it and everything the page reads off
    // it, in one pass.
    var paintStage = function (p) {
      var rect = stage.getBoundingClientRect();
      // While the set has not landed the scrub is held at rest: the slot is
      // still hidden, so growing it would grow a transparent box, darken the
      // room around nothing, and open a film with no machine under it — the
      // floating screen in the report. The real p is kept in stageAim/stageP;
      // only the painted value waits, and rigRelock repaints it on landing.
      var landed = rigOnPage();
      var pe = landed ? p : 0;
      stage.style.setProperty('--p', pe.toFixed(4));
      // The room lights. One number, written where the head can read it as well
      // as the section: 0 is the sheet on paper and 1 is the dark the picture is
      // shown in. It comes up over the second half of the screen's growth, so
      // by the time the picture has taken the window there is no paper left
      // anywhere on the screen, the head included, and the change is a ramp
      // rather than a switch. Eased at both ends, because a room does not go
      // dark at a constant rate and a straight line reads as a fade on a
      // slider.
      var grow = Math.min(1, pe / 0.55);
      var dark = (grow - 0.3) / 0.55;
      dark = dark < 0 ? 0 : (dark > 1 ? 1 : dark);
      dark = dark * dark * (3 - 2 * dark);
      // And it is a question about the room the reader is in, not about how far
      // they have scrolled: how much of the window the set still covers. While
      // the set is pinned that is all of it; once it starts to leave, the paper
      // comes back with it. By then the set IS the film, the grown screen fills
      // the window, so this is the amount of film left on the screen, and the
      // room should be as dark as that and no darker. Without it the ramp only
      // let go when the whole section was above the window, and for the last
      // screenful of the exit the head and the scrollbar stayed black over a page
      // that had gone back to paper.
      //
      // The ends are pulled in on purpose: the room keeps its ink while the film
      // is most of the window, and has given all of it back by the time what is
      // left of the film is a hand's width at the top. A crossfade that ran the
      // whole length of the exit would spend it half-way between the two.
      var pinBottom = Math.min(pin.offsetHeight, rect.bottom);
      var leaving = pinBottom / pin.offsetHeight;
      leaving = (leaving - 0.25) / 0.3;
      leaving = leaving < 0 ? 0 : (leaving > 1 ? 1 : leaving);
      dark = dark * leaving;
      if (rect.bottom <= 0) dark = 0;
      document.documentElement.style.setProperty('--dark', dark.toFixed(4));
      // The scrollbar is the one strip of the window this page does not draw,
      // and a pale one down the edge of a black film is the last piece of paper
      // left on the screen. theme.css colours it from the same number (which
      // covers every browser that can mix a colour); this is the other half of
      // it, for the scrollbars that are drawn by the browser itself.
      var scheme = dark > 0.5 ? 'dark' : 'light';
      if (document.documentElement.style.colorScheme !== scheme) {
        document.documentElement.style.colorScheme = scheme;
      }
      // If the reader has moved at all before the set has landed, it lands now:
      // an arriving machine is one thing, a screen that has grown to the window
      // and is still transparent is a hole in the page. It is still one object
      // landing, so it goes through the same door as the sequence's own landing
      // and waits for the picture if the picture is what is missing.
      if (p > 0.02) landRig(p > 0.1);
      // The film comes on when the screen it is on has arrived, which is what
      // the panel promises: scroll to play. It goes off again, and goes quiet
      //, the moment it is no longer the thing the reader is looking at, which
      // is the same question asked on the way down and on the way up, so it is
      // asked once: past the section, or back below it, or with the film itself
      // most of the way off the window. A film still running while the reader
      // reads something else is only work. (rect is the section's own box,
      // taken just above.)
      var wantPlay = landed && pe > 0.45 && rect.bottom > 0 && filmVisible();
      if (!wantPlay) filmHold = false;
      setFilmPlaying(wantPlay && !filmHold);
      // Whether the head is standing on the picture is asked below, by
      // overDark, of the picture's own box - the same question the film band's
      // crossing is asked of, so there is one answer rather than two. It used
      // to be answered here, off the SLOT (the whole panel the machine is
      // drawn on) and off the room's own ramp, and both were wrong in the last
      // screenful of the section: the slot is bigger than the film, so the bar
      // came away over paper, and the ramp is measured on the section's
      // leaving edge, so it went back to paper while the picture was still
      // behind the bar. See the note in overDark.
      if (typeof overDark === 'function') overDark();
    };

    // Where the reader is in the section, clamped, read here rather than
    // inside the paint, because the follow below needs it on the frames between
    // two scroll events as well as on the events themselves.
    var stageTarget = function () {
      var rect = stage.getBoundingClientRect();
      var travel = stage.offsetHeight - pin.offsetHeight;
      var p = travel > 0 ? -rect.top / travel : 0;
      return p < 0 ? 0 : (p > 1 ? 1 : p);
    };

    // The reader's position and the position the page is DRAWN from, which are
    // two numbers rather than one, and that is the whole of the smoothness.
    // A wheel arrives as a row of steps and a trackpad's as a row of smaller
    // ones, and a set that is drawn straight from the reader's own steps steps
    // with them: the machine is a thing with weight, and weight does not move
    // in ticks. So the drawn number follows the reader's, a fifth of the gap
    // every 60th of a second, which is home in about a third of a second and
    // moving the whole way there, and the reader may keep scrolling while it
    // does: it is the reader's number it follows, not the one it started on.
    // The rate is written per frame at 60Hz and applied per elapsed frame, so a
    // 120Hz screen does not get twice the follow.
    var stageAim = 0;     // where the reader is
    var stageP = 0;       // where the page is drawn
    var following = false;
    var lastFrame = 0;
    var follow = function (now) {
      // A frame asked for before the width changed to one with no scrub in it
      // is a frame with nothing to draw: the narrow pass has already written
      // the state the section is in at that width.
      if (!following) return;
      var dt = lastFrame ? now - lastFrame : 16.667;
      lastFrame = now;
      if (dt > 64) dt = 64;
      stageP += (stageAim - stageP) * (1 - Math.pow(1 - 0.21, dt / 16.667));
      if (Math.abs(stageAim - stageP) < 0.0005) {
        stageP = stageAim;
        following = false;
      }
      paintStage(stageP);
      if (following) requestAnimationFrame(follow);
    };
    // One way in, so the two readers of it, the scroll and the resize, cannot
    // disagree about the state the follow is in. `jump` is for the first pass
    // and nothing else: a page restored half way down its own opening screen
    // should open where the reader left it, not animate there.
    var stageUpdate = function (jump) {
      if (narrow && narrow.matches) {
        following = false;
        stageP = 0;
        stageAim = 0;
        paintNarrow();
        return;
      }
      stageAim = stageTarget();
      if (jump) stageP = stageAim;
      if (!following) {
        following = true;
        lastFrame = 0;
        requestAnimationFrame(follow);
      }
    };
    // The scrub's repaint, handed to the landing above: when the set lands
    // after an early scroll, the held-at-rest paint is replaced with the
    // reader's real position on the next frame.
    rigRelock = function () { stageUpdate(false); };
    var ticking = false;
    var onStageScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; stageUpdate(false); });
    };
    window.addEventListener('scroll', onStageScroll, { passive: true });
    window.addEventListener('resize', onStageScroll);
    stageUpdate(true);
  } else if (film) {
    // Nowhere to scrub, a phone, a reader who asked for less motion, or one of
    // the other pages, so the film runs while it is on screen instead.
    film.muted = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !rigOnPage()) { landRig(); setFilmPlaying(false); return; }
          setFilmPlaying(entry.isIntersecting);
        });
      }, { threshold: 0.25 }).observe(film);
    }
  }

  // ------------------------------------------------------------ the banner
  // The giant word slides sideways, and it does it whether or not the reader
  // is moving: it turns on its own at the speed the reference's does ,
  // measured off the reference's own recording, its word travels about 3.5% of
  // the window's width every second with nobody touching anything. That is all
  // it does. It used to answer the scroll on top of its own drift, and the
  // scroll had no business in it: a word that runs off to the left as the
  // reader moves down the page reads as something the reader is dragging
  // rather than as a belt that was already turning, which is the whole point
  // of it. The page's subject is that things move while nobody is watching, so
  // the word moves while nobody is watching and holds its own pace.
  //
  // The belt holds four copies of the word with a slant between each pair, so
  // the shift is taken modulo one copy: at any moment the window shows the
  // words that happen to be under it, and the belt never runs out at either
  // end.
  var banner = document.querySelector('.banner');
  var track = banner ? banner.querySelector('.banner-track') : null;
  var unit = 0;

  // ------------------------------------------------- the mark's own height
  // The slant between two words is set like a letter, and a letter is not the
  // em: it is the font's capital, and it stands on the baseline. Those two
  // numbers used to be measured here, off the face, and published to CSS as
  // lengths - which is a mark that is PAINTED in one place (the stylesheet's
  // approximation, the only thing true at the first paint) and then moved to
  // another when this script runs, and moved again every time a webfont landed
  // and a re-measure found a different face. That is the slant the reader sees
  // drop onto its baseline a beat after arriving, and the words after it slide
  // sideways as its box grows. They are the face's own shares of the em and
  // nothing else - 0.8070 of it is the capital, 0.0658 is where the baseline
  // falls inside a 0.84 line - so they are written down in theme.css, on
  // .banner-track beside the word's own place, where they are true before the
  // first paint and stay true at every size. Nothing here places the mark: a
  // mark placed by a deferred script is placed after the reader has already
  // seen it somewhere else.

  if (track && !reduce) {
    // Windows per second, and the reference's own rate: 3.5% of the window a
    // second, measured off its recording, which is what the reader asked for by
    // name. It was cut to a thirtieth of this for a while on the argument that
    // a slow belt keeps the word sitting where the reference puts it, and that
    // was the wrong trade: a belt that takes a minute to cross the paper does
    // not read as a belt at all, it reads as a still word, and the one thing
    // this page is about is that things move while nobody is watching. The
    // words-band further down the page has always turned at this rate; the two
    // are the same belt and they agree again.
    var DRIFT = 0.035; // windows per second, the word's own rate
    // WHERE THE BELT STANDS is the stylesheet's business now, and this is all
    // that is left here: the turning. The word is painted in the reference's
    // opening frame - the paper it and its slant leave over, halved, see
    // .banner-track - and is never placed from here, because a belt placed by a
    // deferred script is placed after the page has already been painted, and
    // that is a word seen to jump sideways a beat after the reader arrives.
    //
    // This block used to place it: measured off the type, and on a return from
    // the phase the belt had reached on whatever page the reader had come from,
    // both written to the sheet after it had been painted. Both are gone. What
    // a belt does is travel, and it travels from the frame it is standing in.
    var driftPx = 0;
    var driftLast = 0;
    var beltLive = false;
    // How long the belt takes to reach that pace from a standstill, and how much
    // of it has passed. The belt is not already turning when the reader arrives:
    // the machine is only now landing on the sheet, so the word stands in its
    // frame while that happens and sets off when it is over. The rate it sets
    // off at is this ramp's - nothing at the first frame, the belt's own 3.5% of
    // a window a second by the end of it, gathering the whole way - and the
    // travel it has made is the ramp's own sum, so the beginning reads as
    // something setting off rather than as a word that was jerked into motion.
    // From RAMP on it is exactly the belt the reference has, at exactly its
    // pace, because that is what a belt is.
    var RAMP = 0.9;
    var beltAge = 0;
    var measure = function () {
      var kids = track.children;
      // The distance from one word to the next is the length of the repeating
      // unit, measured rather than assumed, because it is type, and re-measured
      // when the type changes because the travel is taken modulo it.
      unit = kids.length > 2 ? kids[2].offsetLeft - kids[0].offsetLeft : 0;
    };
    var paint = function () {
      if (!unit) return;
      // Travel only, taken modulo one copy of the word: the belt is a repeating
      // pattern, so standing one copy along it is the same belt with a different
      // copy of the word under the window, and the strip carries the copies for
      // exactly this. Nothing is added to what stands and nothing taken away: a
      // re-measure can only move the belt by whole copies, which is no move at
      // all.
      banner.style.setProperty('--banner-shift', (driftPx % unit).toFixed(2) + 'px');
    };
    var step = function (now) {
      if (driftLast) {
        var dt = (now - driftLast) / 1000;
        beltAge += dt;
        var k = beltAge >= RAMP ? 1 : beltAge / RAMP;
        driftPx += dt * DRIFT * window.innerWidth * k * k;
      }
      driftLast = now;
      paint();
      if (beltLive && !document.hidden) requestAnimationFrame(step);
    };
    var setLive = function (on) {
      var was = beltLive;
      beltLive = on && !document.hidden;
      if (beltLive && !was) requestAnimationFrame(step);
      else if (!beltLive) driftLast = 0;
    };
    var onScreen = false;
    // The belt turns when it is being looked at AND the opening is over. The
    // two are separate because they arrive in that order: the reader lands, the
    // machine comes down onto the sheet, and only then does the word begin to
    // travel. See openingOver below.
    var beltOpen = !filmSlot;
    var beltHold = 0;
    var syncLive = function () { setLive(onScreen && beltOpen); };
    // A transition's own length in milliseconds, as the stylesheet wrote it. The
    // first value of the list is the one asked about - the rise's and the fade's
    // - and the unit is read rather than assumed. Read rather than written here
    // so the belt cannot set off while the move it is waiting on is still
    // running, and cannot stand still after the numbers in the stylesheet
    // change.
    var cssMs = function (v) {
      var n = parseFloat(v) || 0;
      return /ms/.test(String(v)) ? n : n * 1000;
    };
    // THE OPENING COMES FIRST. The machine lands on this page whenever its
    // picture is ready - on a return that is the whole of the arrival, and on a
    // first visit it is the end of the writing - and it lands with a move: the
    // slot rises into its place while the veil comes off it. The belt waits for
    // both halves of that and sets off when the move is over, so the opening is
    // read in the order it was composed in: the page standing still, the machine
    // arriving, and then the word beginning to turn. On a page with no machine
    // to wait for, the belt is free at once; and if the landing somehow never
    // comes, the word is let go on a timer of its own rather than standing for
    // ever because another part of the page failed.
    var openingOver = function () {
      beltOpen = true;
      if (beltHold) { window.clearTimeout(beltHold); beltHold = 0; }
      if (!filmSlot) { syncLive(); return; }
      window.setTimeout(syncLive, Math.round(Math.max(
        cssMs(window.getComputedStyle(filmSlot).transitionDuration),
        cssMs(window.getComputedStyle(filmSlot, '::after').transitionDuration)
      )));
    };
    rigLanded = openingOver;
    if (!beltOpen) beltHold = window.setTimeout(openingOver, 6000);

    measure();
    // Every page the reader arrives on meets the belt in its own opening frame
    // and turns from there. It used to carry its phase across pages, on the
    // argument that a belt the reader comes back to should be one that kept
    // running while they were away; that is a good thing to mean and it was
    // paid for with the word jumping sideways on arrival, which is not. The
    // film wall below still keeps the session's clock, which is a row that is
    // off screen when the reader lands and can afford to.
    paint();
    window.addEventListener('resize', function () { measure(); paint(); });
    document.addEventListener('visibilitychange', syncLive, false);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); paint(); });
    // Only while it is on screen: a belt turning at the top of a long page is
    // work nobody is watching, and it is meant to be seen, not to run.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { onScreen = entry.isIntersecting; syncLive(); });
      }, { threshold: 0 }).observe(banner);
    } else {
      onScreen = true;
      syncLive();
    }
  }
  // The film wall keeps its own time across pages too: every row resumes
  // mid-slide off the session's clock rather than restarting its loop.
  if (!reduce) {
    try {
      var beltT0 = 0;
      try { beltT0 = parseInt(window.sessionStorage.getItem('palimpsest-belt-t0') || '0', 10) || 0; } catch (_) {}
      if (!beltT0) {
        beltT0 = Date.now();
        try { window.sessionStorage.setItem('palimpsest-belt-t0', String(beltT0)); } catch (_) {}
      }
      var fase = ((Date.now() - beltT0) / 1000);
      var grows = document.querySelectorAll('.film-row, .film-disc');
      for (var gi = 0; gi < grows.length; gi++) {
        var gdur = parseFloat(window.getComputedStyle(grows[gi]).animationDuration) || 0;
        if (gdur > 0) grows[gi].style.animationDelay = (-(fase % gdur)).toFixed(3) + 's';
      }
    } catch (_) { /* rows start at their written delays */ }
  }

  // --------------------------------------------------- the band of addresses
  // The band has two moves in it, and neither of them has anything to do with
  // the scroll.
  //
  // The first is an ARRIVAL, once. The three steps come in from beyond the
  // right-hand edge, the light orange first, then the deeper one under it,
  // then the red, each one setting out further than the last, which is the
  // staircase the reference opens with, and close up flush with the band's own
  // left edge; the row of nameplates comes in with them and lands on the sheet.
  //
  // The second is the BELT: from then on the row turns to the left by itself,
  // continuously, forever, at the same 3.5% of a window per second the word at
  // the head of the page turns at, and it sleeps while it is off screen exactly
  // as that word does. It is NOT tied to the scroll. Panning the row in
  // proportion to the scroll makes it a thing that only moves while the reader
  // is moving and freezes the instant they stop, which is not a belt and is not
  // what the top of the page does.
  //
  // Both moves are written here rather than in the stylesheet for the reason
  // the word's belt is: they have to be added together before either one is
  // painted, and the belt is taken modulo one repeat of the row, and the row
  // is type, so its length is measured rather than assumed. The stylesheet does
  // one thing in all this, which is to park the steps and the row out beyond
  // the right-hand edge before anything is painted (.band-wait), so the band
  // cannot settle into place and then jump.
  var band = document.querySelector('.words-band');
  var plates = band ? band.querySelector('.plates-track') : null;
  var steps = band ? band.querySelectorAll('.words-stripes span') : null;
  if (band && plates && steps && steps.length === 3 && !reduce) {
    var BAND_DRIFT = 0.035;   // windows per second, the word's own rate
    var BAND_ARRIVE = 1250;   // ms one mover takes to come home
    var BAND_STEP_REACH = [0.83, 1.05, 1.23];  // where each step sets out, in windows
    var BAND_STEP_LAG = [0, 110, 220];         // ms, the staircase's own stagger
    var BAND_ROW_REACH = 0.96;                 // where the row sets out, in windows
    var BAND_ROW_LAG = 60;                     // ms behind the lightest step
    var bandUnit = 0;         // one repeat of the row, in px
    var bandPx = 0;           // how far the belt has turned, in px
    var bandLast = 0;
    var bandLive = false;     // the rAF loop is running
    var bandArmed = false;    // the arrival has been let go
    var bandArrived = false;  // ...and has finished
    var bandStart = 0;        // ms the arrival was let go, 0 before that
    var bandOnScreen = false;
    var clock = function () {
      return window.performance && window.performance.now ? window.performance.now() : Date.now();
    };
    // One curve for every mover here, fast away from the edge, slow into
    // place, so the three steps and the row cannot land at different rhythms.
    var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
    // One mover's share of its own reach: 1 leaves it parked, 0 puts it home.
    var shareLeft = function (lagMs, now) {
      var t = bandArrived ? 1 : (bandStart ? (now - bandStart - lagMs) / BAND_ARRIVE : 0);
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      return 1 - easeOut(t);
    };
    var measurePlates = function () {
      var kids = plates.children;
      var i, copy;
      // The distance from the first plate to the ninth is the length of the
      // repeating unit, measured rather than assumed, because the plates are
      // type and the row is however wide the names make it.
      bandUnit = kids.length > 8 ? kids[8].offsetLeft - kids[0].offsetLeft : 0;
      // The belt is taken modulo that unit, so the row has to be longer than
      // the window by a whole unit or its tail would come home empty: on a wide
      // window sixteen plates are not enough, and the first eight are copied as
      // many times as it takes. The copies are decoration, the markup already
      // carries the second set that way, so they are kept out of the reading
      // order. The first eight are never touched, which is why the ninth is
      // still the head of the second set.
      while (bandUnit && plates.scrollWidth < window.innerWidth + bandUnit * 2) {
        for (i = 0; i < 8; i++) {
          copy = kids[i].cloneNode(true);
          copy.setAttribute('aria-hidden', 'true');
          copy.setAttribute('tabindex', '-1');
          plates.appendChild(copy);
        }
      }
    };
    var paintPlates = function () {
      if (!bandUnit) return;
      var now = clock();
      var i, px;
      for (i = 0; i < 3; i++) {
        px = shareLeft(BAND_STEP_LAG[i], now) * BAND_STEP_REACH[i] * window.innerWidth;
        steps[i].style.transform = 'translate3d(' + px.toFixed(2) + 'px, 0, 0)';
      }
      px = shareLeft(BAND_ROW_LAG, now) * BAND_ROW_REACH * window.innerWidth;
      if (bandStart && now - bandStart - BAND_ROW_LAG >= BAND_ARRIVE) bandArrived = true;
      // The belt is subtracted, so the row leaves to the left, taking the
      // remainder of one unit each time round: the eight plates are in the
      // markup twice for exactly this, so the wrap can never be seen.
      plates.style.transform = 'translate3d(' + (px - (bandPx % bandUnit)).toFixed(2) + 'px, 0, 0)';
    };
    var stepPlates = function (now) {
      if (bandLast) bandPx += ((now - bandLast) / 1000) * BAND_DRIFT * window.innerWidth;
      bandLast = now;
      paintPlates();
      if (bandLive && !document.hidden) requestAnimationFrame(stepPlates);
    };
    var setBelt = function (on) {
      var was = bandLive;
      bandLive = on && !document.hidden;
      if (bandLive && !was) requestAnimationFrame(stepPlates);
      else if (!bandLive) bandLast = 0;
    };
    // Armed before the first paint: a band that has already arrived when the
    // reader gets to it is not an arrival, and a reader with no script gets the
    // settled band without any of this.
    band.classList.add('band-wait');
    var letItGo = function () {
      if (bandArmed) return;
      bandArmed = true;
      measurePlates();
      bandStart = clock();
      paintPlates();
      setBelt(bandOnScreen);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          bandOnScreen = entry.isIntersecting;
          if (bandOnScreen) letItGo();
          setBelt(bandArmed && bandOnScreen);
        });
      }, { threshold: 0 }).observe(band);
    } else {
      bandOnScreen = true;
      letItGo();
    }
    document.addEventListener('visibilitychange', function () {
      setBelt(bandArmed && bandOnScreen);
    }, false);
    // The unit is type, so it changes when the type does; the belt is taken
    // modulo it, so a resize has to re-measure before it paints again.
    var onBandResize = function () { measurePlates(); paintPlates(); };
    window.addEventListener('resize', onBandResize);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { measurePlates(); paintPlates(); });
    }
  }

  // ------------------------------------------------------------ the sections
  // Below 760px the four section links are a menu behind a button in the head.
  // Which width that is, and what the panel looks like, are the stylesheet's
  // business (see the menu block in theme.css): a breakpoint is a shape. What
  // is here is only what a shape cannot do - open, close, and say which it is.
  //
  // It is a disclosure, not a dialog. The links are in the document whether the
  // panel is open or shut; the button says which (aria-expanded); and every way
  // out closes it - the button again, Escape (which puts the reader back on the
  // button that opened it, not on the page), a press anywhere else, and the
  // window becoming wide enough that the button is gone. Nothing is copied into
  // a second list and nothing is built here, so the hrefs the address-carrying
  // code below writes into these links are the hrefs the reader follows.
  (function sectionsMenu() {
    var toggle = document.getElementById('navToggle');
    var menu = document.getElementById('navMenu');
    if (!toggle || !menu) return;
    var isOpen = function () { return menu.classList.contains('is-open'); };
    var setOpen = function (want) {
      menu.classList.toggle('is-open', want);
      toggle.setAttribute('aria-expanded', want ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () { setOpen(!isOpen()); });
    // A press on the page behind the panel closes it. The button is left out
    // because its own click is the toggle, and pressing it twice in one gesture
    // would close what it had just opened.
    document.addEventListener('pointerdown', function (e) {
      if (!isOpen()) return;
      if (toggle.contains(e.target) || menu.contains(e.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (!isOpen() || (e.key !== 'Escape' && e.key !== 'Esc')) return;
      setOpen(false);
      toggle.focus();
    });
    // The panel may only be open where the button is: a window widened past the
    // breakpoint hides the button and shows the row, and a panel still marked
    // open would spring up the moment the window narrowed again.
    var wide = window.matchMedia ? window.matchMedia('(min-width: 761px)') : null;
    var onWide = function () { if (!wide || wide.matches) setOpen(false); };
    if (wide) {
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
    // A page restored from the back/forward cache keeps the DOM it was left
    // with, open panel and all; the reader is arriving again, so it is shut.
    window.addEventListener('pageshow', function () { setOpen(false); });
  })();

  // --------------------------------------------------------------- the head
  // The head inverts over a dark band, so the labels stay readable where the
  // sheet is black. The bands are found rather than listed: anything painted
  // ink is one, and the test is a rect against the head's own band, which is
  // the only thing that is true at every scroll position.
  var head = document.querySelector('.site-head');
  var darks = document.querySelectorAll('.film-band, [data-dark]');
  // The row the labels stand in, as boxes: the wordmark and the four links. It
  // is the row - not the bar - that the label colours are read against, so the
  // labels answer to what is behind THEM.
  var rowParts = [];
  if (head) {
    var brandWord = head.querySelector('.brand-word');
    var navLinks = head.querySelector('.nav-links');
    // The menu button is the row on a narrow window - it stands where the four
    // labels stand on a wide one, so it is measured as one of them and hands
    // over to the light pair at the same moment they do. On a wide window it is
    // display:none and its box has no height, which is why it is skipped there.
    var navToggle = head.querySelector('.nav-toggle');
    if (brandWord) rowParts.push(brandWord);
    if (navLinks) rowParts.push(navLinks);
    if (navToggle) rowParts.push(navToggle);
  }

  // The head's height, the opening screen's frame and the glass inside the
  // machine are all measured in the PAGE, by the script that stands in the
  // middle of the hero (see index.html): they are what the hero is laid out
  // from, and a measurement taken here - a deferred script, half a second after
  // the browser has painted - is a page that rearranges itself under the
  // reader's eye. On this page, then, there is nothing left to measure at the
  // start: what belongs here is the two moments those numbers can honestly
  // change again, a resize and the fonts landing under the type.
  //
  // Both re-runs are no-ops in the ordinary case, and that is the point: the
  // values they would write are the ones already standing. They are kept
  // because a window resized while the reader is on another tab, or a font
  // whose metrics differ from the fallback's, is a real change and the screen
  // has to follow it rather than stay the size the last window was.
  var publishFit = typeof window.palimpsestFit === 'function' ? window.palimpsestFit : null;
  if (publishFit) {
    window.addEventListener('resize', function () { publishFit(); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { publishFit(); });
    }
  }

  if (head && darks.length) {
    // THE BAR IS PAINTED THE PAGE, WHERE THE PAGE IS - NOT A COLOUR FOR IT.
    //
    // Three things can stand behind the bar, and they are not the same shape:
    //   the ROOM's ramp (--dark), a fraction of ink the veil has already put
    //     over the opening screen - a colour the whole page is wearing, the same
    //     at every height of the bar;
    //   the dark PANELS - the film band and anything marked dark - which are
    //     rectangles crossing the bar, so what matters is not how dark they are
    //     but WHERE their edges are: a section's edge sliding up behind the bar
    //     puts a hard edge across it, and the bar has to show that edge in the
    //     same place, on the same frame, as the page behind it does;
    //   the FILM PICTURE, which is not a colour at all - it is a photograph in a
    //     box - so it cannot be painted: the bar gets out of its way instead,
    //     exactly where it is.
    //
    // So this asks each of them one question - where does your edge cross the
    // bar - and writes where, not how much: --head-a and --head-b are the
    // fractions of the bar's height where the topmost of them begins and ends,
    // and --head-layer is what it is made of (the ink for a panel, transparent
    // for the picture). The fill in theme.css is a stack of the page's own
    // surfaces between those stops, which is the page's own colour at every row
    // of the bar.
    //
    // Ask the AMOUNT instead - how much of the bar is dark - and a section's
    // edge arriving is painted as a grey bar lying on a black section for the
    // whole fifty pixels of scroll the edge takes to pass, and the film is
    // hidden behind a black bar for eighty and then handed back in one go. Ask
    // the place and there is nothing to average: the bar does not have a colour
    // of its own, so it cannot be the wrong one.
    var overDark = function () {
      var band = head.getBoundingClientRect();
      var tall = band.height || 1;
      // The room's own number, handed straight through: the veil is already a
      // mix of paper and ink, and this is the fraction of it.
      var ramp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dark')) || 0;
      ramp = ramp < 0 ? 0 : ramp > 1 ? 1 : ramp;
      // The label row, in the bar's own coordinates: one row of type across the
      // head, and it is what is behind THAT - not what is behind the bar - that
      // the labels have to be read against.
      var rowTop = Infinity;
      var rowBottom = -Infinity;
      for (var k = 0; k < rowParts.length; k++) {
        var q = rowParts[k].getBoundingClientRect();
        if (!q.height) continue;
        if (q.top < rowTop) rowTop = q.top;
        if (q.bottom > rowBottom) rowBottom = q.bottom;
      }
      var rTop = rowTop - band.top;
      var rBottom = rowBottom - band.top;
      var rowTall = rBottom - rTop > 1 ? rBottom - rTop : 1;
      // The topmost thing behind the bar, and how much of the label row it
      // covers. (They do not overlap each other on this page; if two ever did,
      // the one the reader meets first at the top of the bar is the one that
      // paints, which is what the topmost band does on the page too.)
      var a = 1;
      var b = 1;
      var layer = 'transparent';
      var rowDark = 0;
      var consider = function (box, isPanel) {
        var top = box.top - band.top;
        var bottom = box.bottom - band.top;
        if (bottom <= 0 || top >= tall) return;
        var starts = top <= 0 ? 0 : top / tall;
        var ends = bottom >= tall ? 1 : bottom / tall;
        if (starts < a) {
          a = starts;
          b = ends;
          // A panel paints its own ink below the boundary; the picture paints
          // nothing at all, because there the fill is a hole (theme.css masks
          // the sheet away under --head-a) and the film is what is behind it.
          layer = isPanel ? 'var(--ink)' : 'transparent';
        }
        var overRow = Math.min(rBottom, bottom) - Math.max(rTop, top);
        if (overRow > 0) rowDark = Math.max(rowDark, overRow / rowTall);
      };
      for (var d = 0; d < darks.length; d++) {
        var panel = darks[d].getBoundingClientRect();
        if (panel.height) consider(panel, true);
      }
      // AND THEN THE ONE THING BEHIND THE BAR THAT IS NOT A PANEL: THE FILM
      // ITSELF. It is a photograph in a box, so it is not painted at all - the
      // bar leaves a hole where the picture is, at the frame its edge reaches
      // it, and the film is the film through exactly the pixels it is the film
      // on. Nothing is held back for a later frame and nothing is handed back in
      // one go: the picture's edge crosses the bar at the speed the page moves.
      if (filmScreen) {
        var picture = filmScreen.getBoundingClientRect();
        if (picture.height) consider(picture, false);
      }
      head.style.setProperty('--head-ramp', ramp.toFixed(4));
      head.style.setProperty('--head-a', a.toFixed(4));
      head.style.setProperty('--head-b', b.toFixed(4));
      head.style.setProperty('--head-layer', layer);
      // AND THE LABELS, which are the one thing that cannot be the page: a
      // colour on its way from paper to ink passes THROUGH the fill, and a label
      // the colour of the bar it stands on is not a label. So there are two
      // numbers instead of a fill, and both are read off the row.
      //
      // The first is the sheet's own label grey travelling to the page's ink as
      // the bar leaves the sheet, over the first eighth of the darkening. It is
      // quick on purpose: the grey is a colour FOR paper (#6f665c is 4.9:1 on
      // the sheet and already 2.6:1 on a bar a fifth of the way to ink), so it
      // has to be gone before the bar stops being paper. What it becomes is the
      // darkest thing on the row, and it stays that until the hand-over.
      var behind = Math.max(ramp, rowDark);
      var grey = Math.min(1, behind / 0.12);
      head.style.setProperty('--head-grey', grey.toFixed(4));
      //
      // The second is the hand-over between the two pairs, and there are two
      // ways it can happen, because there are two ways the row can go dark:
      //
      //  - the ROOM, where the paper under the row fades to ink as one colour and
      //    there is one frame where the row is the SAME distance from both pairs:
      //    #767070, 0.582 of the way to ink, about 4:1 either side. The
      //    hand-over is put exactly there and is a few pixels of scroll wide.
      //  - a BOUNDARY - a panel's edge, or the picture's - which crosses the row
      //    as a hard line. Above and below it the row is one colour and the
      //    labels take that side's pair; while the line is inside the row itself
      //    neither pair is right and the row is a mix of the two, so the labels
      //    are the neutral between the pairs, which reads on both halves (3.6:1
      //    on the sheet, 4.5:1 on the ink) for the twenty pixels of scroll the
      //    line takes to cross the row. That is the most legible a row of labels
      //    can be while a black edge is passing through it, and it is shorter
      //    than the time it takes to read one of them.
      var t;
      if (rowDark >= 0.7) {
        t = 1;
      } else if (rowDark <= 0.3) {
        var x = Math.max(0, Math.min(1, (ramp - 0.582) / 0.004));
        t = x * x * (3 - 2 * x);
      } else {
        t = 0.5;
      }
      head.style.setProperty('--head-label', t.toFixed(4));
    };
    var headTicking = false;
    var onHeadScroll = function () {
      if (headTicking) return;
      headTicking = true;
      requestAnimationFrame(function () { headTicking = false; overDark(); });
    };
    window.addEventListener('scroll', onHeadScroll, { passive: true });
    window.addEventListener('resize', onHeadScroll);
    overDark();
    // AND THE SAME QUESTION AFTER EVERYTHING THAT CAN MOVE A RECT WITHOUT A
    // SCROLL. The number is read off boxes, and a box settles for other reasons
    // than the reader scrolling - the picture arriving, the fonts landing, a tab
    // coming back out of the back/forward cache, a phone turned on its side.
    // Asking once, at the start, is a page whose second frame can disagree with
    // its first, which is a bar in the sheet's colour over a film until the
    // reader nudges it.
    var askAgain = function () { overDark(); };
    window.addEventListener('load', askAgain);
    window.addEventListener('pageshow', askAgain);
    window.addEventListener('orientationchange', askAgain);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(askAgain);
    if (typeof ResizeObserver === 'function') {
      // The picture's box is a share of the slot and moves with the scrub, so
      // this watches the scrub as well: the fill cannot be a frame behind the
      // thing it describes.
      var headWatch = new ResizeObserver(askAgain);
      headWatch.observe(head);
      if (filmScreen) headWatch.observe(filmScreen);
    }
  }

  // ------------------------------------------------------ the set's screen
  // The film plays in the monitor's glass and nowhere else: the screen laid over
  // the glass has to be in exactly the same place as the glass or the reader
  // sees two rectangles arguing about where the picture is. The glass is read
  // against the slot and four shares of the slot are published for the
  // stylesheet to use. The set is the slot, the desk is `inset: 0` of it, and
  // the slot holds the desk's own proportion at every scroll position, so a
  // share of it is the same shape at every position too: measure once and the
  // answer holds for the whole move. That one measurement is taken in the page
  // with the other two (see window.palimpsestFit in index.html); nothing is
  // done with the glass here.

  // ------------------------------------------------------------ year fields
  // The two ends of the range. The Archive's own coverage starts in 1996 and
  // has no end, so the list does: every year it could hold a capture of, which
  // is 1996 up to this one. Filled here rather than written into the page so
  // the list is never a year out of date, and "Any year" is first so the
  // default reading is the whole record.
  var fromSel = document.getElementById('fromYear');
  var toSel = document.getElementById('toYear');
  if (fromSel && toSel && !fromSel.options.length) {
    var thisYear = new Date().getFullYear();
    var blank = function () {
      var o = document.createElement('option');
      o.value = '';
      o.textContent = 'Any year';
      return o;
    };
    fromSel.appendChild(blank());
    toSel.appendChild(blank());
    for (var y = thisYear; y >= 1996; y--) {
      var a = document.createElement('option');
      a.value = String(y);
      a.textContent = String(y);
      fromSel.appendChild(a);
      var b = document.createElement('option');
      b.value = String(y);
      b.textContent = String(y);
      toSel.appendChild(b);
    }
  }

  // --------------------------------------- compare hero holds its landing
  // The card is centered in the first screen on arrival and must not move
  // when the timeline and workspace appear below it, yet the landing itself
  // must never scroll at any window size.
  //
  // The height itself is the stylesheet's business, and it gets it right
  // before the page is ever painted: the paper frame is a flex column one
  // screen tall, the head and foot take what they need, and the hero fills
  // the rest (see theme.css). Nothing here corrects it on arrival, because a
  // correction is exactly the bug: any value written after the first layout
  // that differs by a pixel is a page whose scrollbar appears and then goes,
  // and a centered card that slides a few pixels while it does.
  //
  // What this does is pin that height, so the timeline arriving underneath
  // cannot shrink it (the hero would hand the new content its space) or grow
  // it (stretched on a screen with room to spare). The height written is the
  // same subtraction the column has already made, so on arrival it changes
  // nothing at all - the writes below are the backstops, not the landing.
  //
  // Two things can still change the furniture around it afterwards: a resize,
  // and the webfont landing late. The head and the footer are both type on a
  // wrapped row, so their heights follow the font: the nav goes to two rows at
  // 480px in the webfont and not in the fallback, and the footer wraps 16px
  // taller at 320px. Pinning the arrival's height through that would leave the
  // page a dozen pixels taller than the window - the scrollbar arriving late
  // instead of leaving late, the same complaint from the other end. So the
  // height is simply worked out again when the type lands, which is what a
  // header that has just changed shape should do.
  var cmpHero = document.querySelector('.compare-page .page-hero');
  if (cmpHero) {
    var cmpHead = document.querySelector('.compare-page .site-head');
    var cmpFoot = document.querySelector('.compare-page .site-footer');
    var cmpMain = document.querySelector('.compare-page .page-main');
    var fitCmpHero = function () {
      if (!cmpHead || !cmpFoot || !cmpMain) return;
      var pad = getComputedStyle(cmpMain);
      var chrome = cmpHead.getBoundingClientRect().height +
        cmpFoot.getBoundingClientRect().height +
        parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
      var next = Math.max(0, window.innerHeight - chrome) + 'px';
      if (cmpHero.style.minHeight === next) return;
      cmpHero.style.minHeight = next;
      // Not `flex: 1` any more: on a screen tall enough to have space left
      // over once the timeline is filled in, growth would move the card.
      cmpHero.style.flex = '0 0 auto';
    };
    fitCmpHero();
    window.addEventListener('resize', fitCmpHero);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitCmpHero);
  }

  // ------------------------------------------- the address follows the reader
  // Every page carries the same hero: an address field plus links to the
  // other pages, and every reading page can arrive with ?url= and act on
  // it. So the nav links carry whatever is typed: moving between pages
  // never drops the address the reader already entered, and the next page
  // loads it exactly as if it had been typed there. The page's own reader
  // (compare's timeline, claims' report) owns its form; this only rewrites
  // the way out, never the reading itself.
  (function carryAddress() {
    var input = document.getElementById('urlInput') ||
      document.getElementById('cwInput') ||
      document.getElementById('srInput') ||
      document.querySelector('form.url-form input[name="url"]');
    if (!input) return;
    var links = Array.prototype.slice.call(
      document.querySelectorAll('.nav-links a.nav-link'));
    if (!links.length) return;
    var base = links.map(function (a) { return a.getAttribute('href') || ''; });
    var sync = function () {
      var typed = (input.value || '').trim();
      links.forEach(function (a, i) {
        var page = (base[i] || '').split('?')[0].split('#')[0];
        if (!page || page.charAt(0) !== '/') return;
        a.setAttribute('href', typed ? page + '?url=' + encodeURIComponent(typed) : page);
      });
    };
    input.addEventListener('input', sync);
    sync();
  })();

  // ---------------------------------------------------------------- chips
  // The demo addresses under the search field. The pages that run a reading on
  // the spot wire their own chips; this is for the front page, whose form is a
  // plain GET handing the address to the compare page, and a chip there has to
  // keep meaning what it has always meant, one click and the address is being
  // read, so it sends the form rather than only filling it in.
  //
  // The compare page is told apart by its timeline: that element exists on no
  // other page, and app.js is already the owner of the form wherever it does.
  var form = document.getElementById('urlForm');
  var input = document.getElementById('urlInput');
  if (form && input && !document.getElementById('timelineSection')) {
    Array.prototype.forEach.call(form.querySelectorAll('.chip[data-url]'), function (chip) {
      chip.addEventListener('click', function () {
        input.value = chip.getAttribute('data-url');
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      });
    });
  }

  // ------------------------------------------------------------- the arrivals
  // The reference's type does not sit on the page, it arrives on it: every word
  // comes up from under the line it is set on, a little below it, as the
  // reference's own does, and it comes up one piece at a time, the pieces
  // following each other from left to right without a pause between them. That
  // is the whole animation, and it is the same one on every marked element on
  // this page: the giant word, the line under it, the four columns of the
  // opening screen, the statement, the three ways, the record line, the screen
  // at the foot. Nothing slides in from the side and nothing fades in as a
  // block; the line is the edge everything comes over, which is what makes the
  // page read as being written rather than wiped on.
  //
  // Two things are decided here and nothing else is. The first is the split: a
  // marked element is dealt out into spans, one per word, or one per LETTER
  // when it is set in the display voice and meant to be read from across the
  // room, and each span is the thing that moves. The split does not touch the
  // text: the spans hold the same characters in the same order, spaces are left
  // as spaces so the line still breaks where it should, and a drawn mark inside
  // a line (the specimen, an arrow, an icon) travels as one piece because it is
  // one object rather than a word of type. A reader with no script, or one who
  // asked for less motion, gets the sentence, this file is the only thing that
  // wraps anything.
  //
  // The second is how far a piece has to travel to be out of sight, and that is
  // MEASURED off the face rather than chosen. The mask's edge is the bottom of
  // the line box, so the distance is the box below the baseline plus the height
  // of a capital: a 20px line box on a face with 1.02em of ascent and 0.27em of
  // descent puts its baseline 15.2px down and hides a 21px capital after 5.8px
  // more. Hard-coding that number is how a heading set at 12.6vh and a caption
  // set at 24px end up with one of them half out of its mask, and this page has
  // five sizes of type under it. The measure is re-taken on resize and when the
  // webfont lands, because both change it.
  var reveals = document.querySelectorAll('[data-reveal]');

  // The face's own numbers, in em: the capital's ink height and the widths of
  // the ascent and descent. Null when the browser will not report them, in
  // which case the stylesheet's own default stands.
  var faceBox = function (el) {
    var cs = window.getComputedStyle(el);
    var size = parseFloat(cs.fontSize);
    if (!size) return null;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + size + 'px ' + cs.fontFamily;
    var m = ctx.measureText('H');
    var cap = m.actualBoundingBoxAscent;
    var asc = m.fontBoundingBoxAscent;
    var desc = m.fontBoundingBoxDescent;
    if (!cap || !asc || !desc) return null;
    return { cap: cap / size, asc: asc / size, desc: desc / size };
  };

  // How far, in em of this element's own type, a piece has to sit below where
  // it belongs in order to be behind the line. The mask is the line box plus
  // the hair of room the stylesheet clips below it (see .rv-w).
  var maskDepth = function (el) {
    var cs = window.getComputedStyle(el);
    var size = parseFloat(cs.fontSize);
    var face = faceBox(el);
    if (!face || !size) return 1.2; // no metrics: the stylesheet's own fallback
    var box = parseFloat(cs.lineHeight);
    if (!box || isNaN(box)) box = (face.asc + face.desc) * size;
    var baseline = (box - (face.asc + face.desc) * size) / 2 + face.asc * size;
    var below = box - baseline;          // the edge, measured off the baseline
    return (below + face.cap * size) / size + 0.12;
  };

  // How far a unit travels, written onto the element as --rv-t. For type that
  // is the measure above; for a drawing it is its own height, because a drawn
  // mark is not set on a line of text, it is as deep as it is tall, and it is
  // out of sight when it stands one of its own heights below the line.
  var travel = function (el) {
    if (el.classList.contains('rv-draw')) {
      var h = el.getBoundingClientRect().height;
      return (h ? Math.round(h) : 60) + 8 + 'px';
    }
    return maskDepth(el).toFixed(3) + 'em';
  };

  var revealList = [];
  // What each block costs to deal out, its duration, the wait between its
  // pieces and how many pieces it has, kept here rather than read back off the
  // element, because the sequence below is spaced by it.
  var timing = new Map();
  // How long one piece takes and how long the longest block may take. Both are
  // short, because the sequence is one block at a time: six blocks of a second
  // and a half each is nine seconds of the page introducing itself, and nobody
  // asked for that. These two numbers are the whole pace of the page.
  var LETTER_DUR = 0.5;
  var WORD_DUR = 0.42;
  var MAX_BLOCK = 0.75;
  // Whether the first-paint hold is still on. The inline script in the head
  // puts it on before the first paint, and nothing takes it off except the
  // sequence below or the stylesheet's own backstop, seconds later, if this
  // script never arrives in time. If it is already gone, the page has been
  // visible — released by that backstop after a slow load — and dealing the
  // blocks now would hide finished text just to write it in again, which is
  // exactly the flash. So a late arrival leaves the page as it stands:
  // everything visible, the machine landed, no sequence run.
  var held = document.documentElement.classList.contains('rv-armed');
  // ...and whether the backstop already showed the page. The hold releases
  // itself after a few seconds if this script never arrives; the class is
  // still on the root when that happens, so the class alone cannot tell a
  // held page from a shown one. A held block is visibility:hidden by the
  // rule above, so a block already reading visible means the reader has seen
  // the finished page — and dealing now would hide it just to write it in
  // again, which is exactly the flash.
  var firstBlock = document.querySelector('[data-reveal]');
  var backstopFired = !!(held && firstBlock &&
    window.getComputedStyle(firstBlock).visibility === 'visible');
  // Whether this load earns the opening sequence. A cold arrival (new tab,
  // fresh session) and a reload both play it; arriving from another page in
  // the same session skips it — the assets are cached and re-writing the
  // page is ceremony. The flag is read before it is written so it reflects
  // earlier loads, then set for the next ones. If storage refuses (private
  // mode) every load plays, which is the safe side; if the timing API is
  // missing the arrival reads as a reload, which plays too.
  var navType = 'reload';
  try {
    var navEntries = window.performance && window.performance.getEntriesByType &&
      window.performance.getEntriesByType('navigation');
    if (navEntries && navEntries.length && navEntries[0].type) navType = navEntries[0].type;
  } catch (_) { /* unknown arrival plays the sequence */ }
  var homeSeen = false;
  try { homeSeen = !!window.sessionStorage.getItem('palimpsest-home-seen'); } catch (_) { /* plays */ }
  try { window.sessionStorage.setItem('palimpsest-home-seen', '1'); } catch (_) { /* plays */ }
  var skipIntro = homeSeen && (navType === 'navigate' || navType === 'back_forward');
  if (reveals.length && !reduce && held && !backstopFired && !skipIntro) {
    // The scrollbar's own failsafe: the batch timer and the landing below
    // take the class off together, whichever comes last, but a photograph
    // that never answers must not trap the page without a scrollbar for
    // ever, so this lets go on its own rather than ever sticking.
    window.setTimeout(showIntroScroll, 8000);
    alignVeil();
    window.addEventListener('resize', alignVeil);
    // How long each piece takes and how far behind the one before it starts.
    // The reference runs about one letter every 70ms and finishes a word before
    // the eye leaves it; the gap is opened up a little for words, which are
    // wider, and closed down for a long block so that nothing is still arriving
    // after a second and a half.
    var build = function (el) {
      var mode = el.getAttribute('data-reveal') || 'words';
      // A drawing is not dealt out: an SVG cannot hold the spans the split
      // makes, and a mark is one object rather than a word of type. So it is
      // wrapped in a span of its own, the attribute moves to the wrapper, and
      // the whole of it travels together, see .rv-draw in theme.css.
      if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        var wrap = document.createElement('span');
        wrap.className = 'rv-draw';
        wrap.setAttribute('data-reveal', mode);
        el.removeAttribute('data-reveal');
        el.parentNode.insertBefore(wrap, el);
        wrap.appendChild(el);
        el = wrap;
      }
      var plan = [];
      var walk = function (node) {
        if (node.nodeType === 3) {
          var parts = node.nodeValue.split(/(\s+)/);
          for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!part) continue;
            if (/^\s+$/.test(part)) { plan.push({ space: part }); continue; }
            if (mode === 'letters') {
              for (var c = 0; c < part.length; c++) plan.push({ text: part.charAt(c) });
            } else {
              plan.push({ text: part });
            }
          }
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { plan.push({ br: true }); return; }
        // One object, not a word of type: it travels whole.
        plan.push({ node: node.cloneNode(true) });
      };
      var kids = Array.prototype.slice.call(el.childNodes);
      for (var k = 0; k < kids.length; k++) walk(kids[k]);
      if (!plan.length) return;

      var frag = document.createDocumentFragment();
      var index = 0;
      var shown = 0;
      // The pieces themselves, in the order they are written, because each one
      // needs a second place besides its own: where it stands in the arrival's
      // queue, and where it stands in the departure's, see the reverse below.
      var masks = [];
      for (var i = 0; i < plan.length; i++) {
        var item = plan[i];
        if (item.space) { frag.appendChild(document.createTextNode(item.space)); continue; }
        if (item.br) { frag.appendChild(document.createElement('br')); continue; }
        var mask = document.createElement('span');
        mask.className = 'rv-w';
        var inner = document.createElement('span');
        inner.className = 'rv-i';
        if (item.node) inner.appendChild(item.node);
        else inner.textContent = item.text;
        mask.appendChild(inner);
        mask.style.setProperty('--i', String(index++));
        masks.push(mask);
        frag.appendChild(mask);
        shown++;
      }
      el.textContent = '';
      el.appendChild(frag);
      el.style.setProperty('--rv-t', travel(el));
      var dur = mode === 'letters' ? LETTER_DUR : WORD_DUR;
      var gap = mode === 'letters' ? 0.03 : 0.055;
      // No block takes longer than this, however many pieces it has. A paragraph
      // is a lot of words, and the sequence below waits for each block to finish
      // before it starts the next one, so an uncapped paragraph is a second and
      // a half of the page holding still, six times over. Past this the words
      // close up and the paragraph arrives as one wave, which is what a
      // paragraph arriving quickly looks like.
      var room = MAX_BLOCK - dur;
      if (shown > 1 && (shown - 1) * gap > room) gap = room / (shown - 1);
      // The departure's queue, written onto the pieces now because it is a
      // fact about the block and not about the moment it leaves: the reverse of
      // the arrival, so the piece that came up last goes down first and a
      // sentence is read off the page backwards, word by word, which is the
      // exact opposite of the way it was written on. (The gap is used instead
      // of the pieces' own --i places because the gap itself has just been
      // closed up for a long block, and the reverse has to be the reverse of
      // the arrival the reader actually saw.)
      for (var m = 0; m < masks.length; m++) {
        masks[m].style.setProperty('--rv-b', ((shown - 1 - m) * gap).toFixed(3) + 's');
      }
      el.style.setProperty('--rv-gap', gap.toFixed(3) + 's');
      el.style.setProperty('--rv-dur', dur + 's');
      el.classList.add('rv-ready');
      revealList.push(el);
      timing.set(el, { dur: dur, gap: gap, shown: shown });
    };

    for (var r = 0; r < reveals.length; r++) build(reveals[r]);

    // ------------------------------------------- one sequence, in page order
    // The page is written in rather than switched on: the word first, then the
    // line under it, then the columns down the sheet, one block after another
    // with each starting before the one before it has finished. Two things are
    // decided here.
    //
    // The first is that the sequence is a NUMBER OF SECONDS written onto each
    // block (--rv-lag, added to the piece's own place inside the block, see
    // theme.css) rather than a queue of callbacks. A block waiting its turn is
    // hidden under its own line the whole time it waits, because its animation
    // fills its start state, so a block's turn costs nothing to keep.
    //
    // The second is where a block's turn comes from: the blocks themselves. A
    // block is half as long again as its own animation takes, and the next one
    // starts halfway through that, which is what the reference does, and it
    // means the sequence keeps its cadence whether the reader loads the page or
    // scrolls into the middle of it.
    var clock = function () {
      return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    };
    var blockMs = function (el) {
      var t = timing.get(el);
      return t ? (t.dur + (t.shown - 1) * t.gap) * 1000 : 700;
    };
    // Where in the block before it the next block starts, as a share of the
    // block's own length. Just past the end of it: a block is written in and
    // then the next one is, in order, with only a hair between them. It used to
    // be a half, so the second paragraph of a pair was already coming up while
    // the first was still arriving, which reads as everything moving at once,
    // and is exactly what the reader said he did not want. (It is also what
    // fixes when the computer lands, since the set waits for the last line to
    // finish: one block at a time is what makes that quick.)
    var OVERLAP = 1.04;
    // How long a block may wait for its turn once the reader is MOVING, in
    // seconds. The sequence is what the page does when it is being read from
    // the top and nothing else is happening; it is not a queue the reader's own
    // scrolling has to sit behind. A reader who flicks down twenty blocks at
    // once would otherwise be watching a page write itself in for the next nine
    // seconds, so past this the arrivals bunch up instead, they were already
    // arriving faster than they could be read.
    var MAX_WAIT = 1.2;
    var chainAt = 0;      // when the next block may start, on the same clock
    var slots = {};       // a group of parallel copies shares one turn in a batch
    var left = revealList.length;
    // When the batch just dealt has finished arriving, the end of its last
    // block, not the start. The set below is waited on until then.
    var batchEnd = 0;
    // ----------------------------------------------------------------- leaving
    // The page is read downwards, and these two are the only way anything is
    // ever taken back off it. A block that is revealed and standing below the
    // window is a block the reader has gone back up past: it leaves the way it
    // came, in reverse, and it is dealt again if they turn round a second time.
    // Nothing is taken away for having been scrolled off the TOP: a block the
    // reader has read is read, and re-writing the page behind them as they go
    // down it would be the page undoing its own work in front of them.
    //
    // The timers are the animation's own length, which is a fact about the
    // block and is already known here, the alternative is listening for
    // animationend on the last piece of every block, and a block is dealt again
    // whenever the reader turns round, so the class has to come off on a clock
    // that the arrival can also cancel.
    var departTimers = new Map();
    // Put a block back under its line at once, with no animation: what the
    // arrival does when it starts, and what a departure that has run its course
    // has already done for itself.
    var stay = function (el) {
      var timer = departTimers.get(el);
      if (timer) { window.clearTimeout(timer); departTimers.delete(el); }
      el.classList.remove('rv-out');
    };
    var depart = function (el, box, vh) {
      if (el.classList.contains('rv-out')) return;
      var t = timing.get(el);
      stay(el);
      el.classList.remove('rv-in');
      // A block more than a window below the fold is not being watched: it is
      // simply not here, and it is standing under its line by the time the
      // reader turns round. Anything closer than that is watched off the page.
      if (!t || box.top - vh > vh) return;
      el.classList.add('rv-out');
      departTimers.set(el, window.setTimeout(function () {
        departTimers.delete(el);
        el.classList.remove('rv-out');
      }, blockMs(el) + 90));
    };
    var deal = function (el, past) {
      // Being dealt again cancels a departure that is still on its way out: the
      // reader has turned back towards the block, so it comes back up from
      // wherever it had got to rather than finishing the way out first.
      stay(el);
      // A block the reader has already gone past is not being watched: it takes
      // no turn, so a jump down the page cannot leave a queue of arrivals
      // happening behind the reader one by one at nothing.
      if (past) { el.classList.add('rv-in'); left--; return; }
      var at;
      var group = el.getAttribute('data-reveal-group');
      if (group && slots[group] !== undefined) {
        // Parallel copies of one thing, the four words on the belt are a
        // single word written four times, take one turn between them, or the
        // sequence would spend four turns on the same word.
        at = slots[group];
      } else {
        at = Math.max(clock(), chainAt);
        var ceiling = clock() + MAX_WAIT * 1000;
        if (!firstPass && at > ceiling) at = ceiling;
        chainAt = !firstPass ? Math.min(at + blockMs(el) * OVERLAP, ceiling) : at + blockMs(el) * OVERLAP;
        if (group) slots[group] = at;
      }
      if (at + blockMs(el) > batchEnd) batchEnd = at + blockMs(el);
      var wait = at - clock();
      // Written every time rather than only when there is a wait: a block that
      // has been read, left and dealt again keeps whatever it was last given,
      // and the last thing it was given was its place in a sequence that has
      // been and gone.
      el.style.setProperty('--rv-lag', (wait > 8 ? (wait / 1000).toFixed(3) : '0') + 's');
      el.classList.add('rv-in');
      left--;
    };

    // The observer does not deal anything: it says when to look again, because
    // a block can come into the window for a reason that is not a scroll, a
    // resize, a webfont landing and pushing the page down, a picture arriving.
    // Whatever the reason, the answer is the one loop below, in one order.
    var arrive = null;
    if ('IntersectionObserver' in window) {
      arrive = new IntersectionObserver(function () {
        sweep();
        if (!left && arrive) arrive.disconnect();
      }, { rootMargin: '0px 0px -25% 0px', threshold: 0 });
      for (var a = 0; a < revealList.length; a++) arrive.observe(revealList[a]);
    }

    // The one loop that deals anything, walking the blocks in the order they
    // are on the page. It is a loop and not a callback per block for the same
    // reason the sequence is a number: two blocks that come up the window
    // together have to be dealt in the order they are read, and the order
    // callbacks arrive in is not the order the page is in.
    //
    // Five cases decide a turn. A block that has come up to three quarters of
    // the window has arrived. A block the reader has already gone past is dealt
    // on the spot (the second argument), it was between two readings of the
    // loop and is behind them now. The foot of the page is a case of its own:
    // the last quarter of the window never counts as arrived there and the page
    // ends before anything can scroll into it. And the page's own opening is a
    // case of its own too: everything on the first screen is written in when
    // the page loads, whether or not it reaches the line, because there is no
    // scrolling past the opening screen, a column of it waiting for a scroll
    // is a hole in the first thing the reader sees.
    //
    // The fifth case is the reader going the other way, and it is the only one
    // that takes something off the page: a block that is revealed and whose top
    // is at or below the foot of the window has been scrolled back up past, and
    // it is read off the page in the reverse of the way it was written on. The
    // test is a place and not a direction, a block can only be under the
    // reader's feet like that if they moved up past it, so nothing has to be
    // kept about which way the page is going, and the same reading of the loop
    // deals arrivals and departures in one order down the page.
    var firstPass = true;
    var sweep = function () {
      var vh = window.innerHeight;
      // The chain starts again at every reading of the loop: two blocks that
      // cross the line between the same two readings are one batch and take
      // their turns one after the other, and a block that crosses the line on
      // its own is not waiting behind anything, the reader scrolled it in and
      // it is written in as it arrives. The groups go with it, for the same
      // reason: a shared turn is a turn within one batch.
      chainAt = 0;
      slots = {};
      var atFoot = window.scrollY + vh >= document.documentElement.scrollHeight - 4;
      for (var i = 0; i < revealList.length; i++) {
        var el = revealList[i];
        if (el.classList.contains('rv-in')) {
          var back = el.getBoundingClientRect();
          if (back.top >= vh) depart(el, back, vh);
          continue;
        }
        var box = el.getBoundingClientRect();
        if (box.bottom < 0) { deal(el, true); continue; }
        if (box.top < vh * 0.75 || atFoot || (firstPass && box.top < vh)) deal(el);
      }
      firstPass = false;
    };
    var sweepQueued = false;
    window.addEventListener('scroll', function () {
      if (sweepQueued) return;
      sweepQueued = true;
      requestAnimationFrame(function () { sweepQueued = false; sweep(); });
    }, { passive: true });
    window.addEventListener('resize', sweep);
    // THE WRITING STARTS ON THE SCRIPT'S OWN TURN, AND IT USED NOT TO.
    //
    // The page is about type, and its type was fetched from a font host, so the
    // opening used to wait for the display face before dealing anything out: a
    // block dealt early plays against letters that are not there yet and is
    // spent by the time they arrive. The wait was up to a second and a half,
    // and until it was over the hero was a held, empty screen - the reader saw
    // exactly that, more than once, and said so: the word missing from a hero
    // whose other text was already standing.
    //
    // There is nothing to wait for any more. The display face is served from
    // this origin and preloaded (see the @font-face notes in theme.css), so it
    // is in the cache before the first paint in practice; and if it ever is
    // not, the fallback it falls back to is aliased to occupy Oswald's own box,
    // so the word holds its width, its baseline and its line while the real
    // face arrives. Waiting would cost the thing the wait was meant to protect.
    var beginOpening = function () {
      if (!('IntersectionObserver' in window)) {
        for (var b = 0; b < revealList.length; b++) deal(revealList[b]);
      } else {
        sweep();
      }

      // ------------------------------------------------- the one that is not type
      // One thing on the opening screen is not a block of type and so cannot be
      // dealt out by the sequence: the computer the film is played on. It is
      // given the turn of one, and theme.css moves it in from there.
      //
      // THE BELT IS NOT DEALT, AND THAT IS THE READER'S OWN DOING. It used to be
      // the first block written in - four copies of the word and three slants,
      // each arriving on its own turn - and then it was held back instead while
      // the display face was fetched, which left the hero with no word on it at
      // all until the face landed. Both are gone: the word and its slant are
      // painted where they stand, from the first paint, and NOTHING moves them.
      // The reader's sentence for it is "I want the PALIMPSEST to be here and
      // then when the computer comes it needs to start the animation thing",
      // and that is exactly what happens now: the word stands still while the
      // machine lands, and the belt's turn - its only movement, and a thing the
      // reader asked for by name - begins the moment the set is on the page (see
      // rigLanded below, which is where the belt is started).
      //
      // The set comes in last, after the last line has finished rather than after
      // the last line has started: the writing is the page and the machine is what
      // the writing is about, so the machine lands once there is nothing left to
      // read. (batchEnd is the end of the batch just dealt, the whole first
      // screen, so this is one timer for the whole page rather than one per
      // block.)
      if (filmSlot) {
        filmSlot.classList.add('rig-wait');
        window.setTimeout(function () {
          // The set arrives as one thing: the timer says when it is due, and the
          // picture says whether it is all here. See landRig above. The batch
          // being done is half of the scrollbar's release; the landing is
          // the other half.
          landRig();
          introBatchDone = true;
          maybeReleaseIntro();
        }, Math.max(0, batchEnd - clock()) + 150);
      }

      // The hold in the stylesheet, let go — and it is let go here rather than
      // anywhere else because this is the one moment at which it is true that
      // every block has something to be hidden by: each of them has been dealt
      // out and armed above (--rv-t, its own turn, its pieces' places), and the
      // machine is waiting on its timer. Before this line the blocks would have
      // shown in their finished state for the length of a frame; after it, they
      // are held exactly the way the arrivals expect to find them. A block with
      // nothing in it was never armed and is simply visible, which is right:
      // there is nothing to write in — and the belt is the standing proof of it,
      // being no longer a block at all (see above).
      document.documentElement.classList.remove('rv-armed');
    };
    var openingBegun = false;
    var beginOnce = function () {
      if (openingBegun) return;
      openingBegun = true;
      beginOpening();
    };
    beginOnce();

    // The distance to travel is type, so it changes when the type does.
    var remeasure = function () {
      for (var i = 0; i < revealList.length; i++) {
        revealList[i].style.setProperty('--rv-t', travel(revealList[i]));
      }
    };
    window.addEventListener('resize', remeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { remeasure(); alignVeil(); });
  } else {
    // Nothing is being dealt out — this page marks no blocks, or the reader
    // asked for less motion, or this script arrived after the hold already let
    // go and the page is standing finished, or this is a return that skips the
    // opening altogether — so the first-paint hold comes off at once: there is
    // nothing for it to hold, and leaving it on would only be a page whose
    // words appear seconds after it did.
    document.documentElement.classList.remove('rv-armed');
    showIntroScroll();
    // The set is still waiting (rig-wait is marked in the HTML, not here), and
    // what it waits under is the veil, so the sheet's ruling has to be aligned
    // to the page in this branch exactly as it is in the animated one above.
    // The wait and the veil are both the same on a return as on a first visit -
    // the veil is what keeps the screen and its computer from arriving one ahead
    // of the other, and the rise and the dissolve that follow are the only
    // arrival this page has left, so they are the ones it gets. See the
    // skip-intro note in theme.css.
    alignVeil();
    window.addEventListener('resize', alignVeil);
    if (filmSlot) landRig();
  }

  // -------------------------------------------------------- the film's disc
  // The disc behind the red word is the reference's one held image: it is there
  // while the screen is arriving, and it resolves away once the film is really
  // being watched, leaving the outlined word inside it, which is the whole
  // entrance. Marked when the band comes into view rather than on a timer, so
  // it happens when the reader gets there and not while the page is still
  // loading, and marked once, because it is an arrival and not a state.
  // The scrollbar follows the room into the dark film band: while the band
  // covers the middle of the window the page is black edge to edge, so a pale
  // scrollbar would be the last strip of paper left on the screen. Toggled on
  // scroll and resize alongside the head state, so it comes and goes with the
  // room rather than sticking after the band has left.
  var filmBand = document.querySelector('.film-band');
  var paintFilmChrome = function () {
    if (!filmBand) return;
    var r = filmBand.getBoundingClientRect();
    var mid = window.innerHeight / 2;
    var inside = r.top <= mid && r.bottom >= mid;
    document.documentElement.classList.toggle('film-dark', inside);
  };
  window.addEventListener('scroll', function () {
    if (!paintFilmChrome.ticking) {
      paintFilmChrome.ticking = true;
      requestAnimationFrame(function () { paintFilmChrome.ticking = false; paintFilmChrome(); });
    }
  }, { passive: true });
  window.addEventListener('resize', paintFilmChrome);
  paintFilmChrome();
  if (filmBand && !reduce) {
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries, observer) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          filmBand.classList.add('film-live');
          observer.disconnect();
        });
      }, { threshold: 0.35 }).observe(filmBand);
    } else {
      filmBand.classList.add('film-live');
    }
  }
})();
