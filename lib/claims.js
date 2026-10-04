// lib/claims.js
//
// What a page used to say.
//
// Palimpsest already keeps one reading of a site's history: every capture, in
// order, prepared the same way and cached forever (lib/fetchHtml.js). The
// compare view shows two moments side by side and the timelapse plays them
// back, but both answer the same question — what does the page look like now
// versus then. This file answers a different one, and it is the question the
// record is uniquely able to answer: **what did this page promise, and when did
// it stop saying it?**
//
// A commitment is a specific kind of sentence. It names an actor who can be
// held to it ("we", "our company"), it makes a claim about the future rather
// than describing the present, and the strongest ones carry the two things
// that make a promise checkable: a number and a date. "We will reduce absolute
// emissions 50% by 2030" is a promise. "Sustainability is important to us" is
// not, and the difference is not sentiment — it is the presence of a
// commitment cue, a quantified target, a horizon, and a scope.
//
// So the analysis is deliberately literal, and every part of it is auditable:
//
//   1. Candidates are sentences that contain a commitment cue, and either a
//      category anchor (emissions, diversity, plastic, privacy, wages...) or a
//      quantified target. Nothing is inferred that is not in the text.
//   2. Each sentence is scored for strength from its own words: the verb class
//      (will/commit/pledge against aim/strive/hope), whether it carries a
//      number, whether it carries a deadline, whether it names a scope, and
//      whether it sits in a heading rather than body copy.
//   3. Sentences are matched across captures into *threads* — one promise, as
//      its wording drifts over the years — by token overlap within a bucket of
//      shared category anchors. A thread is the unit the report is about.
//   4. From a thread's sightings the interesting events fall out: it was
//      *softened* (the strength dropped, or the number or the date quietly
//      left the sentence), it was *erased* (absent from N consecutive captures
//      and never came back), or it *returned* (it did come back).
//   5. Each erasure is placed against the promise's own horizon. A claim with
//      a 2030 deadline that disappears in 2028 is a different event from the
//      same claim disappearing in 2019, and measuring that distance — the
//      Deadline Pressure — is the whole point of the exercise.
//
// What this file cannot know, and says so on the page: a record is one URL's
// captures. A promise that vanished from this page may still be standing on
// another page of the same site, and nothing here can see that. So the report
// measures disappearance *from the pages on file* and refuses to phrase it as
// an accusation. The scan is evidence; the reading of it is the reader's.

// Bumped when the analysis changes in a way that would move the numbers. The
// report is cached per (url, version), so this is also the cache key's other
// half: a report produced by older rules is never served as if it were current.
const CLAIMS_VERSION = 1;

// ---------------------------------------------------------------- vocabulary

