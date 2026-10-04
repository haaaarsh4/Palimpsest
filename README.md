# Palimpsest

Trace how any website has changed over time. Enter an address, drag two
handles across a timeline of every recorded snapshot, and see exactly what
was added, removed, or edited between those two moments, side by side, with
each change outlined right on the page. Then open the dashboard to see the
whole history charted, or play it back as a timelapse and watch the site age.
Take notes as you go, and optionally ask an AI to research what likely caused
a change using real web context.

## What's actually happening under the hood

- **The timeline** comes from the Wayback Machine's CDX API, which is an
  index of every snapshot the Internet Archive holds for a URL. We ask it to
  collapse consecutive snapshots with identical content, so the slider only
  shows moments where the page actually changed.
- **The diff** is not a raw text diff. The server parses both snapshots into
  DOM trees, breaks each one into its content blocks (paragraphs, headings,
  links, images, list items), and runs a sequence diff over those blocks,
  matching them the same way `git diff` matches lines. That's what lets it
  tell "this paragraph was reworded" apart from "this paragraph was deleted
  and an unrelated one was added nearby."
- **The two snapshots render in sandboxed iframes** so the archived page's
  own decades-old CSS and JavaScript can't leak into the app around them.
  `<script>` tags are stripped before rendering, and the iframe sandbox
  doesn't allow scripts to run even if one slipped through.
- **Notes and cached snapshots live in Turso** (hosted libSQL), reached
  through `@libsql/client`. The tables are created automatically on the
  first request, so an empty database is all you need.
- **The Insight panel** tries Gemini first, with the Google Search tool
  turned on, so instead of guessing why a page changed from memory it
  actually looks up news and context from around the relevant dates. If no
  Gemini key is present it falls back to NVIDIA, which reasons from the diff
  alone and says so.

## Running it

You'll need Node.js 18 or newer.

```bash
npm install
cp .env.example .env      # then open .env and fill in TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
npm start
```

Open `http://localhost:3000`.

The two Turso variables are the only hard requirement. Get the URL with
`turso db show <name> --url` and mint a token with
`turso db tokens create <name>`. The AI keys are optional: with none of
them set, everything works except the Insight tab, which will tell you it
isn't configured rather than failing silently.

### One reading of the record, shared

Both the dashboard and the timelapse answer questions about the same thing:
what a site looked like at each of its captures, and what changed to get from
one to the next. They used to fetch that separately. The dashboard sampled
twenty-eight transitions and kept only the numbers; the timelapse then walked
the whole record again, fetching the pages the first walk had already pulled
down and thrown away.

Now there is one reading, and `public/archiveStore.js` owns it. **Whichever
view you open first pays for it; the other one finds it already stored.** Read
the dashboard, wait through it once, and the timelapse opens with nothing left
to fetch — measured on a 740-capture record: **739 requests to read the
record, then 0 to open the film, ready in 242ms.** The other way round is the
same. Opening the second view while the first is still running attaches to that
same reading rather than starting a second one, so both progress bars agree.

Concretely the store keeps, in IndexedDB under one namespaced key per capture:

- every archived page, on disk rather than on the heap;
- a manifest row per site recording the record's signature (count and first
  and last timestamps) and, per capture, what changed into it, the per-tag
  breakdown, and whether its page is on disk.

The signature is what makes a stale record impossible to play back: re-trace a
site and get a different list, and everything under the old signature is
dropped rather than mixed into the new one.

**An interrupted reading resumes.** The manifest is written from a walk that
picks up every step it already has, so closing the tab mid-read costs only the
part that hadn't happened. A step that failed is retried on the next visit
rather than remembered as permanently missing, and a page that a failed step
still owed is fetched on its own at the end (normally there are none).

If IndexedDB is unavailable — private window, blocked origin, full disk —
nothing here throws. The pages fall back to a Map in memory, the reading still
completes, both views still work; it just costs heap and doesn't survive a
reload.

### The timelapse

The timelapse answers "show me". It plays the whole record back in order,
**every capture on file, one frame each**, each a real archived page rendered
in a browser-window stage and dissolving into the next.

