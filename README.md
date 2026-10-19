# Palimpsest

Palimpsest is a project of the D^4 Sustainable Futures Lab at McMaster
University, led by Dr. Cansu Ekmekcioglu, Assistant Professor of Information
Systems in the DeGroote School of Business. You can read more about her work
at [ekmekcioglu.website](https://ekmekcioglu.website/).

Palimpsest traces how a website has changed over time. Enter an address, then
drag the two handles across a timeline of the Wayback Machine's captures. The
app shows exactly what was added, removed, or edited between those two
moments, side by side, with every change outlined on the page itself. From
there you can open a dashboard of the whole history, play the record back as a
timelapse, take notes, or ask an AI assistant to look up what likely caused a
change.

Two smaller pages sit beside the tracer. **Claim records** follows the promises
a site made and the day each one stopped being said. **Settlement research** is
a placeholder for the same reading applied to settlement sites. It does not
work yet, and the form says so when submitted.

## What happens under the hood

- **The timeline** comes from the Wayback Machine's CDX API, an index of every
  snapshot the Internet Archive holds for a URL. Requests use
  `collapse=digest`, so consecutive captures with identical content collapse
  into one point. The slider only shows moments when the page actually
  changed.
- **The diff** is not a text diff. The server parses both snapshots into DOM
  trees, breaks each into content blocks (paragraphs, headings, links, images,
  list items), and runs a sequence diff over those blocks, the same way
  `git diff` matches lines. That is what distinguishes a reworded paragraph
  from a deletion plus an unrelated insertion.
- **Snapshots render in sandboxed iframes.** The archived page's own CSS and
  JavaScript cannot leak into the app. Script tags are stripped before
  rendering, and the sandbox blocks scripts even if one slips through.
- **Notes and cached pages live in Turso**, a hosted libSQL database reached
  through `@libsql/client`. Tables are created on first request, so an empty
  database is enough.
- **The Insight panel** uses Gemini with Google Search first, so an explanation
  can draw on news and context from the relevant dates instead of relying on
  memory. Without a Gemini key it falls back to NVIDIA, which reasons from the
  diff alone and says so.

## Running it

You need Node.js 18 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Fill `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`, then open
`http://localhost:3000`.

Those two variables are the only requirement. Get the URL with
`turso db show <name> --url` and create a token with
`turso db tokens create <name>`. The AI keys are optional. Without them
everything works except the Insight tab, which explains that it is not
configured instead of failing silently.

## The record store

The dashboard and the timelapse answer the same question: what did a site look
like at each capture, and what changed between captures? They used to fetch
that separately. The dashboard sampled twenty-eight transitions and kept only
the counts, and the timelapse then walked the whole record again, fetching
pages the first walk had already discarded.

Now there is one reading, owned by `public/archiveStore.js`. Whichever view you
open first pays for it; the other finds it already stored. On a 740-capture
record, the first view makes 739 requests and the second makes none, opening in
242ms. The reverse order behaves the same way. If you open the second view
while the first is still running, it attaches to the same reading instead of
starting another one, so both progress bars agree.

The store keeps the following in IndexedDB, under one namespaced key per
capture:

- every archived page, stored on disk rather than on the heap;
- a manifest row per site with the record's signature (capture count and first
  and last timestamps), plus, for each capture, what changed into it, the
  per-tag breakdown, and whether its page is on disk.

The signature prevents a stale record from being replayed. Re-trace a site and
get a different list, and everything under the old signature is dropped rather
than mixed with the new data.

An interrupted reading resumes. The manifest is written by a walk that picks up
every step it already has, so closing the tab mid-read only costs the part that
had not happened yet. A failed step is retried on the next visit instead of
being remembered as permanently missing, and any page a failed step still owed
is fetched on its own at the end. In practice there are usually none.

If IndexedDB is unavailable, because of a private window, a blocked origin, or
a full disk, nothing throws. Pages fall back to an in-memory Map, the reading
still completes, and both views still work. The cost is heap, and the data does
not survive a reload.

## The timelapse

The timelapse plays the record back in order: every capture on file, one frame
each, as a real archived page rendered in a browser-window stage and dissolved
into the next.

There is no sampling and no cap, because there is nothing to sample. The
snapshot list already uses `collapse=digest`, so every entry is a moment the
page genuinely changed.

It opens on the numbers and streams the pages in behind itself. Phase one is a
single small request, `GET /api/record?url&countsOnly=1`, measured at 220ms and
87KB for a 741-capture record once its counts are compiled. That response says
how many captures this machine already holds and gives the rail every number it
will draw. If all the captures are present, the film opens immediately, since
each page is one disk read away. Pages follow in slices (`&from=&limit=`),
written to disk as they arrive, in playback order. The next opening then costs
nothing.

On settlement.org, with the local store emptied first, the film was ready 151ms
after the request. A 16x run from that cold start played 175 frames with a
median gap of 169ms against a 163ms beat, using 14 API requests for the whole
session. The previous design needed 740 requests before it could draw a single
frame.

That change replaced a walk of one request per adjacent pair of captures. That
walk was the reason a film could sit on "retrieving capture 1 of 741" for
minutes: 740 sequential round trips, each re-reading both pages and re-running
the diff, for a history the database already held.

The genuinely slow part is fetching from the Archive. `lib/rateLimiter.js`
starts no two requests to web.archive.org closer together than 1.1s across the
whole process, so a 740-capture record takes over thirteen minutes to fetch the
first time any machine reads it. That cost is paid once per site per server,
not once per visitor, because `lib/fetchHtml.js` caches every document
permanently in Turso under `${url}::${timestamp}`. You wait once, and the card
says so: "Reading 741 captures from the Archive", with the year reached and the
time left.

Every wait in `public/archiveStore.js` has a deadline (`arFetchJson`), and the
reading gives up rather than hanging. A dozen captures asked for with nothing
coming back means the server has stopped answering, not that the record has
holes, and the card says that instead of waiting forever.

### Frames are shown complete

A capture becomes a frame only when its document has loaded, its stylesheets
have applied, every arriving image has been decoded into pixels, its fonts have
settled, and the browser has painted it (`tlWaitPainted`).

That promise costs a wait, so the film pays it before playback rather than in
the middle. The stage is a pool of twelve iframes, each holding one fully
rendered capture. Frames ahead of the playhead load while the transport reports
progress, and Play unlocks once the runway at the current pace is complete: four
frames at 1x and ten at 16x. After that a beat is two opacity values changing.
Measured at 16x, frames advance every 164 to 166ms on a beat of 162.5ms.

Nothing is dropped to keep a clock. If the next capture is not ready, the
current picture stays on screen, the status light names the capture being
waited for, and the film moves when it is complete. This matters because the
alternative was tried: a capture shown as soon as it parsed, with images still
arriving, reads as an unfinished page at 16x. A frame that arrives half rendered
records how fast the network was, not what the site looked like. The one thing
stepped over is a capture the Archive cannot produce at all, which is a hole in
the record rather than a slow frame, and it is named on screen.

### Assets are fetched once and kept

This is what makes the film fast. The Archive rewrites each capture's markup so
that its pictures carry that capture's timestamp,
`/web/20010107135200im_/<original>`. The same logo therefore has a different URL
in every frame, and a resource the Archive has not served recently comes out of
cold storage at two to three seconds a time. The slice measured here asked for
2,251 distinct asset URLs that were really 128 files. The film was paying
seconds per picture, per frame, for a large amount of duplicate work.

