// lib/insight.js
//
// This is the "why did this change happen" panel. The important design
// choice here is grounding: instead of asking Claude to explain a diff from
// memory alone (which invites confident guessing), we give it the Anthropic
// web_search tool so it can actually look up news, press coverage, or
// company announcements from around the date the change happened, and build
// its explanation on top of that. The response is asked to separate what's
// backed by a real source from what's a reasonable inference from the diff
// alone, so you as the researcher can tell the difference.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const crypto = require('crypto');

const getCached = db.prepare('SELECT summary, sources FROM insights WHERE url = ? AND ts_from = ? AND ts_to = ?');
const insertCached = db.prepare(`
  INSERT INTO insights (id, url, ts_from, ts_to, summary, sources, created_at)
  VALUES (@id, @url, @ts_from, @ts_to, @summary, @sources, @created_at)
`);

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

async function generateInsight({ url, tsFrom, tsTo, dateFrom, dateTo, changes, counts }) {
  const cached = getCached.get(url, tsFrom, tsTo);
  if (cached) {
    return { summary: cached.summary, sources: JSON.parse(cached.sources), fromCache: true };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      summary:
        "AI insight isn't configured yet. Add an ANTHROPIC_API_KEY to your .env file to enable grounded explanations of what changed and why.",
      sources: [],
      fromCache: false,
      disabled: true,
    };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You're helping a researcher understand why a website changed. The site is "${url}". Two archived snapshots are being compared: one from ${dateFrom}, and one from ${dateTo}. The page had ${counts.added} additions, ${counts.removed} removals, and ${counts.changed} edited blocks between these two dates.

Here is a structural summary of what changed (not the full page, just the diffed content blocks):

${summarizeChangesForPrompt(changes)}

Search the web for real context from around this date range: news coverage, company announcements, controversies, product launches, leadership changes, or anything else that plausibly explains this change. Then write a short, clear explanation (150-250 words, plain prose, no bullet lists, no em dashes) covering:
1. What the change actually looks like in practical terms.
2. What likely caused it, based on what you find. Say plainly when something is well-supported by a source versus when it's your own reasonable inference from the diff alone.
3. Why this change might matter to someone researching this site's history.

Write for a curious, intelligent reader who is not a web developer.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });

  const summary = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();

  const sources = [];
  for (const block of response.content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.url && item.title) sources.push({ url: item.url, title: item.title });
      }
    }
  }

  insertCached.run({
    id: crypto.randomUUID(),
    url,
    ts_from: tsFrom,
    ts_to: tsTo,
    summary,
    sources: JSON.stringify(sources),
    created_at: Date.now(),
  });

  return { summary, sources, fromCache: false };
}

module.exports = { generateInsight };
