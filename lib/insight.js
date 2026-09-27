// lib/insight.js
//
// The "why did this change happen" panel. The key design choice is
// grounding: rather than asking a model to explain a diff from memory
// alone (which invites confident guessing), it's given a live web search
// tool so it can look up news, announcements, or coverage from around the
// dates in question and build the explanation on top of real sources.
//
// Two free providers, tried in order, so the feature keeps working
// instead of dying the moment one runs dry:
//
//   1. Google Gemini - the only major provider with a permanent free tier
//      (no card, no expiry), and it has native Google Search grounding, so
//      insights come back with real cited sources. Its limit is a daily
//      request cap that resets every 24h.
//
//   2. NVIDIA NIM - free, no daily cap at all (just ~40 requests/minute),
//      and OpenAI-compatible. The tradeoff is that these hosted models
//      have no web search, so this path produces an explanation reasoned
//      purely from the diff itself, with no sources. It's clearly marked
//      as ungrounded in the response so nobody mistakes an inference for
//      something a source actually confirmed.
//
// Every insight is cached per (url, from, to), so revisiting a comparison
// never spends quota twice. Only genuinely new lookups cost anything.
//
// Keys (both free, neither needs a card):
//   GEMINI_API_KEY  -> https://aistudio.google.com/apikey
//   NVIDIA_API_KEY  -> https://build.nvidia.com/settings/api-keys

const crypto = require('crypto');
const { db } = require('../db');

// A 429 on the very first request (not after heavy use) usually means
// the model itself has little or no free-tier allocation yet, which
// happens with newly released models before free access catches up to
// paid access. gemini-2.0-flash has had a stable, generous free tier for
// a long time - safer default than chasing the newest name.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// meta/llama-3.3-70b-instruct was retired from the free tier (410 Gone
// is HTTP for "this used to exist, it's permanently gone now" - not a
// naming typo). deepseek-v4-flash-0731 is confirmed current directly from
// NVIDIA's own generated code sample on its model page.
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash-0731';

function summarizeChangesForPrompt(changes, limit = 40) {
  return changes
    .slice(0, limit)
    .map((c) => {
      if (c.type === 'added') return `+ added <${c.tag}>: "${c.after}"`;
      if (c.type === 'removed') return `- removed <${c.tag}>: "${c.before}"`;
      return `~ changed <${c.tag}>: "${c.before}" -> "${c.after}"`;
    })
    .join('\n');
}

function buildPrompt({ url, dateFrom, dateTo, counts, changes }, { grounded }) {
  const researchStep = grounded
    ? 'Search the web for real context from around this date range: news coverage, company announcements, controversies, product launches, leadership changes, or anything else that plausibly explains this change. Then write'
    : 'You do not have web access for this request, so reason only from the diff itself and your own background knowledge. Be explicit that you could not verify anything against a live source, and do not invent specific news events, dates, or announcements you cannot confirm. Write';

  return `You're helping a researcher understand why a website changed. The site is "${url}". Two archived snapshots are being compared: one from ${dateFrom}, and one from ${dateTo}. The page had ${counts.added} additions, ${counts.removed} removals, and ${counts.changed} edited blocks between these two dates.

Here is a structural summary of what changed (not the full page, just the diffed content blocks):

${summarizeChangesForPrompt(changes)}

${researchStep} a short, clear explanation (150-250 words, plain prose, no bullet lists, no em dashes) covering:
1. What the change actually looks like in practical terms.
2. What likely caused it. Say plainly when something is well-supported by a source versus when it's your own reasonable inference from the diff alone.
3. Why this change might matter to someone researching this site's history.

Write for a curious, intelligent reader who is not a web developer.`;
}

// ---- Provider 1: Gemini, grounded with real Google Search sources -------
async function tryGemini(params) {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[insight] Skipping Gemini: GEMINI_API_KEY is not set.');
    return null;
  }
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildPrompt(params, { grounded: true }),
    config: { tools: [{ googleSearch: {} }] },
  });

  const sources = [];
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  for (const chunk of chunks) {
    if (chunk.web && chunk.web.uri && chunk.web.title) {
      sources.push({ url: chunk.web.uri, title: chunk.web.title });
    }
  }

  return { summary: (response.text || '').trim(), sources, grounded: true };
}