So the app keeps its own copy. `tlCanonicalize` reduces every asset URL to one
URL per original, pinned to the version the run met first, and points it at
`/api/asset`. That route fetches from the Archive once, writes the bytes to
`data/assets/`, and serves them from disk from then on. A warm asset is a file
read over loopback: 2ms, in any later frame and any later session. Stylesheets
are cached the same way, with their `url()` references rewritten to the same
route as they are stored, so a background image is not a cold fetch inside a
frame.

Relative URLs are rewritten too. The URLs the Archive rewrites are the ones it
can see. A relative URL is resolved by the browser against a base, and that base
is web.archive.org. So `images/crest.gif`, a font named by a stylesheet, and a
background in an inline style all went to the Archive for the whole film, at two
to twelve seconds each, on the render path. Fonts were refused outright, because
a cross-origin webfont needs a CORS header the Archive does not send. A rendered
capture whose font came from the Archive took 5.4s to become a frame. The same
capture with its font served locally takes under 0.6s.

The fix is one substitution. `tlProxyBase` points the document's base at
`/api/asset-dir/<timestamp><modifier>/<original url>`, which is the same cache
addressed by path so that a relative URL appended to it still resolves. Every
relative URL on the page then routes through this app's cache at once, with no
attribute parsing. The tail is kept byte for byte, because a relative URL's
meaning is exactly that shape. As with absolute assets, the timestamp is pinned
per original for the length of a run, so the same file has one address in frame
3 and frame 700.

The rewriting comes in two shapes. Wayback names a capture's assets either
absolutely, `https://web.archive.org/web/<timestamp><modifier>/<original>`, or
root-relatively, `/web/<timestamp><modifier>/<original>`. It uses the second
shape for nearly everything: 160 of the 212 asset URLs in a February 2015
capture of settlement.org. `TL_ASSET_RE` required the host, so it skipped all of
them. The document's base could not rescue them either, because `/web/...` is an
absolute path that resolved against this app, returned a 404 in four
milliseconds, and left the frame with no stylesheet and no photographs. The page
still looked like a page, which made it read as a rendering bug rather than a
missing rewrite. The check that once declared prepared frames free of Archive
references had searched for the hostname, and `/web/` does not contain it. The
pattern now matches the shape without the host.

Inside a stylesheet's `url()` references the same blind spot was worse, and
`lib/assetCache.js` had it too. The reference was resolved against the sheet's
own address before it was recognised, so the app asked the Archive for
`http://settlement.org/web/20150212172748im_/...`, a path on the original site
that does not exist. Every webfont and background image in every cached sheet
was fetched, refused, and never tried again. Both files now recognise the
root-relative shape, in markup and in CSS.

Both caches had to be told that the answer changed. An asset is served
`immutable, max-age=1y`, so a stylesheet the browser already held would never be
requested again, and no fix could reach it. The server's disk copy was just as
stubborn and held the old rewrite under the same key. `ASSET_VERSION` (2) is
appended to every asset address the client asks for and to the key a stylesheet
is stored under, so the correction reached the browser and the disk at once.

Measured on the February 19, 2015 frame that had been showing unstyled: 197
Archive-shaped URLs became 0, all four stylesheets applied, 34 of 34 images
loaded, and the base and every asset were on this app's origin. Across the
749-capture record, no frame names the Archive in any `src` or `href`, 745 of
749 declare a stylesheet, and the network log of a 16x run shows asset requests
returning 200. The only 404 left is a font the Archive never captured; the
`.ttf` of the same family loads, so the page falls back.

One capture is one load, however many parts of the film ask for it. The beat,
the pool filling the runway, and a seek can all want the same frame in the same
tick. Each used to find the frame unclaimed, take a slot, and write the same
document again. On a warming film, one capture started eleven times into eleven
slots, all competing for the same parse, layout, and pictures, while the film
crawled at two frames a second. `tlEnsureLoaded` now claims a frame before
anything is awaited, and `tlStartLoad` refuses a second copy at the one point
every loader goes through.

The film does not start until the record ahead of it is warm. The pool holds
under a second of screen time at 16x, so what decides whether a run keeps its
pace is how far ahead the assets are cached, not how many frames are rendered.
Play waits for the pre-roll (`tlPrerollFrames`, six frames of coverage per frame
a second of pace, capped at the 600-frame warming horizon), and the transport
says so: "Warming the record, N of M frames". A frame is warm only when every
asset it names has answered, including the sheet's own `url()` references. An
asset that times out is forgotten and asked for again, because a timeout is not
a fact about the frame and the second request is served from the server's cache.
The render pool stays narrow at two lanes until the pre-roll is satisfied, so
warming gets the capacity. The browser's per-host queue is the real limit, and
running eleven documents at once against a cold record only builds a queue the
next frame has to wait behind.

Measured on the 741-capture, 27-year record of settlement.org, with every
capture already on file server-side and a fresh browser profile: the first open
took 2.97s, and the second open, reading from this machine with no request at
all, took 105 to 167ms. All 740 change counts were available on the first frame,
and no frame was marked unavailable. Before this work it was a hundred seconds
of round trips at best, and a card frozen on "retrieving capture 1 of 741" at
worst.

A 16x playback of that particular record is still not solved. Its captures are
53KB table-layout pages from 2013 to 2026, and one takes about 1.4s to parse,
lay out, and paint when the pool runs twelve at once, against a 163ms beat. The
pool sustains about eight frames a second against the six that 16x needs, so
most frames land on the beat and the tail stalls the runway. Measured: median
gap at the beat, p90 around 0.8 to 1.4s, worst a few seconds, on roughly one
frame in six. That is the renderer, not the network; during those holds there is
no request in flight. Closing it needs a smarter pool, with a lane width the
renderer can sustain and a runway measured in seconds rather than frames, not
another asset fix. At 1x the same record has room to spare.

Re-measured after the asset fix, from a cold cache on that record: the first
16x pass pays the Archive and runs 53 frames in 25s, median gap 374ms, p90
1.45s, worst 2.2s. It is also what fills the cache, since every asset the run
meets is fetched once and kept. The second pass ran 82 frames in 22s, with a
median of 180ms against the 163ms beat, p90 739ms, worst 2.3s. In both passes,
zero frames were on screen with a stylesheet still arriving. The loader waits
for the sheet; it does not show the page and hope.

Measured on the 70-capture, image-heavy 2000 to 2001 slice of apple.com at 16x:
with a cold asset cache, Play opened after 53s of pre-roll, and the film then ran
42 frames with no missed frame and no second-long hold (worst beat 811ms, median
166ms against a 163ms beat; frame loads 1.4s, all concurrent and ahead of the
playhead). With a warm cache, the second run or any later session, Play opened
in 7s and all 41 frames landed between 164ms and 180ms. A cold first run costs
minutes; a warm one costs nothing.

Playback and scrubbing read the record from disk. The walk is done, so the only
remaining slow case is a frame whose assets have not been fetched yet, and the
pre-roll makes that rare. If coverage stops advancing for 30 seconds, because of
one asset the Archive accepts and never answers, Play opens anyway rather than
never opening. Measured on the 740-capture record: any rendered frame is reached
in 14 to 38ms, and the heap holds 7.7MB because every page is stored on disk.
Playback reads one page at a time behind a ring of 16. Pages are written to
IndexedDB in batches of 12 inside one transaction, because one transaction per
document spends more time opening transactions than storing data.

