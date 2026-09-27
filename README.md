# Palimpsest

Trace how any website has changed over time. Enter an address, drag two
handles across a timeline of every recorded snapshot, and see exactly what
was added, removed, or edited between those two moments, side by side, with
each change outlined right on the page. Take notes as you go, and optionally
ask an AI to research what likely caused a change using real web context.

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
lib/fetchHtml.js    Raw archived HTML fetching + caching
lib/diffEngine.js   The block-level DOM diff
lib/insight.js      Grounded AI explanation of a change
lib/notes.js        The per-user notes journal
lib/rateLimiter.js  Keeps requests to the Archive spaced out
public/             The frontend: index.html, styles.css, app.js
```