There is no sampling and no cap, because there is nothing to sample. The
snapshot list is already `collapse=digest` — `lib/cdx.js` asks the CDX server to
drop consecutive captures with identical content — so every entry is a moment
the page genuinely changed.

**It plays a record that is already whole.** Phase one waits on the reading;
when it is already stored, that wait is a few milliseconds, and the film
starts immediately. When it isn't, the progress card appears and says what is
happening, how far along, which year it has reached and roughly how long is
left, because a wait that long is only acceptable if it is legible.

That ordering is forced by the Archive rather than chosen for drama.
`lib/rateLimiter.js` starts no two requests to web.archive.org closer together
than 1.1s across the whole process, so a 740-capture record is over thirteen
minutes of fetching the first time any machine reads it. Doing that in the
middle of the film would hold a beat for as long as a page took to arrive.
Paying it once, up front, is the better trade. And because `lib/fetchHtml.js`
caches every document permanently in Turso under `${url}::${timestamp}`, that
thirteen minutes is a cost paid once per site per server, not once per visitor.
**You wait once.**

**Playback never waits on a page, and every frame holds for the same beat.** The
beat is measured between frames rather than from the moment the last one
finished, so a slow page cannot stretch the frame after it. A capture that is
loaded is shown; a capture that is not is dropped and the frame on screen holds
for that beat while the frame after it is shown on the next. This is what stops
one frame taking a minute while its neighbours take a second, which is exactly
what happened when each beat awaited the load: a page that had to be fetched
could hold the whole film, and the film waited behind somebody else's record
walk to get it. Frames are presented as soon as the document is parsed and its
stylesheets have landed (`TL_READY_MS`), not when the last image arrives; a late
image fills in on screen, as it would in a tab. A recording is the exception:
the file is watched later, frame by frame, so while `TL.export.state` is
recording a frame is allowed to wait for its whole self.

Playback and scrubbing are free after that: they read from disk. Measured on the
740-capture record — **0 network calls during playback and while scrubbing**,
any frame reached in 14–38ms, **7.7MB of heap with every page stored on disk.**
Playback reads one page at a time behind a ring of 16; pages are written to
IndexedDB in batches of 12 inside one transaction, because one transaction per
document would spend more time opening transactions than storing data.

Four things are deliberate and worth not undoing by accident:

- **`tlMarkReady` unlocks the transport, it does not merely flip a flag.** The
  play button is disabled while the record is incomplete; setting `phase`
  alone left it disabled forever, giving a film you could look at but never
  start.
- **Frames dissolve, they don't cut.** Two iframes are stacked; the incoming
  one is written and loaded while still transparent and only cross-fades in on
  its load event. Cutting produces a white flash on every change, which on
  gzipped, slow archived pages is most of what you'd actually see.
- **Scrollbars are hidden inside the frames** (scrolling still works). A tall
  archived page grows a scrollbar on one frame and loses it on the next, and
  through hundreds of frames that flicker would be the most visible thing on
  screen — a change the site's owner never made. The compare view keeps its
  scrollbars, because there you are reading the page.
- **The rail is not evenly spaced.** Ticks sit at real calendar positions, so
  the width between two of them is the gap the crawler left. Evening it out
  would claim a continuity the archive can't back up.

At 2.6s a frame a long record is a long film — the subtitle states the real
runtime for the current speed, and the control goes to 16× for skimming.

Space plays and pauses, the arrow keys step frame by frame.

### The record endpoints

`GET /api/record-step?url&from&to[&withOld=1]` returns the raw archived pages
for two adjacent captures plus the two summaries the views draw from: the
counts, and the per-tag breakdown. Two things it deliberately does **not**
return, both of which `/api/diff` does:

- **The annotated documents.** `/api/diff` outlines every changed node in red
  or green, because that is what the compare view needs. A film of a site aging
  wants the site, not the comparison. `lib/diffEngine.js` takes an
  `annotate: false` option that skips that injection — and, because
  re-serialising two documents out of the DOM is the most expensive thing the
  function does, skips the serialisation too.