Four details are deliberate:

- **`tlMarkReady` unlocks the transport.** The play button is disabled while the
  record is incomplete, and setting `phase` alone leaves it disabled forever,
  producing a film you can look at but never start.
- **Frames dissolve rather than cut.** The slots are stacked, and a capture is
  written and rendered while transparent, then cross-fades in once complete. A
  cut produces a white flash on every change, which on slow archived pages is
  most of what you would see. The dissolve is sized to the beat (`--tl-fade`),
  because a 420ms fade on a 162ms frame leaves two captures blended for most of
  the run.
- **Scrollbars are hidden inside the frames**, though scrolling still works. A
  tall page grows a scrollbar on one frame and loses it on the next, and that
  flicker across hundreds of frames would be the most visible thing on screen, a
  change the site's owner never made. The compare view keeps its scrollbars
  because there you are reading the page.
- **The rail is not evenly spaced.** Ticks sit at real calendar positions, so
  the width between two ticks is the gap the crawler left. Even spacing would
  claim a continuity the archive cannot support.

At 2.6s a frame, a long record is a long film. The subtitle states the real
runtime for the current speed, and the control goes to 16x for skimming. Space
plays and pauses, and the arrow keys step frame by frame.

### Scrolling inside the stage

A capture is one moment of a site and almost always taller than the stage. The
frames are inert on purpose, with `pointer-events: none`, so a click can never
navigate the film away from the record. That also means a wheel over them is
never theirs. The wheel is read at the viewport (`tlScrollBy`) and applied to
every frame on the stage at once. The position belongs to the record rather than
to a frame: park on the fees table or the footer, press play, and every capture
arrives already scrolled there, changing under your hands.

The position is a wish, not a coordinate. Each capture keeps as much of it as
its own height allows. 5,000px down a page 500px tall is 500, and the next
capture, which may be tall again, is 5,000 again. That is what makes it feel
like one document being scrolled rather than a slot machine of documents. Where
the frame scrolls is asked of the document rather than assumed: `tlScrollers`
returns whichever of `<html>` or `<body>` actually has the overflow. These are
archived pages, some of them twenty-year-old full-height layouts, and this app's
own `overflow-x: hidden` in every frame is enough to turn the body into its own
scroll container and leave the window with nothing to move. That difference was
found the hard way, with the wheel firing and the thumb moving while the
pictures sat still.

The affordance is a hairline track on the right, sized to how much of the page
is out of sight, draggable, and shown only when there is something below. The
one piece of text the stage holds, "Scroll to see the whole page", appears on
the first capture taller than the window and disappears the first time it is
used.

Measured on settlement.org's May 2021 captures: 4,166px of page in a 561px
window. Parked at 2,300px and played at 16x, every one of 52 frames presented in
four seconds arrived at 2,300px, checked at the moment each was shown, with 0
errors. A wheel moved mid-run took the film to 2,300px from wherever it was, and
the next 36 frames all arrived there. Nothing was half-scrolled, nothing reset at
the beat, and no frame showed the top of a page after the first.

### The date card opens a comparison

Watching a capture raises a question the film cannot answer: what changed here,
exactly? The answer lives one view over. The date card on the stage is a button.
Press it and the film closes, the timeline's **from** handle lands on the date
that was on the card, and the comparison opens below.

The pair is that capture against the next one. The card's counts describe the
change that produced the capture, but the date someone is pressing is the date
they are asking about, so that is the from date, exactly as the slider's handles
define "from". The last capture of a record has nothing after it, so the pair
steps back one instead, which is also the only comparison that capture can be
part of. It works mid-playback, pausing the film first, and the index is matched
by timestamp rather than position, so it stays right even if the film and the
record are not quite the same list.

### Exporting the film

The film downloads as a video file that is composed, not captured from the
screen. There is no `getDisplayMedia`, no sharing prompt, no "choose this tab",
and no dependence on which window is in front. Every capture is laid out and
painted into a canvas here, cropped exactly as the stage crops it, with the date
card and the change counts in frame. That canvas is what `MediaRecorder`
receives. The file lands in Downloads as MP4/H.264 where the browser can write
it and WebM where it cannot, named for what it is and for the number of captures
it holds.

Making a still is the expensive part, and it is one pipeline: the canonicalized
capture is parsed; its pictures and fonts are inlined as `data:` URIs; its
sheets are inlined in document order; print sheets are dropped; prefixed names
are unprefixed. Inlining all the `<link>` elements first and all the `<style>`
blocks after was a real cascade bug, because a page that overrides its framework
in a `<style>` written above the `<link>` rendered with the framework winning.
Print sheets are dropped because `print.css` inlined without its `media`
attribute prints the page into the still and replaces the desktop layout with
one nobody sees. Prefixed names are unprefixed because `<gcse:search>` is valid
HTML and malformed XML, and one such element failed a whole 4.9MB still. The
result is a self-contained SVG loaded from a `data:` URL and decoded ahead of
the beat it belongs to.

Three measured facts shape this work:

- A `blob:` URL for an SVG containing a `foreignObject` taints the canvas in
  Chromium, and the encoder then refuses it silently. The recorder runs, the
  frames go in, and the file comes out empty. The same document from a `data:`
  URL draws clean.
- A still that names anything outside itself taints the canvas the same way,
  which is why every reference is inlined and anything that cannot be inlined is
  replaced with a one-pixel transparent GIF. One `mailto:` left behind a picture
  cost a whole export, with no error anywhere.
- A canvas frame is emitted only for a canvas that has been drawn on since the
  last one. An untouched canvas handed over again produces no frame. A hold is
  therefore a repaint of the same still, and the frame that gives the last
  capture its beat is a repaint too, about 25 bytes each.

The beat is a beat in the file, not a description of one. `MediaRecorder` stamps
a canvas by the clock, so holding each capture for half a second means handing
each one over half a second after the last. The writer is therefore a clock
(`tlExportStart`), and the stills are composed ahead of it, three at a time, in
its shadow. A still ready early waits for its beat. A still not ready by its
beat means the picture on the glass holds for one more beat and that capture
takes the next one. Every capture still reaches the file, every beat is exactly
the beat that was asked for, and what grows is the number of beats, reported
below the progress as "3 held an extra beat" rather than discovered in the
finished file. The row's clock starts when the export does, not when the first
frame lands, because the first still of a cold record is a minute of fetching
and a row frozen at 0:00 reads as a row that has given up.

Composing several stills at once follows the same lesson as elsewhere, with a
ceiling. A still is a parse, a decode, and a rasterization on three engines, and
its references were inlined one after another: 130 at about 200ms each is 26
seconds of waiting for work with no ordering in it. Measured on 12 stills of one
record: one at a time about 988ms per still, three to six at a time about 260 to
590ms, with the machine's own state louder than the pool width. The writer uses
three lanes.

Measured end to end on the 741-capture settlement.org record:

- 6 captures at 0.25s: 6 of 6 captures in the file, 7 beats, 0 held, 1326x650
  MP4, 1.538s. The last capture holds to the end of the file rather than for a
  single frame.