// Commitment cues, strongest first. `strength` is the anchor the sentence's
// score is built on; `hedged` marks the phrasings that promise the direction of
// travel rather than the destination, which is exactly the shape a claim takes
// when it is being walked back without being removed.
const CUES = [
  { re: /\bwe (?:will|shall|are going to|'ll)\b/, strength: 3, label: 'will' },
  { re: /\bwe (?:commit|pledge|promise|guarantee|undertake)\b/, strength: 3, label: 'commit' },
  { re: /\b(?:we(?:'re| are) committed|our commitment|committed to)\b/, strength: 3, label: 'committed' },
  { re: /\b(?:will (?:reach|achieve|be|cut|reduce|eliminate|remove|become|source|invest|phase out|run)|target(?:s|ing)? (?:of|to)|on track to|committed to (?:reaching|achieving|becoming|cutting|reducing|eliminating|hitting))\b/, strength: 3, label: 'target' },
  // The names of the goals themselves. A page that says "24/7 carbon-free
  // energy" or "net zero" is making a claim whether or not a verb introduces
  // it, and this is exactly the vocabulary that gets edited rather than
  // deleted — a dated phrase quietly losing its date is the event the whole
  // analysis is built to see.
  { re: /\b(?:net[- ]zero|zero[- ]carbon|carbon[- ]negative|100% renewable|24\/7 carbon[- ]free|carbon[- ]free energy)\b/, strength: 3, label: 'target' },
  { re: /\bwe(?:'re| are) (?:pursuing|driving|delivering|scaling|accelerating|investing)\b/, strength: 3, label: 'pursuing' },
  { re: /\bwe (?:aim|plan|intend|expect|target|seek|pursue)\b/, strength: 2, label: 'aim' },
  { re: /\b(?:our (?:goal|target|plan|ambition|objective|commitment)\b|we have an? [a-z ]{0,24}(?:goal|target|commitment|ambition)|bold goal|ambitious goal)\b/, strength: 2, label: 'goal' },
  { re: /\b(?:working (?:to|towards|toward)|our path to|on a path to|(?:journey|path) to(?:wards)?|we (?:are|'re) working)\b/, strength: 2, label: 'working' },
  { re: /\b(?:strive|striving|endeavour|endeavor)\b/, strength: 2, label: 'strive' },
  { re: /\b(?:dedicated to|focused on|focus(?:ing|ed) on|committed to (?:supporting|helping|improving|promoting)|our mission|we (?:believe|care|value|support|advocate|champion))\b/, strength: 1, label: 'aspiration' },
  { re: /\b(?:aspir(?:e|ing|es)|hope to|would like to)\b/, strength: 1, label: 'aspiration' },
];

// The subject. A sentence about "the industry" or "governments" is not this
// site's promise, and treating it as one is how a claim scan turns into noise.
const ACTOR = /\b(?:we|our|us|the company|the group|the brand|this (?:site|website|organisation|organization|page))\b/i;

// A question is not a promise. Support pages are full of them — "When will be
// last day eligible back to Canada" reads, to a matcher, exactly like "we will
// be ready" — and a whole record can otherwise report as a claim about the
// emigration rules of another country.
const QUESTION_START = /^(?:when|what|how|where|why|who|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|may|might|must|am)\b/i;

// Categories. A sentence is filed under the category whose terms it hits most
// often, weighted per term, so "plastic" counts for more than "environment".
const CATEGORIES = [
  {
    id: 'climate', label: 'Climate and environment', weight: 1,
    terms: [
      [/\b(?:carbon|co2|emissions?|greenhouse|net[- ]zero|zero[- ]carbon|decarbonis|decarboniz)\b/, 3],
      [/\b(?:renewable|clean energy|solar|wind power|electricity|energy efficiency)\b/, 2],
      [/\b(?:sustainab|environment|climate|planet|footprint|circular|recycl|plastic|packaging|waste|water|replenish|biodiversity|deforest|emission|gigaton)\b/, 1],
    ],
  },
  {
    id: 'social', label: 'People and inclusion', weight: 1,
    terms: [
      [/\b(?:diversity|inclusion|inclusive|equity|underrepresented|under-represented|racial|gender|women in|people with disabilities|accessibility|indigenous|first nations)\b/, 3],
      [/\b(?:community|employees|workforce|colleagues|staff|volunteer|mentor|education)\b/, 1],
    ],
  },
  {
    id: 'labour', label: 'Labour and supply chain', weight: 1,
    terms: [
      [/\b(?:fair wage|living wage|minimum wage|child labour|child labor|forced labour|forced labor|modern slavery|human rights|supply chain|suppliers|ethical sourcing|worker safety|labour rights|labor rights)\b/, 3],
      [/\b(?:workers?|employees?|audit|factory|factories|farmers|sourcing)\b/, 1],
    ],
  },
  {
    id: 'privacy', label: 'Privacy and data', weight: 1,
    terms: [
      [/\b(?:privacy|personal data|personal information|your data|gdpr|tracking|trackers|cookies|third[- ]party|data protection|surveillance|sell your)\b/, 3],
      [/\b(?:secure|security|encrypt|breach)\b/, 1],
    ],
  },
  {
    id: 'governance', label: 'Governance and conduct', weight: 1,
    terms: [
      [/\b(?:transparen|accountab|anti[- ]corruption|bribery|ethics|code of conduct|compliance|whistleblower|lobby)\b/, 3],
      [/\b(?:board|governance|shareholders|independent director)\b/, 1],
    ],
  },
  {
    id: 'service', label: 'Promises to customers', weight: 1,
    terms: [
      [/\b(?:we will (?:never|always)|money[- ]back|guarantee|warranty|refund|free (?:delivery|shipping|returns)|price promise|service level|uptime)\b/, 3],
      [/\b(?:customers?|clients?|users?|members?|service|support|response time)\b/, 1],
    ],
  },
];

// Words that carry no signal when sentences are compared to each other. The
// subject and the tense words are here on purpose: two promises that differ
// only in whether they say "we will" or "we aim to" are a softening, not two
// different promises, and that distinction is one of the report's findings.
const STOPWORDS = new Set(('a about above after again against all also am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves ' +
  'company group brand business site website page people us it usd dollar dollars year years report annual update news learn more read click here contact privacy policy terms cookie cookies ' +
  'aim aims aimed plan plans planned intend intends strive strives seek seeks goal goals target targets').split(/\s+/));

// Anchors are the terms that decide which promises get compared with which, so
// the matcher stays linear-ish instead of comparing every sentence to every
// other sentence across seven hundred captures.
const ANCHORS = [];
for (const cat of CATEGORIES) {
  for (const [re] of cat.terms) {
    const m = re.source.match(/\(\?:([^)]+)\)/);
    if (!m) continue;
    for (const word of m[1].split('|')) {
      const w = word.replace(/\\b|\\/g, '').trim();
      if (w.length > 3 && /^[a-z]+$/.test(w)) ANCHORS.push({ cat: cat.id, word: w });
    }
  }
}

// ---------------------------------------------------------------- text

// One capture's sentences, each with the little context the analysis needs:
// whether it sat in a heading, and which heading it sat under. A promise in a
// heading is a different object from the same words in a paragraph ten screens
// down, and the score says so.
//
// This is a hand-rolled scan rather than a DOM parse, and that is a deliberate
// trade. A record can hold seven hundred captures, and parsing each of them
// with a real parser costs about sixty milliseconds — twenty times the whole
// rest of the analysis, for a text extraction that a single pass over the tags
// can do. What it keeps is exactly what the analysis reads: the text of each
// block, its tag, and the heading it sits under.
function sentencesOf(html) {
  // Whole elements that contain no readable promise and a great deal of
  // noise, cut out before anything else looks at the string.
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|select|option)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*\/?>/gi, ' ');

  const out = [];
  let block = '';
  let tag = 'p';
  let heading = '';
  let headingTag = false;
  let pendingHeading = false;

  const BLOCK_END = /^(?:p|li|h[1-6]|td|th|dd|dt|div|blockquote|figcaption|caption|section|article|header|footer|ul|ol|tr|table|br|form|aside|nav)$/i;

  const flush = () => {
    const text = normalise(block);
    block = '';
    if (text.length < 12) return;
    if (pendingHeading && text.length <= 160) { heading = text; headingTag = true; }
    else headingTag = false;
    for (const sentence of splitSentences(text)) {
      if (sentence.length < 30 || sentence.length > 400) continue;
      out.push({ text: sentence, tag, heading, headingTag: headingTag || /^h[1-6]$/i.test(tag) });
    }
  };

  const parts = s.split(/(<[^>]+>)/);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] !== '<') { block += part + ' '; continue; }

    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(part);
    if (!m) continue;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (/^(?:h[1-6])$/.test(name) && !closing) { flush(); pendingHeading = true; tag = name; continue; }
    if (BLOCK_END.test(name)) {
      if (closing || /^(?:br|hr)$/.test(name)) flush();
      tag = name;
      pendingHeading = false;
      continue;
    }
    if (closing) continue;
  }
  flush();
  return out;
}

function normalise(raw) {
  return String(raw)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sentence splitting that survives "Inc.", "U.S.", "e.g." and the archive's
// habit of writing dates with full stops in them.
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const out = [];
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (/\b(?:Inc|Ltd|Corp|Co|St|Mr|Ms|Dr|vs|etc|e\.g|i\.e|No|Fig)\.$/i.test(part) && out.length) {
      out[out.length - 1] += ' ' + part;
    } else {
      out.push(part);
    }
  }
  return out;
}

// ---------------------------------------------------------------- scoring

function categoryOf(text) {
  const lower = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const cat of CATEGORIES) {
    let score = 0;
    for (const [re, weight] of cat.terms) if (re.test(lower)) score += weight;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return bestScore ? best : null;
}

function numbersIn(text) {
  const percent = /(\d{1,3}(?:\.\d+)?)\s?(?:%|per cent|percent)/i.exec(text);
  const absolute = /\b(\d[\d,.]*)\s?(million|billion|thousand|tonnes?|tons?|metric tons?|kg|kilograms?|kwh|mwh|gwh|gallons?|litres?|liters?|trees|acres|hectares|people|employees|hours|days|products|packages|vehicles|stores)\b/i.exec(text);
  return {
    percent: percent ? parseFloat(percent[1]) : null,
    absolute: absolute ? `${absolute[1]} ${absolute[2].toLowerCase()}` : null,
  };
}

// The horizon a promise carries, in the promise's own terms: an explicit year
// ("by 2030"), the end of one ("by the end of 2025"), or a relative window
// ("within five years", resolved against the capture's own date — the honest
// reading, since the page wrote it for a reader standing in that year).
function horizonOf(text, captureYear) {
  const lower = text.toLowerCase();
  let m = /\b(?:by|before|in|from|until|no later than|end of|during)\s+(?:the end of\s+|fiscal year\s+|fy\s*)?(20\d{2}|by 20\d{2})\b/.exec(lower);
  if (m) {
    const year = parseInt(/\d{4}/.exec(m[1])[0], 10);
    // Only a future year is a promise. "Helped avoid 1.2 million tonnes by
    // 2022", read from a 2023 capture, is a result being reported, and
    // counting it as a deadline would put a broken promise in the deadline
    // chart that was never a promise in the first place — the most damaging
    // kind of false positive this analysis could produce.
    if (year >= captureYear && year <= captureYear + 60) {
      return { year, quote: m[0].trim() };
    }
  }
  m = /\bwithin\s+(\d{1,2}|five|ten|three|two|four|six|seven|eight|nine|fifteen|twenty)\s+(year|years|decade|decades)\b/.exec(lower);
  if (m) {
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (words[m[1]] || 0);
    if (n > 0) {
      const years = /decade/.test(m[2]) ? n * 10 : n;
      return { year: captureYear + years, quote: m[0].trim() };
    }
  }
  return null;
}

const SCOPES = /\b(?:our operations|our own operations|globally|worldwide|across the (?:company|group|business)|supply chain|our products?|our packaging|our offices|our workforce|our board|leadership|all employees|our customers|our community|our fleet|our facilities)\b/i;

// A sentence's strength, 0-100, from its own words. The weights are the model,
// and the method panel on the page prints them.
function scoreSentence(s, captureYear) {
  let strength = 0, cueLabel = 'aspiration', hedged = false;
  for (const cue of CUES) {
    if (cue.re.test(s.text)) {
      strength = Math.max(strength, cue.strength * 18);
      if (cue.strength === Math.max(...CUES.filter((c) => c.re.test(s.text)).map((c) => c.strength))) cueLabel = cue.label;
      break;
    }
  }
  const nums = numbersIn(s.text);
  const horizon = horizonOf(s.text, captureYear);
  const scope = SCOPES.test(s.text);
  const actor = ACTOR.test(s.text);
  hedged = /\b(?:aim|strive|aspir|hope|believe|seek|working)\b/i.test(s.text);

  let score = strength;
  if (nums.percent !== null || nums.absolute) score += 14;
  if (horizon) score += 12;
  if (scope) score += 8;
  if (actor) score += 6;
  if (s.headingTag) score += 5;
  if (hedged) score -= 6;
  if (/\b(?:may|could|might|if|where possible|subject to|where feasible|as appropriate)\b/i.test(s.text)) score -= 10;
  if (/\b(?:sustainability|climate|environment|diversity|inclusion|privacy|ethics)\b/i.test(s.text) && !nums.percent && !nums.absolute && !horizon) score -= 8;

  score = Math.max(5, Math.min(100, Math.round(score)));

  // Specificity is separate from strength on purpose. "We pledge to do better"
  // is a strong verb around nothing checkable; "cut 30% by 2027" is checkable
  // and unhedged. The erasure of the second is a much bigger event than the
  // erasure of the first, and only the second number captures that.
  const specificity = Math.max(0, Math.min(1,
    (nums.percent !== null || nums.absolute ? 0.4 : 0) +
    (horizon ? 0.35 : 0) +
    (scope ? 0.15 : 0) +
    (s.headingTag ? 0.1 : 0)));

  return { strength: score, specificity, numbers: nums, horizon, scope, actor, cue: cueLabel, hedged };
}

function isCandidate(s, scoring) {
  if (!scoring.actor) return false;
  if (!scoring.numbers.percent && !scoring.numbers.absolute && !scoring.horizon) {
    // Without a number or a date, the sentence has to earn its place: either it
    // is about something the record can track (a category anchor), or it says
    // in the first person that the organisation will, commits, pledges or
    // promises — which is a claim by construction, whatever it is about.
    const explicit = scoring.strength >= 54;
    if (!explicit && !categoryOf(s.text)) return false;
    if (!explicit && scoring.strength < 28) return false;
  }
  if (/\b(?:cookie|javascript|browser|newsletter|subscribe|sign up|log ?in|password)\b/i.test(s.text) && !/\bprivacy\b/i.test(s.text)) return false;
  if (/\?\s*$/.test(s.text)) return false;
  if (QUESTION_START.test(s.text)) return false;
  return true;
}

// ---------------------------------------------------------------- matching

function tokensOf(text) {
  return normalise(text).toLowerCase()
    .replace(/[^a-z0-9%$-\s]/g, ' ')
    .split(/\s+/)
    // Footnote markers arrive glued to the word they belong to — "emissions6",
    // "energy7" — and a promise has to still match itself across a year in
    // which somebody renumbered the footnotes.
    .map((w) => w.replace(/[0-9]+$/, '').replace(/^-+|-+$/g, ''))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function anchorsOf(text) {
  const lower = text.toLowerCase();
  const set = [];
  for (const a of ANCHORS) {
    if (a.word.length > 4 && lower.includes(a.word)) set.push(a.word);
  }
  return set.sort().slice(0, 6);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------- the walk

// One capture's contribution: the candidate claims it contained, in the order
// they appeared on the page.
function claimsIn(html, captureYear) {
  const found = [];
  for (const s of sentencesOf(html)) {
    const scoring = scoreSentence(s, captureYear);
    if (!isCandidate(s, scoring)) continue;
    const cat = categoryOf(s.text);
    found.push({
      text: s.text,
      category: cat ? cat.id : 'other',
      heading: s.heading,
      headingTag: s.headingTag,
      tokens: new Set(tokensOf(s.text)),
      anchors: anchorsOf(s.text),
      ...scoring,
    });
  }
  // A page can repeat one promise in a heading and in a paragraph; keep the
  // strongest reading of a near-identical sentence and drop the echo.
  found.sort((a, b) => b.strength - a.strength);
  const kept = [];
  for (const c of found) {
    if (kept.some((k) => jaccard(k.tokens, c.tokens) > 0.7)) continue;
    kept.push(c);
  }
  return kept.slice(0, 60);
}

function analyzeClaims(url, captures) {
  const threads = [];
  const timeline = [];
  const perCapture = [];

  for (const cap of captures) {
    const year = parseInt(cap.timestamp.slice(0, 4), 10) || new Date().getUTCFullYear();
    const claims = claimsIn(cap.html, year);
    perCapture.push({ timestamp: cap.timestamp, claims });
  }

  // Match each capture's claims into threads, in order, so the identity of a
  // promise is stable across the whole record.
  for (let ci = 0; ci < perCapture.length; ci++) {
    const cap = perCapture[ci];
    const seen = new Set();
    for (const c of cap.claims) {
      let best = null, bestSim = 0;
      for (const t of threads) {
        if (t.category !== c.category && c.category !== 'other' && t.category !== 'other') continue;
        const shared = t.anchors.filter((a) => c.anchors.includes(a)).length;
        if (t.anchors.length && c.anchors.length && shared === 0 && t.tokens.size && c.tokens.size) {
          if (jaccard(t.tokens, c.tokens) < 0.6) continue;
        }
        const sim = jaccard(t.tokens, c.tokens) + (shared ? Math.min(0.25, shared * 0.08) : 0);
        if (sim > bestSim) { bestSim = sim; best = t; }
      }
      if (best && bestSim >= 0.45) {
        best.sightings.push({ ci, ts: cap.timestamp, ...c });
        // The thread keeps the strongest wording it has ever used, because
        // that is the promise as it was made.
        if (c.strength > best.peak) {
          best.peak = c.strength;
          best.text = c.text;
          best.specificity = c.specificity;
        }
        if (c.horizon && !best.deadline) best.deadline = c.horizon;
        best.lastCi = ci;
        seen.add(best.id);
      } else {
        const thread = {
          id: threads.length,
          category: c.category,
          text: c.text,
          heading: c.heading,
          peak: c.strength,
          specificity: c.specificity,
          deadline: c.horizon,
          anchors: c.anchors.length ? c.anchors : anchorsOf(c.text),
          tokens: new Set(c.tokens),
          sightings: [{ ci, ts: cap.timestamp, ...c }],
          firstCi: ci,
          lastCi: ci,
        };
        threads.push(thread);
        seen.add(thread.id);
      }
    }
  }

  // ------------------------------------------------------------ events
  const total = perCapture.length;
  const summaries = [];
  for (const t of threads) {
    const seenAt = new Set(t.sightings.map((s) => s.ci));
    const peak = Math.max(...t.sightings.map((s) => s.strength));
    const last = t.sightings[t.sightings.length - 1];
    const first = t.sightings[0];

    // The events, in order, from the sightings themselves.
    const events = [{ type: 'first', ts: first.ts, text: first.text, strength: first.strength }];
    let prior = first;
    for (const s of t.sightings.slice(1)) {
      const lostNumber = (prior.numbers.percent !== null || prior.numbers.absolute) && !(s.numbers.percent !== null || s.numbers.absolute);
      const lostDeadline = !!prior.horizon && !s.horizon;
      const drop = prior.strength - s.strength;
      if (lostNumber || lostDeadline || drop >= 12) {
        events.push({
          type: 'softened', ts: s.ts, from: prior.text, to: s.text,
          lost: lostNumber ? 'the target' : (lostDeadline ? 'the deadline' : null),
          from_strength: prior.strength, to_strength: s.strength,
        });
      } else if (drop <= -12) {
        events.push({ type: 'strengthened', ts: s.ts, from: prior.text, to: s.text, to_strength: s.strength });
      }
      prior = s;
    }

    // Absence after the last sighting, or in the middle of the thread.
    let status = 'live';
    let erasure = null;
    let returned = false;
    let absence = 0;
    for (let ci = last.ci + 1; ci < total; ci++) absence++;
    const trailing = total - 1 - last.ci;

    let gapStart = -1, gapLen = 0, maxGap = 0, maxGapStart = -1;
    for (let ci = first.ci; ci <= last.ci; ci++) {
      if (seenAt.has(ci)) {
        if (gapLen > maxGap) { maxGap = gapLen; maxGapStart = gapStart; }
        gapLen = 0;
      } else {
        if (gapLen === 0) gapStart = ci;
        gapLen++;
      }
    }
    if (gapLen > maxGap) { maxGap = gapLen; maxGapStart = gapStart; }
    if (maxGap >= 2) returned = true;

    if (trailing >= 2) {
      status = 'erased';
      erasure = {
        ts: perCapture[last.ci].timestamp,
        erasedAt: perCapture[Math.min(last.ci + 1, total - 1)].timestamp,
        absentCaptures: trailing,
        absentDays: daysBetween(perCapture[last.ci].timestamp, perCapture[total - 1].timestamp),
      };
    } else if (events.some((e) => e.type === 'softened')) {
      status = 'softened';
    }

    // What replaced it: at the first capture where it is gone, the sentences
    // that arrived there and belong to no thread of their own. The nearest one
    // to the promise is kept — often the same promise with the number removed,
    // which is the most interesting sentence on the page.
    let replacedBy = null;
    if (status === 'erased') {
      const next = perCapture[last.ci + 1];
      if (next) {
        const nextTokens = new Set(tokensOf(next.claims.map((c) => c.text).join(' ')));
        let bestScore = 0;
        for (const c of next.claims) {
          const sim = jaccard(t.tokens, c.tokens) * 0.7 + jaccard(nextTokens, c.tokens) * 0.3;
          if (sim > bestScore) { bestScore = sim; replacedBy = { text: c.text, sim: Math.round(sim * 100) / 100, strength: c.strength }; }
        }
        if (replacedBy && replacedBy.sim < 0.18) replacedBy = null;
      }
    }

    const monthsBeforeDeadline = t.deadline && erasure
      ? Math.round(monthsBetween(erasure.erasedAt, `${t.deadline.year}`))
      : null;

    // Persistence rewards a promise that was held for years, not one that was
    // repeated forty times in a fortnight: archived records are full of bursts
    // (a week of daily captures), and counting sightings alone would score a
    // banner rotation like a decade-long commitment.
    const spanDays = daysBetween(first.ts, last.ts);
    const persistence = 0.45 * Math.min(1, Math.log2(1 + t.sightings.length) / Math.log2(9))
      + 0.55 * Math.min(1, spanDays / 1095);
    const urgency = t.deadline
      ? (monthsBeforeDeadline === null ? 0.6
        : monthsBeforeDeadline >= 0 && monthsBeforeDeadline <= 24 ? 1
          : monthsBeforeDeadline > 24 && monthsBeforeDeadline <= 60 ? 0.7
            : monthsBeforeDeadline < 0 ? 0.9 : 0.5)
      : 0.45;
    const outcome = status === 'erased' ? (returned ? 0.45 : 1) : (status === 'softened' ? 0.5 : 0.1);
    const score = Math.round(
      Math.max(...t.sightings.map((s) => s.strength)) *
      (0.55 + 0.45 * (t.specificity || 0)) *
      persistence * urgency * outcome
    );

    summaries.push({
      id: t.id,
      category: t.category,
      text: t.text,
      heading: t.heading,
      status,
      score: Math.max(0, Math.min(100, score)),
      peak,
      strengthNow: status === 'live' ? last.strength : null,
      specificity: t.specificity,
      deadline: t.deadline,
      firstSeen: first.ts,
      lastSeen: last.ts,
      sightings: t.sightings.length,
      spanCaptures: last.ci - first.ci + 1,
      absenceWindows: maxGap >= 2 ? [{ from: perCapture[maxGapStart].timestamp, captures: maxGap }] : [],
      returned,
      monthsBeforeDeadline,
      erasure,
      replacedBy,
      events,
      variants: t.sightings.slice(0, 12).map((s) => ({
        ts: s.ts, text: s.text, strength: s.strength,
        numbers: s.numbers, horizon: s.horizon ? s.horizon.year : null,
      })),
      timeline: t.sightings.map((s) => s.ts),
    });
  }

  // ------------------------------------------------------------ the report
  summaries.sort((a, b) => b.score - a.score);
  const erased = summaries.filter((s) => s.status === 'erased');
  const softened = summaries.filter((s) => s.status === 'softened');
  const returned = summaries.filter((s) => s.returned);

  // The index is two things at once, because either alone is misleading. The
  // mean of the strongest threads says how big the individual withdrawals
  // were; the count of *specific* erasures — a promise with a number or a date
  // that is no longer being made — says how many of them there are. A page can
  // have one enormous withdrawn claim or a dozen thin ones, and a reader
  // deserves to see both facts in the number.
  // Erasures do not arrive evenly. A record's biggest edit is often one
  // redesign — one capture in which half the promises left the page at once —
  // and that cluster is a finding in itself: it is the difference between a
  // page that stopped saying something and a page that was rewritten.
  const clusters = [];
  const byDay = new Map();
  for (const s of erased) {
    const key = s.erasure.erasedAt.slice(0, 8);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }
  for (const list of byDay.values()) {
    if (list.length < 3) continue;
    clusters.push({
      ts: list[0].erasure.erasedAt,
      count: list.length,
      threads: list.map((s) => s.id),
      texts: list.slice(0, 4).map((s) => s.text),
      categories: [...new Set(list.map((s) => s.category))],
    });
  }
  clusters.sort((a, b) => b.count - a.count);

  const top = summaries.slice(0, 5);
  const meanTop = top.length ? top.reduce((sum, s) => sum + s.score, 0) / top.length : 0;
  const specific = erased.filter((s) => s.specificity >= 0.35);
  const index = Math.round(0.55 * meanTop + 0.45 * Math.min(100, specific.length * 14));
  const band = index >= 70 ? 'Claims withdrawn late in their own countdown'
    : index >= 45 ? 'A record of withdrawals'
      : index >= 20 ? 'Some promises thinned'
        : 'Still saying what it said';

  // Erasures placed against the deadlines they were made against. This is the
  // analysis the page exists for: a promise that disappears inside the last two
  // years of its own horizon is not the same event as one that disappears with
  // thirty years of runway left.
  const buckets = [
    { label: 'No deadline given', min: null, max: null, count: 0 },
    { label: 'More than 5 years early', min: 60, max: Infinity, count: 0 },
    { label: '2–5 years early', min: 24, max: 60, count: 0 },
    { label: 'Within 2 years', min: 0, max: 24, count: 0 },
    { label: 'After its own deadline', min: -Infinity, max: 0, count: 0 },
  ];
  for (const s of erased) {
    const m = s.monthsBeforeDeadline;
    const bucket = m === null ? buckets[0] : buckets.find((b) => b.min !== null && m >= b.min && m < b.max);
    (bucket || buckets[0]).count++;
  }

  // Survival: of the promises that were made, what share was still being made
  // N months later? Computed over captures, not calendar time, then bucketed by
  // months so a record with bursts of captures does not distort the curve.
  const survival = [];
  if (perCapture.length > 1) {
    const start = tsToDate(perCapture[0].timestamp);
    const end = tsToDate(perCapture[total - 1].timestamp);
    const monthsTotal = Math.max(1, monthsBetween(perCapture[0].timestamp, perCapture[total - 1].timestamp));
    // Twelve-month buckets, and a point is only drawn where at least three
    // promises were alive to be counted at that horizon: a survival rate over
    // one or two claims is arithmetic, not evidence, and a curve that pretended
    // otherwise would be the least honest thing on the page.
    for (let m = 0; m <= Math.min(240, monthsTotal); m += 12) {
      const at = new Date(start.getTime() + m * 30.44 * 86400000);
      if (at > end) break;
      const eligible = summaries.filter((s) => tsToDate(s.firstSeen) <= at);
      if (eligible.length < 3) { survival.push({ months: m, share: null, eligible: eligible.length }); continue; }
      const alive = eligible.filter((s) => tsToDate(s.lastSeen) >= at).length;
      survival.push({ months: m, share: Math.round((alive / eligible.length) * 100) / 100, eligible: eligible.length });
    }
  }

  const categories = CATEGORIES.map((cat) => {
    const all = summaries.filter((s) => s.category === cat.id);
    if (!all.length) return null;
    return {
      id: cat.id,
      label: cat.label,
      total: all.length,
      erased: all.filter((s) => s.status === 'erased').length,
      softened: all.filter((s) => s.status === 'softened').length,
      live: all.filter((s) => s.status === 'live').length,
      meanScore: Math.round(all.reduce((sum, s) => sum + s.score, 0) / all.length),
    };
  }).filter(Boolean).sort((a, b) => b.erased - a.erased || b.total - a.total);

  return {
    version: CLAIMS_VERSION,
    url,
    generatedAt: new Date().toISOString(),
    coverage: {
      captures: total,
      first: perCapture.length ? perCapture[0].timestamp : null,
      last: perCapture.length ? perCapture[total - 1].timestamp : null,
      spanDays: perCapture.length > 1 ? daysBetween(perCapture[0].timestamp, perCapture[total - 1].timestamp) : 0,
      analyzedTimestamps: perCapture.map((c) => c.timestamp),
    },
    summary: {
      threads: summaries.length,
      erased: erased.length,
      softened: softened.length,
      returned: returned.length,
      live: summaries.filter((s) => s.status === 'live').length,
      withDeadline: summaries.filter((s) => !!s.deadline).length,
      quantified: summaries.filter((s) => s.specificity >= 0.4).length,
      index,
      band,
      specificErasures: specific.length,
      clusters: clusters.length,
      largestCluster: clusters.length ? clusters[0].count : 0,
      confidence: total >= 40 ? 'high' : total >= 12 ? 'moderate' : 'low',
    },
    categories,
    clusters,
    deadlineBuckets: buckets,
    survival,
    threads: summaries,
  };
}

// ---------------------------------------------------------------- dates

function tsToDate(ts) {
  const s = String(ts);
  const y = parseInt(s.slice(0, 4), 10);
  const mo = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  const h = parseInt(s.slice(8, 10), 10) || 0;
  const mi = parseInt(s.slice(10, 12), 10) || 0;
  return new Date(Date.UTC(y, mo, d, h, mi));
}

function daysBetween(a, b) {
  return Math.max(0, Math.round((tsToDate(b) - tsToDate(a)) / 86400000));
}

// Months from a capture to a year given as a bare number, reading "by 2030" as
// the end of 2030 rather than its start — the promise was made about the year,
// and a company is not late until the year is over.
function monthsBetween(ts, yearStr) {
  const year = parseInt(String(yearStr).replace(/\D/g, '').slice(0, 4), 10);
  if (!year) return null;
  const target = Date.UTC(year + 1, 0, 1);
  return (target - tsToDate(ts).getTime()) / (30.44 * 86400000);
}

module.exports = { analyzeClaims, claimsIn, sentencesOf, CLAIMS_VERSION, CATEGORIES };