- **The change list.** `data.changes` is thousands of objects per pair, of
  which the dashboard read one property from each.

`withOld=1` asks for the older page too, and the walk asks for it exactly
once, on its first step: the page on the left of every later step is the page
on the right of the one before. That single flag is what keeps a full reading
to one page per capture instead of two.

`GET /api/capture?url&ts` returns one capture on its own, for repairing the one
page a failed step left behind, and by a film whose next frame is a capture the
walk could not produce. Both are a person waiting on one page, so it goes on the
interactive lane: queued as bulk work it sat behind whatever record was being
walked, which is the other half of why one frame of the film could take a
minute.

Responses are gzipped. Archived pages are enormously repetitive markup, so a
full reading moves a small fraction of its uncompressed size.

### Serving an archived page correctly

Every archived page this app hands to a browser goes through one function,
`prepareCapture()` in `lib/prepareCapture.js`, before anything is cached or
rendered. **There is deliberately only one of these.** The compare view and the
timelapse used to have their own, and they drifted apart in a way that was
invisible until you put them side by side: the compare pane showed the site
styled with its images, the film frame showed the same capture as unstyled text
with every image broken, and nothing about either output looked like an error.

The four steps, in order:

1. **Strip `<script>` and `<noscript>`.** `if_` mode is supposed to come back
   without a toolbar and often does, but not always — real responses still
   arrive carrying `bundle-playback.js`, `wombat.js` and the rest. Wombat in
   particular rewrites the document as it loads, so a page left holding it
   renders as something other than the capture it is meant to be. `<noscript>`
   goes with it: it is the markup a site shows when scripting is off, and
   since nothing here runs scripts, keeping it would render the fallback on
   top of the real page.
2. **Strip any leftover Wayback toolbar elements** as a safety net.
3. **Add `js` to `<html>`.** A very common pattern — Modernizr, and plenty of
   hand-rolled versions — is a script that adds a `js` class on load and gates
   enhanced chrome behind it in CSS. Without that class the CSS never matches
   and the button renders as bare text, which looks exactly like a missing
   stylesheet. No script is involved.
4. **Inject a `<base>` pointing at the page's own archived timestamp**, and
   stamp the document with `PREPARE_VERSION`.

**Step 4 is why this parses instead of using a regex.** Archived HTML is stored
raw, so `href="/style.css"` resolves against *this* server, 404s, and the
capture renders as unstyled text — a base tag fixes that, by pointing relative
stylesheets, fonts and images at web.archive.org. But pages of this era open
with IE conditional comments:

```html
<!--[if lt IE 9 ]><html class="ie ie8"><head>...<![endif]-->
```

A regex looking for `<head>` finds **that** one first, plants the base inside a
comment no browser ever reads, and leaves the real head with nothing. That bug
shipped. JSDOM builds a tree instead, so there is exactly one head and it is
the right one — and it handles `<noscript>`, scripts inside comments, and
malformed markup correctly on the way past.

`lib/diffEngine.js` deliberately has **no** base-href injection. It is handed
documents `prepareCapture` has already done, and what comes out is those
documents plus diff markup and nothing else. It used to inject a second base
of its own, which was harmless by luck — the first one wins, and both had the
same href — and was the visible symptom of the two paths no longer being one
path. If a document arrives there without a base, that is `fetchHtml.js`'s bug
to fix, not something to paper over.

The result is cached in `snapshot_html` **only after all four steps**, and
stored in exactly the form it is served. The row is permanent and every reader
gets it, so preparing on the way *out* would leave the cache handing the same
broken page to everyone who ever asks.

`check-film-matches-diff` asserts the whole thing over HTTP against a running
server: for the same capture, `/api/record-step` (the film) and `/api/diff`
(the compare view) must produce byte-identical documents once the diff view's
own `data-pdiff-*` markup is removed.

### Why a browser can never be stuck with a stale capture

The pages in IndexedDB outlive the code that wrote them by weeks, and a
document prepared by an older pipeline can render wrong **while still looking
like a finished page** — an unstyled capture is not an error, it is a
plausible-looking document. So every prepared document carries a
`palimpsest-capture` version stamp, and `arDoc()` in `public/archiveStore.js`
checks it on every read. Anything missing the current stamp is refetched from
the server and written back.