- 24 captures at 0.5s, the default: 24 of 24 captures, 28 beats, 3 held, 514KB,
  13.64s against 14.0s of beats, 0 renders failed.
- Stopped mid-run with "Stop & save": a playable 283KB file holding the 19
  captures that had been written, named for 19 and labelled "stopped at 19 of
  741". A file that calls itself a file of 741 captures would lie about itself
  in its own name.

Not solved: composing is main-thread work, so on a record of photograph-heavy
pages at the fastest beat roughly one capture in eight is composed too late and
holds for an extra beat. At 0.5s and slower the writer keeps up.

## How a change is decided

Everything that says "something changed" comes out of one function,
`lib/diffEngine.js`: the rail's ticks, the film's counts, the dashboard's
charts, and the compare view's list. It collects content leaves, the smallest
elements holding content, in document order, diffs the two sequences, and pairs
the runs of removed and added leaves into edits.

Three rules matter, because each is the difference between a change list a
person believes and one they do not.

**A URL is compared by where it points.** Every capture has been through the
Wayback Machine, which rewrites absolute URLs to point back into its own web
path. The same link to the same page therefore arrives as two different strings
in two captures:
`/web/20160710035916/http://etablissement.org/` and
`/web/20261002005041/https://etablissement.org/`. That is a different timestamp,
and http in one and https in the other. Compared as text it reads as "same site,
but it now points to a different page", which is backwards. It is also not an
edge case, because it applies to every absolute link and every rewritten image.
So the prefix comes off, the destination is resolved against each snapshot's own
`<base>`, the only place the captured site's real address is written down, and
`lib/urlTarget.js` compares destinations. `http` and `https` are the same
destination by decision, and so are `www.x` and `x`, because sites add and drop
that prefix and a person following either arrives in the same place. A trailing
slash is still a difference, because those are different addresses, but it is
reported as what it is rather than as a moved page. The panel still shows what
the page actually says, and the "trace this page's own history" link follows the
destination rather than the Archive's rewrite, which is a URL the Archive
invented and has no history of its own.

This was measured on the pair that prompted it, settlement.org from 2016-07-10
to 2026-10-02. The `<a>` that produced "Same site, but it now points to a
different page" from `/web/20160710035916/http://etablissement.org/` to
`/web/20261002005041/https://etablissement.org/` is no longer a change at all.
The seven URL changes the pair does contain are all real: four article links
pointing at different articles, two images whose files were renamed
(`badge-15-years-en.png` to `badge-years-en.png`, `logo-ontario.png` to
`logo-ontario-positive.png`), and one image that moved from settlementtech.org
to settlement.org. The pair also stopped reporting two changes that never
happened: the ASP.NET hidden fields `__VIEWSTATE` and `__EVENTVALIDATION`, which
differ on every render and which no reader can see.

**An element is matched by everything the list cares about.** A leaf's identity
used to be its tag and its text, which meant two elements with the same words
matched and the diff found nothing to say. A link's `title`, a field's
`placeholder`, an `input`'s `value`, and an image's `alt` were never looked at
except when something else changed too. Before the fix, a link whose title
changed from "Old" to "New" produced an empty change list. A URL attribute now
enters that identity as its destination, for the reason above. A hidden form
field is not content at all, because almost every one on an archived page holds
machine state (ASP.NET's `__VIEWSTATE` is a base64 blob that differs on every
render), and reading those as content reported changes nobody made and no person
can see.

**A removed run and an added run are paired by similarity, not position.** The
old code paired the first removed leaf with the first added leaf of the same
tag. That is right often enough to look right and wrong in ways that are hard to
see: three removed links against two added ones reported two edits by position
and lost the deletion entirely. The current code runs a small dynamic program
over a bigram similarity matrix, choosing the highest total score in document
order. A reworded paragraph becomes one edit, and an unrelated paragraph
replacing another becomes a removal plus an addition, which is what happened. A
leaf still on the page but no longer in the same place is caught by a second
pass and reported once as changed, with a note that it moved. The sequence diff
can only match in order, so without that pass a moved element reads as a
deletion plus a brand new element with identical text at both ends.

Because these rules change the counts, `RECORD_STEPS_VERSION` in
`lib/recordBook.js` is bumped whenever they change. Every stored row measured by
the old rules is retired and measured again from the captures already on file,
at no Archive cost.

The rules are pinned down by `test/diffEngine.test.js`, the first tests in this
repo. They are written against the exact shapes the Archive serves and the
pipeline produces, and two of the three rules above were found by writing them,
not by reading the code. Run the suite with `npm test`, which uses `node --test`
and has no dependencies.

### A change the current width cannot show changes the width

The panes are two viewports of a fixed width, and a page's CSS answers that
width. A change can be present in the document and still have no box on screen.
A link in a desktop navbar is `display: none` at a phone width. The same link
may exist again in a drawer that is `display: none` at desktop width. A media
query can drop a whole column, and a carousel parks its other slides off the
track. Each case needs a different answer from the width, not from the DOM.

Picking a change asks, in order, whether each visible pane shows the change as
itself at its current width. A node counts only when it has a real box and
nothing above it is hiding it: `display: none`, `visibility: hidden`, or
`opacity: 0`. The last two still produce a box, which is why checking the node
alone is not enough. If no visible pane shows it, the question becomes whether a
wider pane paints it.

- **The pair paints it.** The pair is the arrangement, and a fold made for an
  earlier row is given back on the same click. A change the reader can already
  see never rearranges the comparison. This is the rule a re-saved image or a
  removed link taught: it belongs to the layout on screen, not to a width.
- **Only the wide layout paints it.** The other snapshot is collapsed, and the
  one holding the change takes the stage. The page's own CSS then answers for
  the viewport it actually has, which turns the phone drawer's copy of a link
  into the header's copy and the parked slide into the one on screen. Nothing is
  injected over the snapshot; the fold is the whole change.
- **Nothing can paint it.** It stays exactly as the Archive recorded it.
  "Activity" in settlement.org's 2015 capture lives in a second copy of the nav
  whose own rule is `display: none`, with no width in it and no hover, focus, or
  state class that brings it back, so no visitor to the site saw it. Opening
  that chain would paint a page that never existed, so the snapshot does not.
  The row still selects, the card explains that it was never shown, and clicking
  it is allowed to do nothing. The distinction is computed, not hard-coded: a
  hidden box above the rule the engine finds, with no media condition on it,
  makes the interaction unreachable (see `neverShows` in `public/app.js`).
- **The reader folded a pane themselves.** That arrangement is theirs and is
  never overridden. The pane they kept answers for the change.

The marked node is always the node that changed. Nothing is marked instead of
the change, no neighbouring menu and no page landmark. What the page's own rules
show, the selection opens and marks. A change no rule of the page ever shows is
not painted at all. An earlier version forced that chain open in place, which
made a hidden ACTIVITY link appear beside SERVICES, a page no visitor ever saw.
The card carries the explanation instead.

A change on another slide of a revived carousel is not hidden in the same sense.
It has a real box, parked outside the band the way the page itself starts.
Marking the band was the ugly answer: one SELECTED frame around a dozen slides,
with the picture the reader asked for still off screen. The band is moved to the
change's own slide first (`revealCarouselSlide`, through
`PdiffSelection.moveCarouselToNode` with `instant`), so the picture itself is
scrolled to, lit, and badged. A `href="#Jun"` month strip follows the slide it
moved to. The move is a receipt on the selection: deselecting puts the band and
the strip back exactly as the crawl recorded them. The slide is whichever slide
contains the node the diff named.