// ---- Provider 2: NVIDIA NIM, no web access, inference only --------------
async function tryNvidia(params) {
  if (!process.env.NVIDIA_API_KEY) {
    console.log('[insight] Skipping NVIDIA: NVIDIA_API_KEY is not set.');
    return null;
  }
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: NVIDIA_MODEL,
      messages: [{ role: 'user', content: buildPrompt(params, { grounded: false }) }],
      temperature: 0.6,
      max_tokens: 800,
    });
  } catch (err) {
    // A bare "410 (no body)" from the SDK's default error string doesn't
    // say whether it's the model name, the route, or something else
    // that's gone. Logging the exact model attempted plus whatever
    // NVIDIA's response actually contained (status, headers, body) gives
    // something to actually act on instead of a dead end.
    console.error('NVIDIA request failed for model', JSON.stringify(NVIDIA_MODEL), '-',
      'status:', err.status, 'body:', JSON.stringify(err.error || err.response?.data || null));
    throw err;
  }

  return {
    summary: (completion.choices?.[0]?.message?.content || '').trim(),
    sources: [],
    grounded: false,
  };
}

async function generateInsight(params) {
  const { url, tsFrom, tsTo } = params;

  const cachedResult = await db.execute({
    sql: 'SELECT summary, sources FROM insights WHERE url = ? AND ts_from = ? AND ts_to = ?',
    args: [url, tsFrom, tsTo],
  });
  const cached = cachedResult.rows[0];
  if (cached) {
    return { summary: cached.summary, sources: JSON.parse(cached.sources), fromCache: true };
  }

  // Loud, unconditional, printed on every single attempt - not just when
  // something goes wrong - so there is never a silent run again. Keys are
  // masked to a short prefix so it's still safe to leave in server logs.
  const mask = (v) => (v ? `${v.slice(0, 6)}... (${v.length} chars)` : 'NOT SET');
  console.log('[insight] GEMINI_API_KEY:', mask(process.env.GEMINI_API_KEY));
  console.log('[insight] NVIDIA_API_KEY:', mask(process.env.NVIDIA_API_KEY));

  if (!process.env.GEMINI_API_KEY && !process.env.NVIDIA_API_KEY) {
    return {
      summary:
        "AI insight isn't configured yet. Add a GEMINI_API_KEY (free, no card, from aistudio.google.com/apikey) to your .env for insights grounded in real web sources. You can also add a NVIDIA_API_KEY from build.nvidia.com as a backup for when the daily Gemini limit runs out.",
      sources: [],
      fromCache: false,
      disabled: true,
    };
  }

  // Gemini first for the grounded, sourced answer. On a quota error
  // specifically, fall through to NVIDIA rather than failing outright -
  // an unsourced explanation beats a dead button. Any other kind of
  // error still falls through too, since the fallback costs nothing to
  // attempt and the alternative is showing the person nothing at all.
  // Every error is logged now regardless of type - quota errors used to
  // be swallowed silently, which hid genuine problems behind a label
  // that made them look like normal, expected rate limiting.
  let result = null;
  let usedFallback = false;
  let geminiFailed = false;

  try {
    result = await tryGemini(params);
  } catch (err) {
    geminiFailed = true;
    console.error('[insight] Gemini failed - status:', err.status || 'n/a', '- message:', err.message || err);
  }

  if (!result || !result.summary) {
    try {
      result = await tryNvidia(params);
      usedFallback = Boolean(result);
    } catch (err) {
      console.error('[insight] NVIDIA failed - status:', err.status || 'n/a', '- message:', err.message || err);
      result = null;
    }
  }

  if (!result || !result.summary) {
    const detail = geminiFailed
      ? 'Check the [insight] lines just printed above in your server console - they show the real error from whichever provider(s) were actually configured.'
      : "Neither GEMINI_API_KEY nor NVIDIA_API_KEY appears to be set correctly - check the [insight] lines just printed above.";
    return {
      summary: `Couldn't generate an insight right now. ${detail}`,
      sources: [],
      fromCache: false,
      disabled: true,
    };
  }

  // Be upfront in the text itself when the answer isn't backed by live
  // sources, so an inference is never quietly presented as researched.
  const summary = result.grounded
    ? result.summary
    : `${result.summary}\n\nNote: this explanation was generated without live web access, so it reasons from the diff itself rather than from verified sources.`;

  await db.execute({
    sql: `
      INSERT INTO insights (id, url, ts_from, ts_to, summary, sources, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [crypto.randomUUID(), url, tsFrom, tsTo, summary, JSON.stringify(result.sources), Date.now()],
  });

  return { summary, sources: result.sources, fromCache: false, grounded: result.grounded, usedFallback };
}

module.exports = { generateInsight };
