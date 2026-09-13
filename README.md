# Palimpsest

Trace how any website has changed over time. Enter an address, drag two
handles across a timeline of every recorded snapshot, and see exactly what
was added, removed, or edited between those two moments, side by side, with
each change outlined right on the page. Take notes as you go, and optionally
ask Claude to research what likely caused a change using real web context.

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
- **Notes and cached snapshots live in a local SQLite file** (`data/palimpsest.db`),
  which is created automatically the first time you run the app.
- **The Insight panel** calls the Anthropic API with the web search tool
  turned on, so instead of guessing why a page changed from memory, Claude
  actually looks up news and context from around the relevant dates first.

## Running it

You'll need Node.js 18 or newer.

```bash
npm install
cp .env.example .env      # then open .env and add your Anthropic API key, optional
npm start
```

Open `http://localhost:3000`.

If you skip the API key, everything works except the Insight tab, which will
tell you it isn't configured rather than failing silently.

## A note on being a good citizen of the Wayback Machine

The app already spaces out its requests to `web.archive.org` (roughly one per
second) and caches everything it fetches, so repeated use of the same site
and dates won't hit the Archive again. If you're going to point this at a lot
of different sites in a short time, keep that rate limit in mind. It's a free
public resource run by a nonprofit.

## Project layout

```
server.js          Express app, all API routes
db.js               SQLite setup
lib/cdx.js          Snapshot list fetching + caching
lib/fetchHtml.js    Raw archived HTML fetching + caching
lib/diffEngine.js   The block-level DOM diff
lib/insight.js      Grounded AI explanation of a change
lib/rateLimiter.js  Keeps requests to the Archive spaced out
public/             The frontend: index.html, styles.css, app.js
```