The question is asked at the pair's width even when the stage is folded, because
that is the orientation every selection starts from. The pair is put back for
the length of the measurement, with the grid's transition disabled
(`.pane-instant`), and folded again if the answer needs it, all inside one task
so the browser paints the final layout and never the intermediate one. Measuring
inside a folded stage answers "is it visible at 996px" and then restores a 514px
pair, which can hide the very change the click was for.

A viewport-conditioned hiding gets the page's own wide layout first. The fold
gives the snapshot the width the change was designed for, so a phone drawer
opens as a desktop bar rather than being crammed into a narrow pane. When no
width and no interaction paints it, the snapshot is left as recorded and the
card says why.

Measured on settlement.org's 2016 to 2026 pair: "added News" exists twice in the
later capture, and the two copies need different answers. The copy in the wide
header bar is hidden by a max-width rule at a 666px pane, so the click folds the
older snapshot away, takes the new pane to 1,299px, and lights the `News` anchor
there. The copy inside the SERVICES dropdown is hidden by a `visibility` rule
with no width in it; the page's own hover is performed, the change appears in the
dropdown, and the trigger is marked only if the change itself still cannot be
shown. A click on settlement.org's 2015 "Activity" row paints nothing: the link
sits in a nav copy hidden at every width, the card says no visitor ever saw it,
and no light is placed on the header cell around it. A change the pair already
paints, such as a re-saved image, leaves the pair alone. Clicking a selected row
again puts every opened container back and restores the pair.

### Checking that a click lands on the change

`npm test` guards the logic; it cannot see whether the pane scrolled. That part,
picking a row and landing on the change with it marked on both sides, is checked
in a real browser against real archive data:

```bash
npm start
npx playwright install chromium
npm run check:clicks -- --url settlement.org \
  --from 20150205222010 --to 20261012103023 --rows 30
```

The check walks a sample of the changes list and prints a line per row, judging
each the way a reader would. Something the comparison marked has to be on screen
in the pane: the change, or the container that holds it when the archive never
painted the exact node, such as a broken image or a zero-width rail link. The
marked node itself has to be on screen whenever it has a readable box. A change
no rule of the page ever shows is reported as settled when nothing is marked,
because forcing it open is exactly what the comparison no longer does. Exit code
0 means every row landed, 1 means one did not, and 2 means the check could not
run: no browser, no running app, or an archive that would not answer. `--step`
samples every Nth row instead of a fixed count, which is how a 1,400-change page
is surveyed in a minute.

The check exists because several of the compare view's worst bugs were invisible
in a unit test. A snapshot folded itself away on a nav row. One side of a change
was dropped when the other was visible. A wrapper swallowed the scroll while the
element sat 1,700px off screen. A page that moved its own document under the
light was never corrected because the correction waited for the scroll position
to hold still. All of them fail this check when they come back.

The check is run against nytimes.com, apple.com, settlement.org, borrowell.com,
motherfuckingwebsite.com, and neverssl.com at the width a pane is shown at. The
six differ in the ways that matter: a 2026 React front page that replaces the
server-rendered cards it was handed, a footer taller than the window, a page that
scrolls its own `<body>` while the window stays parked, a card grid, and two
plain documents that must keep working when none of this machinery is needed.
Four rules came out of the sweep:

- **A change the page no longer renders still lands somewhere real.**
  nytimes.com's 2026 front page is React and drops the byline cards whose data
  never arrived. The marked node is in the capture and nowhere in the document
  the reader is looking at, markup, words, and all. That used to be a click that
  did nothing, which reads as broken. The click now falls back to the nearest
  thing the pane does paint around the change (see `scrollTargetFor`), so it
  still moves and still marks the region the change lived in. Nothing is written
  into the snapshot or opened to get there.
- **A target that is off screen is corrected on every pass.** The correction
  used to wait for the pane's scroll position to repeat across two polls, on the
  theory that a smooth scroll was in flight. Every scroll here is instant, so
  there was nothing to wait for, and an apple.com footer whose own script moved
  the document on each poll was corrected zero times in thirty seconds.
- **A rail that scrolls sideways is a scroller like any other.** The scroller
  walk used to look only for boxes taller than their frame, so a card strip
  wider than its viewport was invisible and a change inside one stayed hanging
  off the side of the pane.
- **A box past an edge nothing can scroll toward is out of reach**, even when
  nothing clips it. nytimes.com's 2026 mini nav paints a section link at x -179
  in a pane parked at x 0, with every overflow visible and the page's only
  sideways room to the right. The bar holding the link is what the reader gets
  marked, because that is where the change actually lives on screen.

