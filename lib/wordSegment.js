'use strict';

// Used only to decide whether an over-long, space-less run of letters is
// *plausibly* several real words glued together (worth flagging for human
// review), never to silently rewrite it - see the big comment in
// lib/pdfPipeline.js's flagRunTogetherWords for why guessing where to
// re-insert the spaces is not safe to do automatically.

let wordSet = null;
function dictionary() {
  if (!wordSet) wordSet = new Set(require('an-array-of-english-words').map((w) => w.toLowerCase()));
  return wordSet;
}

const MIN_WORD_LEN = 3; // excludes 1-2 letter words, which make near-any run "segmentable" and would swamp this with false positives

// Dynamic-programming word-break, minimizing segment count so "asks" isn't
// preferred over, say, a single longer dictionary word that also fits, and
// so a genuine run of several words doesn't get lost among many spurious
// short-word splits. Returns null if there is no full split into real
// dictionary words at all.
function bestSegmentation(s, dict) {
  const n = s.length;
  const bestCount = new Array(n + 1).fill(Infinity);
  const bestCut = new Array(n + 1).fill(-1);
  bestCount[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      if (bestCount[j] === Infinity) continue;
      const word = s.slice(j, i);
      if (word.length < MIN_WORD_LEN || !dict.has(word)) continue;
      const count = bestCount[j] + 1;
      if (count < bestCount[i]) {
        bestCount[i] = count;
        bestCut[i] = j;
      }
    }
  }
  if (bestCount[n] === Infinity) return null;
  const words = [];
  let i = n;
  while (i > 0) {
    const j = bestCut[i];
    words.unshift(s.slice(j, i));
    i = j;
  }
  return words;
}

// High-confidence check only: a lowercase (or Title-case) run of letters
// that is *not* itself a real word, but *does* fully decompose into 2+ real
// dictionary words. CamelCase tokens (a lowercase letter directly followed
// by an uppercase one, e.g. "getUserName") are excluded outright - that
// pattern is essentially always a code identifier, not prose, in the books
// this tool processes, and dictionary-splitting those produces a lot of
// noise (e.g. "calculateRevenueRecognitions" technically decomposes into
// real words, but flagging it just hides the genuine issues in noise).
function suggestRunTogetherSplit(token) {
  const core = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (core.length < 16) return null;
  if (/[a-z][A-Z]/.test(core)) return null;
  const dict = dictionary();
  const lower = core.toLowerCase();
  if (dict.has(lower)) return null; // a real word, just a long one
  const words = bestSegmentation(lower, dict);
  if (!words || words.length < 2) return null;
  return words.join(' ');
}

// Splits a known-glued run of letters back into words, keeping its case.
// With `counts` (word -> occurrences in the book itself) this is a unigram
// segmentation: each word costs -log(its frequency), so common words win
// ties the dictionary alone can't settle - "versions of a record", not
// "version sofa record"; "sample data", not "sampled at a". Without
// counts it falls back to preferring fewer, longer words.
const SHORT_WORDS = new Set(['a', 'an', 'as', 'at', 'by', 'in', 'is', 'it', 'of', 'on', 'or', 'to']);
const BAD_SPLIT_WORDS = new Set(['fora', 'ands', 'ofa', 'toa', 'ina', 'ora', 'isa', 'ona']);
function splitRunTogether(word, minLength = 10, counts = null) {
  const lower = word.toLowerCase();
  const dict = dictionary();
  // Words the book itself uses repeatedly count as real, too (technical
  // terms like 'denormalized' that no general dictionary has).
  const known = (w) => dict.has(w) || (counts != null && (counts.get(w) || 0) >= 2);
  if (lower.length < minLength || known(lower)) return word;
  let total = 0;
  if (counts) for (const c of counts.values()) total += c;
  const cost = (w) => (counts && total
    ? -Math.log(((counts.get(w) || 0) + 0.1) / total)
    : (w.length >= 3 ? -w.length * w.length : 2));
  const n = lower.length;
  const best = new Array(n + 1).fill(Infinity);
  const cut = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      if (best[j] === Infinity) continue;
      const w = lower.slice(j, i);
      const ok = w.length >= 3 ? known(w) && !BAD_SPLIT_WORDS.has(w) : SHORT_WORDS.has(w);
      if (!ok) continue;
      const score = best[j] + cost(w);
      if (score < best[i]) { best[i] = score; cut[i] = j; }
    }
  }
  if (best[n] === Infinity) return word;
  const pieces = [];
  for (let i = n; i > 0; i = cut[i]) pieces.unshift(word.slice(cut[i], i));
  return pieces.join(' ');
}

module.exports = { suggestRunTogetherSplit, splitRunTogether, dictionary };