That refetch is a database read on the far side rather than a trip to the
Archive, because the server has its own cache — so a stale record repairs
itself at the cost of one small request per capture, and only for captures
actually played.

> Bumping `PREPARE_VERSION` in `lib/prepareCapture.js` after changing any of
> the four steps above is what makes the change reach browsers that already
> hold the old documents.

> **Upgrading from a build before this existed?** Pages cached by an older
> version are still stored the broken way, because the old code cached whatever
> the Archive returned. Run the repair once — it is a dry run unless you pass
> `--apply`, and it touches only `snapshot_html` (a cache of something
> reproducible, not user data):
>
> ```bash
> node scripts/repair-archive-cache.js            # dry run: shows what would change
> node scripts/repair-archive-cache.js --apply    # write it
> ```

### One walk must not block a person

`lib/rateLimiter.js` starts no two requests to the Archive closer together than
1.1s, which is what the Internet Archive asks for and the reason this file
exists. Reading a whole record is therefore long: 740 captures is over thirteen
minutes of paced requests.

What it does **not** do is wait for each response before starting the next
request. Spacing starts is the polite rate; spacing completions made every lane
as slow as the slowest page the Archive happened to be sitting on, and a single
response that took thirty seconds froze the queue behind it — including the one
page a person was watching a film frame for. Responses now overlap, capped at
`MAX_IN_FLIGHT`, and requests still leave at the paced rate.

All on one queue, that is not just slow — it is unusable, because a person
dragging the timeline would sit behind all of it and watch a white pane for
thirteen minutes. So there are two queues. The interactive one holds what
someone is watching a spinner for right now (the snapshot list, a single diff);
the bulk one holds the record walk. Interactive work is always preferred, and
preferred *again* after the wait, so a request that arrives while the loop is
sleeping still goes next.

The guarantee that matters is unchanged either way: one request at a time, never
closer together than `MIN_GAP_MS`, whichever lane it came from. That is also
why exactly one drain loop may ever run — the flag is set synchronously at
enqueue, because a check made inside the loop still reads "idle" for every call
in a burst of enqueues, and `N` loops each dequeueing independently is how you
get five requests in flight at once.

### Working on the record and the views that read it

Reaching any of this for real means a slow Wayback round trip, so there is a
harness that renders the dashboard and the film offline against a synthetic
27-year archive:

```bash
node scripts/preview-timelapse.js
```

It writes one self-contained HTML file into `.freebuff/preview/` that inlines
the real `styles.css`, `archiveStore.js`, `dashboard.js`, `timelapse.js` and
markup from `index.html`, then feeds all of it a plausible capture history
through a mocked `/api/record-step`. Nothing is re-implemented, so what you see
is what the shipped page draws. The mock returns real documents in the visual
idiom of each era — a table-and-Times layout in 1999, fixed-width tables
through the aughties, a CSS reskin by 2010, a flat modern page by the 2020s —
because a film whose frames are all the same white rectangle tells you nothing
about whether the cross-fade works.

Three buttons appear in the corner. **Open dashboard** and **Open timelapse**
in whichever order you like — press one, let it finish, press the other and
watch it start with nothing left to fetch. **Refetch from scratch** clears the
stored record first, which is the only way to see the wait again in a session
that has already paid it.

Two environment variables: `TIMELAPSE_PREVIEW_SNAPSHOTS` sets the record length
(the real thing is 737), and `TIMELAPSE_PREVIEW_FAST=1` removes the per-request
pause for a quick smoke test.

`scripts/preview-dashboard.js` is the older, dashboard-only harness.

## Deploying to Vercel

The app is a plain Express server plus a static frontend, so it runs on
Vercel as one serverless function with the frontend served from the CDN.

1. **Untrack `node_modules`.** It is in `.gitignore` but was committed
   before that, so it's still tracked (2,615 files). Vercel clones the
   repo, and it would install dependencies twice and slow every deploy:

   ```bash
   git rm -r --cached node_modules
   git commit -m "Stop tracking node_modules"
   ```