A change whose mark the page rewrote away is looked for again by what the diff
recorded about it, in this order: its words or its file in the same container;
the container itself, by the ancestor path the engine wrote (the deepest
segment's tag, id, or classes, then its own live ancestors); and its neighbours.
The diff list is in page order, so the nearest change whose mark survived and
which shares the most of the stored path is the same region of the page. Only a
card the page rebuilt with different markup, different classes, and no trace of
the change left, and with no painted container around it, is a click that lands
on nothing. None of the three sites the check runs against produces one.

## The server

### Record endpoints

`GET /api/record?url[&countsOnly=1]` returns the whole record in one response:
every capture of that address already on file, each as `[timestamp, html]`, plus
the change counts compiled for it and the compile's progress. `countsOnly=1` is
the same route without the documents. A film polls it once a second while it
plays, when the only thing still arriving is the numbers behind its rail (110
bytes, one small query).

Asking for the record starts the compile. The counts are measured by
`lib/recordBook.js` in the background, in slices that yield to the event loop.
The diff is synchronous and costs about 66ms a pair, so a 741-capture record is
roughly fifty seconds of parsing. Each count is written to `record_steps` as it
is measured, which makes it permanent and shared. The film, the dashboard,
another tab, and next month's visit all read the same rows, and a compile
interrupted by a restart resumes from the rows already there. The documents are
sent immediately either way; the counts never hold up the pages.

`GET /api/record-step?url&from&to[&withOld=1]` returns the raw archived pages for
two adjacent captures plus the two summaries the views draw from: the counts and
the per-tag breakdown. It deliberately does not return two things that
`/api/diff` does.

- **The annotated documents.** `/api/diff` outlines every changed node in red or
  green, because that is what the compare view needs. A film of a site aging
  wants the site, not the comparison. `lib/diffEngine.js` takes an
  `annotate: false` option that skips that injection and, because reserialising
  two documents out of the DOM is the most expensive thing the function does,
  skips the serialisation too.
- **The change list.** `data.changes` is thousands of objects per pair, of which
  the dashboard read one property from each.

`withOld=1` asks for the older page too, and the walk asks for it exactly once,
on its first step. The page on the left of every later step is the page on the
right of the one before. That flag keeps a full reading to one page per capture
instead of two.

`GET /api/capture?url&ts` returns one capture on its own, for repairing the one
page a failed step left behind, and for a film whose next frame is a capture the
walk could not produce. Both are a person waiting on one page, so this goes on
the interactive lane. Queued as bulk work, it sat behind whatever record was
being walked, which is the other half of why one frame of the film could take a
minute.

`GET /api/asset?m&t&u` serves one asset of one capture, such as a picture, a
stylesheet, or a script, out of `data/assets/`. It fetches from the Archive the
first time and never again. `GET /api/asset-dir/<ts><mod>/<original url>` serves
the same cache by path instead of by query, which is what a document's `<base>`
is rewritten to so its relative URLs resolve here rather than at the Archive.
Both answer with the type the address implies when the Archive answers
`application/octet-stream`, because a web font the browser cannot identify is a
font it will not use. Six Archive reads are in flight at once
(`lib/assetCache.js`), and the route answers with `Cache-Control: immutable`,
because the URL carries both the capture's timestamp and the file's own address.
This is the route the film's frames are rewritten to point at, and it is why a
warm frame takes milliseconds instead of three seconds of cold storage per
picture, per frame, for a file the browser would not keep. The directory is
inside `data/`, outside version control, and safe to delete at any time. The only
cost is fetching those files again.

Responses are gzipped. Archived pages are enormously repetitive markup, so a
full reading moves a small fraction of its uncompressed size.

### Serving an archived page correctly

Every archived page the app hands to a browser goes through one function,
`prepareCapture()` in `lib/prepareCapture.js`, before anything is cached or
rendered. There is deliberately only one of these. The compare view and the
timelapse used to have their own, and they drifted apart in a way that was
invisible until you put them side by side: the compare pane showed the site
styled with its images, the film frame showed the same capture as unstyled text
with every image broken, and nothing about either output looked like an error.

The five steps, in order:

1. **Put back what a script was going to show.** Nothing here runs a capture's
   scripts, and two kinds of content only exist once one has run. Pictures from
   2017 on are written with a 1x1 transparent PNG in `src` and the real address
   in `data-src`, for a loader that copies it across when the image nears the
   viewport; 694 of the 749 cached captures carry one. And `.owl-carousel` is
   `display: none` in owl's stylesheet until the plugin swaps that for
   `.owl-loaded`, leaving twelve slides in the markup that no reader can reach
   in 722 of the 749 captures. Both are repaired here, before the scripts are
   stripped, because what the carousel was showing is written in the plugin's
   own configuration and that is inside a `<script>`. See
   `lib/reviveWidgets.js`, including why a lazily loaded `data-src` has to be
   rewritten into the Archive's own root-relative form (`/web/<ts>im_/<url>`)
   rather than left as the site wrote it.
   The repair is rebuilt on every pass rather than skipped when a container
   already looks revived (`unwrapRevival`). That is the difference between a
   correction reaching every cached row and reaching only the captures fetched
   afterwards. It has bitten three times. The first window was a negative left
   margin on the track, which widens a block rather than moving it; measured, a
   1442px frame showed Aug/Sep/Oct where the plugin showed Dec/Jan/Feb. The
   second hid everything outside the window with
   `:nth-child(n+A):nth-child(-n+B)`, and a breakpoint's rules can only add
   visible slides, so every narrower width inherited the widest width's window;
   measured, at 413px across with `--pal-n` correctly reading 1, three slides
   were still on screen. The third writes the window once, as a `transform` on
   the track, which narrower breakpoints replace rather than add to. All three
   are recorded at `buildCss` in `lib/reviveWidgets.js`, because each looked
   obviously right on the way in.
2. **Strip `<script>` and `<noscript>`.** `if_` mode is supposed to come back
   without a toolbar and often does, but not always. Real responses still arrive
   carrying `bundle-playback.js`, `wombat.js`, and the rest. Wombat rewrites the
   document as it loads, so a page left holding it renders as something other
   than the capture it is meant to be. `<noscript>` goes too: it is the markup a
   site shows when scripting is off, and since nothing here runs scripts,
   keeping it would render the fallback on top of the real page.
3. **Strip any leftover Wayback toolbar elements** as a safety net.
4. **Add `js` to `<html>`.** A common pattern, Modernizr and plenty of
   hand-rolled versions, is a script that adds a `js` class on load and gates
   enhanced chrome behind it in CSS. Without that class the CSS never matches
   and the button renders as bare text, which looks exactly like a missing
   stylesheet. No script is involved.
5. **Inject a `<base>` pointing at the page's own archived timestamp** and stamp
   the document with `PREPARE_VERSION`.

Step 5 is why this parses instead of using a regex. Archived HTML is stored raw,
so `href="/style.css"` resolves against this server, returns a 404, and the
capture renders as unstyled text. A base tag fixes that by pointing relative
stylesheets, fonts, and images at web.archive.org. But pages of this era open
with IE conditional comments:

```html
<!--[if lt IE 9 ]><html class="ie ie8"><head>...<![endif]-->
```

A regex looking for `<head>` finds that one first, plants the base inside a
comment no browser reads, and leaves the real head with nothing. That bug
shipped. JSDOM builds a tree instead, so there is exactly one head and it is the
right one. It also handles `<noscript>`, scripts inside comments, and malformed
markup correctly on the way past.

`lib/diffEngine.js` deliberately has no base-href injection. It is handed
documents `prepareCapture` has already processed, and what comes out is those
documents plus diff markup and nothing else. It used to inject a second base of
its own, which was harmless by luck, because the first one wins and both had the
same href, and was the visible symptom of the two paths no longer being one path.
If a document arrives there without a base, that is `fetchHtml.js`'s bug to fix,
not something to paper over.

The result is cached in `snapshot_html` only after all five steps, and stored in
exactly the form it is served. The row is permanent and every reader gets it, so
preparing on the way out would leave the cache handing the same broken page to
everyone who ever asks.

`check-film-matches-diff` asserts the whole thing over HTTP against a running
server. For the same capture, `/api/record-step` (the film) and `/api/diff` (the
compare view) must produce byte-identical documents once the diff view's own
`data-pdiff-*` markup is removed.

### Why the panes had no CSS

A capture can be prepared perfectly and still arrive looking like a list of
links, because the assets it names can be lost on the way in. Three faults
compounded, and each one alone is enough to strip a page bare.

1. **The addresses were relative, and the document has a `<base>`.** Panes get
   their assets from this app (`/api/asset?...`), but the pane's document also
   carries `<base href="https://web.archive.org/web/<ts>/<page>">`, put there on
   purpose so the page's own links keep pointing into the Archive. A
   root-relative `/api/asset` resolves against that base, so the browser asked
   web.archive.org for `/api/asset`, got its 404 page, and painted nothing.
   Routed addresses are now absolute to the origin the request arrived on
   (`selfOrigin(req)` in `server.js`, threaded through `routedDocument`), which
   no base can re-point. The origin is part of the routed-document cache key,
   since it is part of the bytes.
2. **The Archive answers an empty 200 for a file it holds.** For a URL whose
   exact capture timestamp holds no copy, `/web/<ts>cs_/<url>` and the bare form
   return 200 with `content-length: 0` instead of redirecting. Measured on
   nytimes.com's 2026 front page: 21 of 29 stylesheets. The same files answer in
   full through `/web/<ts>id_/<url>`, which redirects to the nearest capture.
   `lib/assetCache.js` now retries exactly that one shape, and only after an
   empty body. A 404 stays final, so a file the Archive really does not hold
   costs one request, not three.
3. **Inline `style="...url(...)"` was never routed at all.** The obvious
   selector `[style*="url("]` matched nothing in JSDOM, silently. Every inline
   background image kept its Archive address and met the same `<base>` as fault
   1. `ROUTE_VERSION` is 2 because of it: revision 1's documents are on disk and
   have to be rebuilt.

When all three are fixed, the reader sees the site: settlement.org's hero image,
wordmark, and typography in both panes, with 29 of 29 and 30 of 30 images
loaded, and the change outlines drawn on top. Verified with Playwright against a
running server, not by eye.

Two smaller things live in the same path. Stylesheets are warmed while the diff
runs. The diff takes seconds and a sheet is an Archive round trip, so the sheets
have the whole diff to arrive in, and the pane's own `<link>` requests are disk
reads by the time it parses. Pictures are warmed the same way on a narrower rack,
so a front page's sixty images are already on disk when the browser asks.
Stylesheet warming reads the raw markup rather than a parsed document, because a
JSDOM parse to find a dozen `<link>` tags was 300ms of nothing between the fetch
finishing and the first sheet being asked for.

### A pane is shown finished, or not at all

Warming the assets took the Archive off the critical path, but not the
possibility of a hole. A picture whose request was refused, timed out, or
silently dropped leaves nothing on disk, and the browser draws its own answer:
the broken-image glyph with the markup's `alt` text spilled across the design.
On apple.com's 2026 front page that is an iPhone tile's description printed over
the section title, which reads as "the page is broken" rather than "one file is
missing".

Four gates now stand between a response and a painted pane:

- **The server asks again** before a response is given up on
  (`fetchArchiveWithRetry`, `lib/assetCache.js`). A 429, a 5xx, a dropped
  connection, and a timeout are worth a second ask. A 404 or a 410 is final, and
  a slow failure is not asked again at all, because waiting out a 20s timeout
  twice only makes the pane slower. `test/assetRetry.test.js` exercises the
  policy with a stubbed fetch, so nothing in the suite touches the network.
- **`prepareAssets` sweeps twice.** Every reference that failed is asked for
  once more inside the same deadline, and whatever is still missing is returned
  and logged (`[diff] ... assets 47/50+41/41 (3 unavailable)`), so a hole can be
  traced to an address instead of guessed at.
- **The veil answers to a finished page**, not a parsed one (`panePainted`,
  `public/app.js`). It waits for a real document rather than the frame's
  `about:blank` placeholder, whose own load event fired 1.1s before the capture
  was written into it and took the veil off an empty box. It also waits for
  applied stylesheets, resolved fonts, every picture in the document, and the
  CSS background images in the viewport, which is how the older half of the
  archive paints its hero.
- **A picture that still cannot be drawn is silenced**, not printed
  (`settleBrokenPictures`). One more ask of its own, then `data-pdiff-unavailable`
  and `visibility: hidden`, keeping the box the layout gave it and putting
  nothing where the picture belongs.

Measured with every asset answer delayed by 1.2s: the veils lift at 4.86s, right
after the last answer lands, with 0 of 53 pictures in the later pane pending,
broken, or hidden.

### The card belongs to hover

The card belongs to the pointer. Hovering a row shows it, leaving the row takes
it away, and a click never opens one of its own. A click lights the row and
takes the panes to the change, which is the question a click asks.

That was learned by trying the opposite twice. First the card was pinned open by
a click and floated to the left of its row, which is over the right-hand
snapshot, so clicking "removed `<span>` Music" opened a card on top of the menu
it had just lit. Then it was docked inside the picked row, which turned every
click into a board of text appearing in the middle of the list. Neither is what
the list is for. The one thing that survived both attempts is the card's
wording, which was the real complaint underneath.

The card also answers the question it was asked rather than the one its data
model prefers. A removal labels its box **Removed text** (an addition, **Added
text**) instead of the neutral "Before" and "After". A change whose marked node
the page never draws, such as a screen-reader-only `<span>` or a
`visuallyhidden` `<h1>`, names the element the reader can see ("On screen: the
Open Menu menu item the page draws. This text itself is a hidden label..."), or
says plainly that nothing on screen shows it. Without those two lines the reader
was shown a 1x1 box in the header of a page whose only visible change was the
words that box contained, and the card described it as "A run of text".

### Why the record's dates disappeared from the rail

`/api/snapshots` sends a sample of the record, not the record. nytimes.com has
436,339 captures, and sending them all was a 43MB response parsed on every
visit. The old rule kept every capture of the recent 18 months and thinned the
rest by index when the result was still too big. On a record that size the
recent window alone blew past the cap, the even step divided the sample by
index, and nearly every older month fell out. April 2017 was not on the rail of a
record that holds it, and a link to a capture the Archive certainly has said
"that comparison link names captures that are not on this record any more".

`lib/sampleSnapshots.js` states the rule in two resolutions instead: one point a
day for the recent window, one a month before it, first and last captures
always, and `{timestamp, date}` only. The capture's own address is most of the
bytes and no client reads it. Measured: 822 points for nytimes.com, every month
of 2016 and 2017 present, 50KB instead of 594KB, and the answer is memoized so a
second visit is 20ms. The page now says what the record holds, "436,339 captures
on file ... the rail shows 822 of them", rather than passing the sample size off
as the record.

### Why one comparison took thirty-six seconds

The response could not be drawn until every image-byte comparison finished. Each
silently identical picture pair is two Archive requests, and the pairwise pass
had no ceiling. Measured on a recent nytimes.com pair: 12.3s of a 15s diff, and
36.5s end to end on a cold one. The byte passes now share a wall-clock budget
(`INTERACTIVE_BUDGET_MS`, 2.5s; `lib/imageBytes.js`). Cached bytes, the second
look and every visit after it, resolve instantly and are always compared. A pair
that would need the Archive is compared only if it answers in time. If it does
not, it stays unmarked exactly as it was before the pass existed, and the fetch
it started lands in the asset cache for the next diff. Cold comparisons now
measure about 3.5s, warm ones 11ms, and every build logs
`[diff] <url> <from>-><to>: fetch ...ms, measure ...ms, route ...ms` so a slow
one says which phase was slow.

### Why a browser can never be stuck with a stale capture

The pages in IndexedDB outlive the code that wrote them by weeks, and a document
prepared by an older pipeline can render wrong while still looking like a
finished page. An unstyled capture is not an error; it is a plausible-looking
document. So every prepared document carries a `palimpsest-capture` version
stamp, and `arDoc()` in `public/archiveStore.js` checks it on every read.
Anything missing the current stamp is refetched from the server and written
back.

That refetch is a database read on the far side rather than a trip to the
Archive, because the server has its own cache. A stale record therefore repairs
itself at the cost of one small request per capture, and only for captures
actually played.

Bumping `PREPARE_VERSION` in `lib/prepareCapture.js` after changing any of the
steps above is what makes the change reach browsers that already hold the old
documents. Because the server repairs a cached row on the way out of its own
cache, it also reaches rows the server already holds. The two constants are held
equal by `test/prepareVersion.test.js`.

If you are upgrading from a build before this existed, pages cached by an older
version are still stored the broken way, because the old code cached whatever
the Archive returned. Run the repair once. It is a dry run unless you pass
`--apply`, and it touches only `snapshot_html`, a cache of something
reproducible and not user data:

```bash
node scripts/repair-archive-cache.js          # dry run: shows what would change
node scripts/repair-archive-cache.js --apply  # write it
```

### One walk must not block a person

`lib/rateLimiter.js` starts no two requests to the Archive closer together than
1.1s, which is what the Internet Archive asks for and the reason this file
exists. Reading a whole record is therefore slow: 740 captures is over thirteen
minutes of paced requests.

What it does not do is wait for each response before starting the next request.
Spacing starts is the polite rate. Spacing completions made every lane as slow
as the slowest page the Archive happened to be sitting on, and a single response
that took thirty seconds froze the queue behind it, including the one page a
person was watching a film frame for. Responses now overlap, capped at
`MAX_IN_FLIGHT`, and requests still leave at the paced rate.

All on one queue, that is not just slow. It is unusable, because a person
dragging the timeline would sit behind all of it and watch a white pane for
thirteen minutes. So there are two queues. The interactive one holds what
someone is watching a spinner for right now, such as the snapshot list or a
single diff. The bulk one holds the record walk. Interactive work is always
preferred, and preferred again after the wait, so a request that arrives while
the loop is sleeping still goes next.

The guarantee that matters is unchanged either way: one request at a time, never
closer together than `MIN_GAP_MS`, whichever lane it came from. That is also why
exactly one drain loop may ever run. The flag is set synchronously at enqueue,
because a check made inside the loop still reads idle for every call in a burst
of enqueues, and N loops each dequeueing independently is how you get five
requests in flight at once.

## Working on the record and the views

Reaching any of this for real means a slow Wayback round trip, so there is a
harness that renders the dashboard and the film offline against a synthetic
27-year archive:

```bash
node scripts/preview-timelapse.js
```

It writes one self-contained HTML file into `.freebuff/preview/` that inlines
the real `styles.css`, `archiveStore.js`, `dashboard.js`, `timelapse.js`, and
markup from `index.html`, then feeds all of it a plausible capture history
through a mocked `/api/record-step`. Nothing is re-implemented, so what you see
is what the shipped page draws. The mock returns real documents in the visual
idiom of each era: a table-and-Times layout in 1999, fixed-width tables through
the aughties, a CSS reskin by 2010, and a flat modern page by the 2020s. A film
whose frames are all the same white rectangle would tell you nothing about
whether the cross-fade works.

Three buttons appear in the corner. **Open dashboard** and **Open timelapse** can
be pressed in either order. Press one, let it finish, then press the other and
watch it start with nothing left to fetch. **Refetch from scratch** clears the
stored record first, which is the only way to see the wait again in a session
that has already paid it.

Two environment variables exist: `TIMELAPSE_PREVIEW_SNAPSHOTS` sets the record
length (the real thing is 737), and `TIMELAPSE_PREVIEW_FAST=1` removes the
per-request pause for a quick smoke test.

`scripts/preview-dashboard.js` is the older, dashboard-only harness.

## Deploying to Vercel

The app is a plain Express server plus a static frontend, so it runs on Vercel
as one serverless function with the frontend served from the CDN.

1. **Untrack `node_modules`.** It is in `.gitignore` but was committed before
   that, so it is still tracked (2,615 files). Vercel clones the repo and would
   install dependencies twice, slowing every deploy:

   ```bash
   git rm -r --cached node_modules
   git commit -m "Stop tracking node_modules"
   ```

2. **Push to GitHub**, then in Vercel choose **Add New > Project** and import the
   repo. Vercel detects Node and uses the build settings from `npm start` as they
   are. The Framework Preset should stay "Other".

3. **Set the environment variables** under Project > Settings > Environment
   Variables, for both Production and Preview:

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `TURSO_DATABASE_URL` | yes | e.g. `libsql://palimpsest-xyz.turso.io` |
   | `TURSO_AUTH_TOKEN` | yes | from `turso db tokens create` |
   | `GEMINI_API_KEY` | no | enables grounded, cited insights |
   | `NVIDIA_API_KEY` | no | fallback provider, no web access |

   Do not set `PORT`. Vercel assigns it.

4. **Deploy.** `vercel.json` publishes `public/` and rewrites every `/api/*`
   path to `api/index.js`, which is the same Express app exported from
   `server.js`. So `/api/diff`, `/api/notes/:id`, and the rest arrive at the app
   unchanged.

5. **Verify** on the production URL. Load the page, run one comparison, and
   check that a note you add is still there after a reload. That round trip is
   the quickest way to confirm both the cookie and Turso are working.

6. **Point your domain at Vercel** under Settings > Domains, and only then tear
   down the Render service.

### The function time limit

`vercel.json` caps the function at 60s, which is the most any plan allows.
Fetching from the Archive is slow and retries three times with backoff, so the
worst case is longer. A cold `/api/snapshots` measured 56s on a busy Archive,
and `/api/diff`, which reads two pages in parallel, can reach about 81s. On a
cold cache those two routes can be cut off mid-request.

The cache in Turso hides this after first use, but the first request for any new
site pays it. If you hit timeouts, give the function more room and shorten the
per-fetch timeout so the retry ladder fits inside it. For example, use
`maxDuration: 300` (Pro and above) with `timeoutMs` dropped to 15000 in
`lib/cdx.js` and `lib/httpGet.js`, which caps the ladder at 51s.

Reading a site's whole history is many small requests rather than one long one.
The client drives it, one adjacent pair of captures at a time, so no single call
has to survive the whole walk. Each step still fetches up to two pages, so on a
cold cache a step can hit the same ceiling as `/api/diff`. But a step that dies
costs one pair, and the next visit retries it from the manifest rather than
starting the record over.

The polite one-request-per-second spacing in `lib/rateLimiter.js` is
per-instance. On a single long-running server that was a real global limit.
Across many serverless instances it only slows each instance down on its own. If
the Archive starts returning 429s, move that gate into Turso so it is shared.

## A note on being a good citizen of the Wayback Machine

The app already spaces its requests to web.archive.org at roughly one per second
and caches everything it fetches, so repeated use of the same site and dates does
not hit the Archive again. If you plan to point it at many different sites in a
short time, keep that rate limit in mind. It is a free public resource run by a
nonprofit.

## Project layout

```text
server.js              Express app, all API routes
api/index.js           Vercel entry point: hands server.js's app to the function
db.js                  Turso client and schema setup
lib/cdx.js             Snapshot list fetching and caching
lib/prepareCapture.js  Raw archived HTML to a document a browser can render
lib/fetchHtml.js       Fetching and caching of prepared captures
lib/diffEngine.js      The block-level DOM diff
lib/urlTarget.js       Where a written URL really points
test/                  node:test suites for the diff and URL logic
lib/insight.js         Grounded AI explanation of a change
lib/notes.js           The per-user notes journal
lib/rateLimiter.js     Keeps requests to the Archive spaced out
public/                The frontend: index.html, styles.css, app.js,
                       archiveStore.js, dashboard.js, timelapse.js, and the
                       two sub-pages, claims.html + claims.js (claim records)
                       and settlement.html + settlement.js (settlement research)
scripts/               Dev-only helpers: favicon generation, preview
                       harnesses, and the archive-cache repair
```

The dashboard draws every chart itself as inline SVG rather than pulling in a
charting library, and measures each plot to its own container so axis type is
never resampled. See `renderActivityChart` in `public/dashboard.js` and the
chart primitives in the "Site dashboard" section of `public/styles.css`.