2. **Push to GitHub**, then in Vercel choose **Add New → Project** and
   import the repo. Vercel detects Node and uses `npm start`'s build
   settings as-is; the Framework Preset should stay "Other".

3. **Set the environment variables** (Project → Settings → Environment
   Variables), for both Production and Preview:

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `TURSO_DATABASE_URL` | yes | e.g. `libsql://palimpsest-xyz.turso.io` |
   | `TURSO_AUTH_TOKEN` | yes | from `turso db tokens create` |
   | `GEMINI_API_KEY` | no | enables grounded, cited insights |
   | `NVIDIA_API_KEY` | no | fallback provider, no web access |

   Do **not** set `PORT`. Vercel assigns it.

4. **Deploy.** `vercel.json` publishes `public/` and rewrites every
   `/api/*` path to `api/index.js`, which is the same Express app exported
   from `server.js`. So `/api/diff`, `/api/notes/:id` and the rest arrive
   at the app unchanged.

5. **Verify** on the production URL: load the page, run one comparison, and
   check that a note you add is still there after a reload (that round trip
   is the quickest way to confirm both the cookie and Turso are working).

6. **Point your domain at Vercel** (Settings → Domains) and only then tear
   down the Render service.

### One thing to watch: the function time limit

`vercel.json` caps the function at 60s, which is the most any plan allows.
Fetching from the Archive is slow and retries three times with backoff, so
the worst case is longer than that: a cold `/api/snapshots` measured 56s on
a busy Archive, and `/api/diff` (two pages, in parallel) can reach ~81s.
On a cold cache those two routes can be cut off mid-request.

The cache in Turso hides this after first use, but the first request for any
new site pays it. If you hit timeouts, the fix is to give the function more
room and shorten the per-fetch timeout so the retry ladder fits inside it —
for example `maxDuration: 300` (Pro and above) with `timeoutMs` dropped to
15000 in `lib/cdx.js` and `lib/httpGet.js`, which caps the ladder at 51s.

Reading a site's whole history is many small requests rather than one long
one: the client drives it, one adjacent pair of captures at a time, so no
single call has to survive the whole walk. Each step still fetches up to two
pages, so on a cold cache a step can hit the same ceiling as `/api/diff` — but
a step that dies costs one pair, and the next visit retries it from the
manifest rather than starting the record over.

Note also that the polite one-request-per-second spacing in
`lib/rateLimiter.js` is per-instance. On a single long-running server that
was a real global limit; across many serverless instances it only slows each
instance down on its own. If the Archive starts returning 429s, move that
gate into Turso so it's shared.

## A note on being a good citizen of the Wayback Machine

The app already spaces out its requests to `web.archive.org` (roughly one per
second) and caches everything it fetches, so repeated use of the same site
and dates won't hit the Archive again. If you're going to point this at a lot
of different sites in a short time, keep that rate limit in mind. It's a free
public resource run by a nonprofit.

## Project layout

```
server.js          Express app, all API routes
api/index.js       Vercel's entry point: hands server.js's app to the function
db.js               Turso client + schema setup
lib/cdx.js          Snapshot list fetching + caching
lib/prepareCapture.js  Raw archived HTML -> a document a browser can render
lib/fetchHtml.js    Fetching + caching of prepared captures
lib/diffEngine.js   The block-level DOM diff
lib/insight.js      Grounded AI explanation of a change
lib/notes.js        The per-user notes journal
lib/rateLimiter.js  Keeps requests to the Archive spaced out
public/             The frontend: index.html, styles.css, app.js,
                    archiveStore.js, dashboard.js, timelapse.js
scripts/            Dev-only helpers (favicon generation, the preview
                    harnesses, the archive-cache repair)
```

The dashboard draws every chart itself as inline SVG rather than pulling in
a charting library, and measures each plot to its own container so axis
type is never resampled: see `renderActivityChart` in
`public/dashboard.js` and the chart primitives in the `Site dashboard`
section of `public/styles.css`.
