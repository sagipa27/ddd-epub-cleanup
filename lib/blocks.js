'use strict';

const { dictionary, splitRunTogether } = require('./wordSegment');

// Turns the flat list of merged visual lines for one page into semantic
// blocks (headings, paragraphs, code, lists, dialogue, captions, ...),
// repairing PDF line-wrap hyphenation and merging wrapped lines into
// paragraphs along the way. All thresholds are derived from font metrics
// that are shared/constant across the whole book (verified empirically),
// not guessed per page.

// Default profile: the exact font sizes measured by hand for this book's
// pdf2htmlEX export. configure() lets a caller (e.g. the generic PDF
// ingestion path, which calibrates these per-document - see
// lib/calibrate.js) override them; the pdf2htmlEX/HTML path never calls
// configure(), so its behavior is unchanged.
const FS = {
  H1: 82.558862,
  H2: 56.590578,
  H3: 45.272462,
  CAPTION: 31.734672,
  SMALL: 30.181642,
  CODE: 28.446197,
};
let EPS = 0.6;
const near = (a, b) => Math.abs(a - b) < EPS;

// Bootstrap-only fallback for makeExpectedGap below, before it has seen
// enough real same-paragraph gaps of its own to trust its own rolling
// median. Hand-measured for the original book's pica-based units; the
// generic PDF path overrides this via configure({ LINE_GAP }) with an
// estimate of *that* document's own line pitch (see
// lib/calibrate.js#estimateLineGap) so a book with different (typically
// more generous) leading doesn't reject every line as its own paragraph
// before the rolling estimate ever gets a chance to correct itself.
let DEFAULT_LINE_GAP = 20;

// Code samples are pushed from raw .text (never .html - that may carry
// <strong>/<em> wrapping, which a code listing should never get), so any
// literal '<'/'>'/'&' actually typed in the sample (XML/HTML snippets are
// common in code listings) must be escaped here or it gets parsed as real
// markup in the final XHTML - see the duplicate-id/well-formedness bugs
// this caused before this existed.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Consistent left-indent used for every code sample in this specific book -
// a hand-measured pixel constant that has no equivalent in an arbitrary PDF,
// so the generic ingestion path disables it via configure() and relies on
// monospace-font detection (line.monospace) instead.
let CODE_X = 110.35;

// Overrides the module's font-size/x-position thresholds for one document.
// Pass only the keys that apply; anything else falls back to codeXOverride
// = null (disabled) rather than silently keeping a value tuned for a
// different book.
function configure(profile) {
  if (profile.FS) Object.assign(FS, profile.FS);
  if (profile.EPS != null) EPS = profile.EPS;
  CODE_X = profile.CODE_X != null ? profile.CODE_X : -1e9; // effectively disabled
  DEFAULT_LINE_GAP = profile.LINE_GAP != null ? profile.LINE_GAP : 20;
}

const HYPHEN_SAFE_PREFIXES = new Set([
  'self', 'well', 'non', 'co', 'pre', 'post', 'multi', 'cross', 're', 'de',
  'under', 'over', 'out', 'in', 'up', 'down', 'off', 'on', 'one', 'two',
  'first', 'second', 'third', 'top', 'bottom', 'left', 'right', 'open',
  'closed', 'built', 'hand', 'large', 'small', 'single', 'role', 'rule',
  'business', 'real', 'high', 'low', 'long', 'short', 'object', 'model',
  'domain', 'data', 'type', 'sub', 'super', 'meta', 'inter', 'intra',
  'anti', 'semi', 'mid', 'back', 'side', 'time', 'life', 'world', 'end',
]);

// Concatenates same-line fragments left-to-right, inserting a space at any
// gap wide enough to be a real word boundary. pdf2htmlEX's HTML always
// marks inter-word gaps with an explicit (possibly space-containing) spacer
// span, so fragments there never need a *guessed* space and never carry an
// `endX` - the gap check below is simply never true for them, leaving that
// path byte-for-byte unaffected. Raw PDF extraction (lib/pdfIngest.js) has
// no such marker: many PDFs place separate words via pure positioning, with
// no space character in either text run, so this is the only place that
// gap ever gets a chance to become an actual space.
function joinFragments(frags) {
  let text = '';
  let html = '';
  let prevEndX = null;
  for (const f of frags) {
    if (prevEndX != null && f.x != null) {
      const gap = f.x - prevEndX;
      // A real space is roughly 0.2-0.3em; kerning/rounding noise between
      // touching glyphs is much smaller than that, so a conservative slice
      // of one em cleanly separates "space" from "no space" either way.
      const spaceThreshold = 0.12 * (f.fs || 1);
      if (gap > spaceThreshold && !/\s$/.test(text) && !/^\s/.test(f.text)) {
        text += ' ';
        html += ' ';
      }
    }
    text += f.text;
    html += f.html;
    if (f.endX != null) prevEndX = f.endX;
  }
  return { text, html };
}

// --- Step 1: merge divs that share the same visual line (same y) ---------
function mergeVisualLines(rawLines) {
  const groups = new Map();
  for (const l of rawLines) {
    const key = l.y.toFixed(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const merged = [];
  for (const [, allFrags] of groups) {
    // Some PDFs fake bold by drawing the same run twice at (almost) the same
    // spot; keep one copy. Only positioned fragments (raw PDF) can be
    // compared this way - pdf2htmlEX lines are never deduplicated.
    const frags = allFrags.filter((f, k) => f.endX == null || !allFrags.slice(0, k).some((g) =>
      g.endX != null && g.text === f.text && Math.abs(g.x - f.x) < 1));
    // Sort left-to-right; an unresolved x (missing class) must never be
    // coerced to 0 by bare subtraction, or it would jump to the front of
    // the line ahead of everything else.
    frags.sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity));
    const { text, html } = joinFragments(frags);
    // Dominant style = the fragment contributing the most characters, so a
    // short inline emphasis run doesn't hijack the whole line's role.
    const dominant = frags.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const firstFrag = frags[0];
    const boldColonPrefix = /^\s*[A-Z][\w .'()-]{0,38}?:\s/.test(text) && firstFrag.bold;
    // Right edge of the line, when the ingestion path knows it (raw PDF
    // only - pdf2htmlEX fragments carry no endX, leaving this null there).
    const endXs = frags.map((f) => f.endX).filter((e) => e != null);
    // Share of the line's visible characters set in each style. A line is
    // only code/a bold heading/an italic term when (nearly) *all* of it is,
    // not merely its longest fragment - one long inline path or identifier
    // in monospace must not turn a whole prose line into a code listing.
    const visible = (f) => f.text.replace(/\s/g, '').length;
    const totalChars = frags.reduce((n, f) => n + visible(f), 0) || 1;
    const share = (key) => frags.reduce((n, f) => n + (f[key] ? visible(f) : 0), 0) / totalChars;
    merged.push({
      x: frags[0].x,
      y: frags[0].y,
      endX: endXs.length ? Math.max(...endXs) : null,
      fs: dominant.fs,
      italic: dominant.italic,
      monospace: dominant.monospace, // undefined for pdf2htmlEX lines - harmless no-op there
      monoShare: share('monospace'),
      boldShare: share('bold'),
      italicShare: share('italic'),
      // Kept for table reconstruction, which needs each positioned piece
      // of a row separately rather than the whole joined line.
      parts: endXs.length ? frags.map((f) => ({ x: f.x, endX: f.endX, text: f.text, html: f.html })) : null,
      html,
      text,
      boldColonPrefix,
      domIndex: Math.min(...frags.map((f) => f.domIndex)),
    });
  }
  merged.sort((a, b) => b.domIndex - a.domIndex === 0 ? 0 : (a.domIndex - b.domIndex));
  return merged;
}

// --- Step 2: classify each merged line into a structural role ------------
function classifyLine(line) {
  if (line.isFigure) return 'figure';
  if (line.isTable) return 'table';
  const t = line.text.trim();
  // Part titles, when a book has them (lib/calibrate.js#refineHeadingLevels),
  // share the chapter level: each opens a new page and a top-level TOC entry.
  if (FS.PART != null && near(line.fs, FS.PART)) return 'h1';
  if (near(line.fs, FS.H1)) return 'h1';
  if (near(line.fs, FS.H2)) return 'h2';
  if (near(line.fs, FS.H3)) return 'h3';
  if (near(line.fs, FS.CODE) || (Math.abs(line.x - CODE_X) < 1 && looksLikeCode(t))) return 'code';
  // A monospace font is a strong, book-independent code signal (available
  // only from the generic PDF ingestion path - pdf2htmlEX lines never set
  // this flag, so this is a no-op for the original book).
  if (t.trim() && (line.monoShare != null ? line.monoShare >= 0.9 : line.monospace)) return 'code';
  if (line.bulletMarker) return 'bullet';
  // A bullet/number marker is a stronger structural signal than the text's
  // font size - callout boxes and sidebars render their own bullet lists at
  // caption size, but they're still lists, not prose.
  if (/^[•\u2022]\s+/.test(t)) return 'bullet';
  if (/^\d+\.\s+\S/.test(t)) return 'numbered';
  if (near(line.fs, FS.CAPTION)) {
    return /^Figure\s+\d/i.test(t) ? 'figure-caption' : 'attribution';
  }
  if (line.fs != null && line.fs < FS.SMALL + EPS && line.fs > 20) {
    // Small ambiguous band: table/box fragments, or poem/small-code that
    // shares a font size with nothing else distinctive. Default to a
    // conservative "small" role; block-building decides how to group it.
    if (looksLikeCode(t)) return 'code';
    if (/^Table:\s/.test(t)) return 'table-heading';
    return 'small';
  }
  if (line.boldColonPrefix) return 'dialogue-start';
  return 'paragraph';
}

function looksLikeCode(t) {
  if (!t.trim()) return true; // blank filler row inside a code/table block
  const codeSignal = /[;{}]|^\s*(public|private|protected|class|void|int|String|assert|return|new |import |package )\b/;
  return codeSignal.test(t);
}

// --- helpers for paragraph joining / hyphenation --------------------------
function endsWithHardHyphen(text) {
  return /[A-Za-z]-$/.test(text.trimEnd()) && !/--$/.test(text.trimEnd());
}

function lastWordFragment(text) {
  const m = text.trimEnd().match(/([A-Za-z]+)-$/);
  return m ? m[1].toLowerCase() : null;
}

// Settles a line-end hyphen with the dictionary where it can: "manage-" /
// "ment" fuses into a real word, while "cost-" / "effectiveness" is two
// real words that don't fuse, so its hyphen is part of the compound.
// Returns null when the dictionary can't tell either way.
// The book's own usage comes first, though: how it spells the word where it
// *isn't* broken across a line ("real-time" mid-line vs "realtime") is the
// most reliable answer there is, and the only one for words the dictionary
// knows both ways.
let corpus = null;
function setCorpus(counts) { corpus = counts; }

function buildCorpus(texts) {
  const counts = new Map();
  for (const t of texts) {
    // A trailing "word-" is itself a line-end break, not evidence of usage.
    const body = t.replace(/[A-Za-z]+-\s*$/, '');
    for (const w of body.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || []) counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

function dictionaryHyphenVerdict(prevText, nextText) {
  const prefix = lastWordFragment(prevText);
  const m = nextText.trimStart().match(/^([a-z]+)/);
  if (!prefix || !m) return null;
  const fused = prefix + m[1];
  if (corpus) {
    const hyphenated = corpus.get(`${prefix}-${m[1]}`) || 0;
    const joined = corpus.get(fused) || 0;
    if (hyphenated > joined) return 'keep';
    if (joined > hyphenated) return 'fuse';
  }
  // A fused form that is itself a word ("in-" / "stance" -> "instance") is
  // almost always a typesetter's line-break hyphen, even when both halves
  // happen to be words too; the corpus above already caught the books that
  // really spell a compound hyphenated ("real-time").
  const dict = dictionary();
  if (dict.has(fused)) return 'fuse';
  if (prefix.length > 1 && dict.has(prefix) && dict.has(m[1])) return 'keep';
  return null;
}

function joinWrappedText(prevHtml, prevText, nextHtml, nextText, warnings) {
  if (endsWithHardHyphen(prevText)) {
    if (/^[a-z]/.test(nextText.trimStart())) {
      const verdict = dictionaryHyphenVerdict(prevText, nextText);
      if (verdict === 'keep') return { html: prevHtml + nextHtml, text: prevText + nextText };
      if (verdict === 'fuse') {
        return {
          html: prevHtml.replace(/-((?:<\/[a-z]+>)*)$/, '$1') + nextHtml,
          text: prevText.replace(/-$/, '') + nextText,
          repaired: { before: prevText.slice(-30) + ' / ' + nextText.slice(0, 30) },
        };
      }
      const prefix = lastWordFragment(prevText);
      if (prefix && HYPHEN_SAFE_PREFIXES.has(prefix)) {
        warnings.push({ type: 'ambiguous-hyphen', prefix, before: prevText.slice(-40), after: nextText.slice(0, 40) });
        return { html: prevHtml + nextHtml, text: prevText + nextText }; // keep hyphen, just unwrap the line break
      }
      // Confident mid-word break: drop the hyphen and fuse the fragments.
      return {
        html: prevHtml.replace(/-$/, '') + nextHtml,
        text: prevText.replace(/-$/, '') + nextText,
        repaired: { before: prevText.slice(-30) + ' / ' + nextText.slice(0, 30) },
      };
    }
    if (/^[A-Z]/.test(nextText.trimStart())) {
      // Next fragment starts uppercase (common for small-caps/all-caps
      // rendered terms, e.g. "MODEL-" / "DRIVEN DESIGN"): this is almost
      // always a legitimate compound term wrapped exactly at its own
      // hyphen, not a PDF line-wrap artifact. Keep the hyphen, no space.
      return { html: prevHtml + nextHtml, text: prevText + nextText };
    }
  }
  return { html: prevHtml + ' ' + nextHtml, text: prevText + ' ' + nextText };
}

// A visual "line" that is nothing but closing punctuation (most commonly a
// lone "]" or ")") is never a real paragraph on its own - it's always the
// tail of whatever bracketed/parenthetical aside came before it, just pushed
// onto its own line by extra leading in the source PDF. Force-merge it onto
// the previous block with no inserted space, regardless of the vertical gap.
function isClosingPunctuationOnly(text) {
  return /^[\]\)\}»"”'’.,;:!?]+$/.test(text.trim());
}

// A line ending in a comma or a function word ("... Java or" / "Scala
// will be ...") can't be the end of a sentence, so the next line continues
// it even when that line starts with a capitalized proper noun.
const DANGLING_CONNECTOR_RE = /(,|\b(and|or|nor|but|the|a|an|of|to|in|into|for|with|on|at|by|from|as|is|are|was|were|be|that|which|than|such|like|using|via))$/i;

function continuesAcrossBoundary(next, prevText) {
  const prevEndsOpen = !/[.!?:;"'”)\]]\s*$/.test(prevText.trimEnd()) || endsWithHardHyphen(prevText);
  const nextTrimmed = next.text.trimStart();
  // A lowercase start is the usual continuation signal, but this book also
  // renders its own glossary terms (ENTITY, VALUE OBJECT, MODULE, ...) in
  // full caps, so a wrap that resumes mid-term looks like "...VALUE" /
  // "OBJECT." - still a continuation, just capitalized differently.
  const nextLooksLikeContinuation = /^[a-z]/.test(nextTrimmed) || /^[A-Z]{2,}\b/.test(nextTrimmed) ||
    (/^[A-Z]/.test(nextTrimmed) && DANGLING_CONNECTOR_RE.test(prevText.trimEnd()));
  return prevEndsOpen && nextLooksLikeContinuation;
}

// Some books set particular blocks (definition-list bodies, sidebars,
// indented notes) with looser leading than body text, e.g. 24.8 vs 18.8 -
// just wide enough to trip the body-pitch paragraph-break test on every
// single line. Such a gap is still a line wrap when the block keeps that
// same pitch on the following line (same x, same size), and the line before
// the gap runs (nearly) the full column width the way a wrapped line does -
// short equally-spaced lines (unmarked lists, run-in headings like "Log
// encoding" / "Logs are encoded ...", reference lists) never do.
// `localPitch` is null for a paragraph's first over-threshold gap, which
// must also show the sentence isn't over; the caller then adopts that gap
// as the paragraph's own pitch and later gaps only need to match it.
// `fullWidth` is the book's typical width of a wrapped body line (measured
// by the caller from ordinary same-paragraph wraps), since comparing a run
// of short list items only against each other makes every one look "full".
function isLooseLeadingWrap(lines, j, gap, prevText, bodyPitch, localPitch, fullWidth) {
  const prev = lines[j - 1];
  const next = lines[j];
  if (prev.endX == null || next.endX == null || fullWidth == null) return false;
  if (gap > bodyPitch * 1.75) return false;
  if (!near(prev.fs, next.fs)) return false;
  // A hanging term left of an indented body ("SQL" / "The most common
  // interface ...") starts a separate block, never a wrap.
  if (next.x - prev.x > 1) return false;
  // Inside a sidebar box the column is the box, not the page: a wrapped
  // line there can't reach the book's full text width.
  const available = prev.box ? Math.min(fullWidth, prev.box.x1 - prev.x - 6) : fullWidth;
  if (prev.endX - prev.x < available * 0.8) return false;
  const after = lines[j + 1];
  const afterComparable = after && !after.pageBoundary && !after.isFigure && after.endX != null &&
    classifyLine(after) === 'paragraph' && Math.abs(after.x - next.x) < 1 && near(after.fs, next.fs);
  if (localPitch != null) return Math.abs(gap - localPitch) < localPitch * 0.05;
  // Merely lacking final punctuation isn't enough here: unmarked list items
  // ("... by Prukalpa" / "“Data Architecture ...”") lack it too.
  const textContinues = /^[a-z]/.test(next.text.trimStart()) ||
    DANGLING_CONNECTOR_RE.test(prevText.trimEnd()) || endsWithHardHyphen(prevText);
  if (!textContinues) return false;
  // The same spacing continuing past this gap = the block's own pitch.
  if (afterComparable) return Math.abs((next.y - after.y) - gap) < gap * 0.05;
  // Two-line block (nothing comparable follows): a shared left edge is the
  // best remaining evidence.
  return Math.abs(prev.x - next.x) < 1;
}

// Footnote reference markers are printed as an isolated 1-3 digit number in
// the caption/attribution-sized font, sitting inline mid-sentence (the
// footnote's own body text elsewhere always starts with "N " in normal body
// size, so it is unaffected). Detected purely on shape+size, independent of
// classifyLine's own role logic, and folded directly into the surrounding
// text as a <sup> before block-building ever sees them - this is what
// prevents them from being misread as paragraph/section breaks.
function isFootnoteMarker(line) {
  return !line.isFigure && /^\d{1,3}$/.test(line.text.trim()) &&
    (near(line.fs, FS.CAPTION) || near(line.fs, FS.SMALL));
}

function foldFootnoteMarkers(mergedLines) {
  const out = [];
  for (const line of mergedLines) {
    if (isFootnoteMarker(line) && out.length) {
      const prev = out[out.length - 1];
      const prevRole = classifyLine(prev);
      if (prevRole === 'paragraph' || prevRole === 'dialogue-start') {
        prev.html += `<sup>${line.text.trim()}</sup>`;
        prev.text += line.text.trim();
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

// Glyph-stacked captions (lib/layout.js#joinVerticalStacks) often lose most
// of their word breaks in the PDF itself: "Table 5-2. Comparison of
// RDBMSanddocumentterminology". Re-split them - acronym/camelCase edges
// first, then the book's own word frequencies (the corpus) for the rest.
// Only ever applied to stacked text, never to running prose.
function repairStackedText(text) {
  return text
    .replace(/([A-Z]{2,})(?=[a-z]{2,})/g, '$1 ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)(?=[a-z]{3,})/g, '$1 $2 ')
    .replace(/[A-Za-z]{5,}/g, (w) => splitRunTogether(w, 5, corpus))
    .replace(/^(Table|Figure|Example)(?=\d)/, '$1 ')
    .replace(/^((?:Table|Figure|Example) \d+(?:[-.]\d+)*\.)(?=\S)/, '$1 ');
}

// Sidebar membership (see lib/layout.js#assignBoxGroups). Always null on
// the pdf2htmlEX path, so every "same box" check below is a no-op there.
const boxOf = (l) => (l && l.boxGroup != null ? l.boxGroup : null);

// List items can wrap onto a second (unmarked) visual line just like body
// text does. A genuine same-item wrap reads as a lowercase-continuing
// sentence fragment - the same signal used for cross-page paragraph
// continuation - which is a safer test here than a vertical-gap threshold,
// since list items are often spaced further apart than a single line of
// their own wrapped text (risking swallowing whatever prose follows the
// list entirely).
//
// Items whose bullet is a drawn dot (line.bulletMarker, from the PDF's
// vector shapes) have a much stronger signal available: a wrap line starts
// exactly at the item text's own left edge, one ordinary line pitch below,
// and never has a dot of its own.
function collectListItems(mergedLines, startIndex, role, markerRe, report, expectedGap) {
  const items = [];
  const first = mergedLines[startIndex];
  let html = first.html.replace(markerRe, '');
  let text = first.text.replace(markerRe, '');
  let itemX = first.x;
  let prevY = first.y;
  let j = startIndex + 1;
  while (j < mergedLines.length) {
    const next = mergedLines[j];
    if (boxOf(next) !== boxOf(first)) break;
    const nextRole = classifyLine(next);
    if (nextRole === role) {
      items.push(html);
      html = next.html.replace(markerRe, '');
      text = next.text.replace(markerRe, '');
      itemX = next.x;
      prevY = next.y;
      j++;
      continue;
    }
    const isProseContinuation = nextRole === 'paragraph' || nextRole === 'attribution' || nextRole === 'small';
    if (!isProseContinuation) break;
    if (first.bulletMarker) {
      if (Math.abs(next.x - itemX) > 1.5) break;
      if (next.pageBoundary ? !continuesAcrossBoundary(next, text) : prevY - next.y > expectedGap() * 1.3) break;
    } else if (next.pageBoundary || !continuesAcrossBoundary(next, text)) {
      break;
    }
    const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
    if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
    html = joined.html; text = joined.text;
    prevY = next.y;
    j++;
  }
  items.push(html);
  return { items, nextIndex: j };
}

// --- Step 3: group classified lines into semantic blocks ------------------
function buildBlocks(rawMergedLines, report) {
  const mergedLines = foldFootnoteMarkers(rawMergedLines);
  const blocks = [];
  let i = 0;
  // Rolling estimate of "normal" single-line vertical pitch for paragraph
  // text, recalibrated from whatever body-text gaps we've actually seen.
  // Captions/attributions run at a different font size and so get their
  // own independent pitch estimate.
  let bodyGaps = [];
  let captionGaps = [];

  function makeExpectedGap(gaps) {
    return () => {
      if (gaps.length < 3) return DEFAULT_LINE_GAP; // sane default before we have data
      const sorted = [...gaps].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
  }
  const expectedGap = makeExpectedGap(bodyGaps);
  const expectedCaptionGap = makeExpectedGap(captionGaps);
  // Widths of body lines that wrapped at normal pitch - i.e. full-width
  // lines - for isLooseLeadingWrap's "does this line reach the margin" test.
  // Stays empty (disabling that test) on the pdf2htmlEX path, whose lines
  // carry no endX.
  const bodyWidths = [];
  const fullLineWidth = () => {
    if (bodyWidths.length < 20) return null;
    const sorted = [...bodyWidths].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  // Sidebars open/close as box membership changes between blocks; every
  // inner loop below stops at a box boundary so no block straddles one.
  let openBox = null;

  while (i < mergedLines.length) {
    const line = mergedLines[i];

    if (boxOf(line) !== openBox) {
      if (openBox != null) blocks.push({ type: 'aside-end' });
      if (boxOf(line) != null) blocks.push({ type: 'aside-start' });
      openBox = boxOf(line);
    }

    if (line.isFigure) {
      blocks.push({ type: 'figure', src: line.src, alt: line.alt });
      i++;
      continue;
    }

    if (line.isTable) {
      blocks.push({ type: 'table', rows: line.rows });
      i++;
      continue;
    }

    const role = classifyLine(line);

    if (role === 'h1' || role === 'h2' || role === 'h3') {
      // Long chapter/section titles wrap across two (rarely three) visual
      // lines at the same heading font size, e.g. "Chapter Two. Communication
      // and the Use of" / "Language". These are one logical heading, not two
      // - merge consecutive same-level heading lines exactly like paragraph
      // wraps, including hyphen repair, but never across a page boundary
      // (a heading never legitimately spans two pages in this book). A
      // change of weight at the same size (a title page's roman subtitle
      // over its bold author line) is two separate lines, not a wrap.
      let html = line.html;
      let text = line.text;
      let j = i + 1;
      while (j < mergedLines.length && !mergedLines[j].pageBoundary && classifyLine(mergedLines[j]) === role &&
        boxOf(mergedLines[j]) === boxOf(line) &&
        Math.abs((mergedLines[j].boldShare || 0) - (line.boldShare || 0)) < 0.5) {
        const next = mergedLines[j];
        const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
        if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
        html = joined.html; text = joined.text;
        j++;
      }
      blocks.push({ type: role, html: html.trim() });
      i = j;
      continue;
    }

    if (role === 'figure-caption' || role === 'attribution') {
      // Captions/side-notes wrap across multiple caption-sized visual lines
      // just like body paragraphs do, including line-wrap hyphenation, but
      // a large vertical gap still marks a real break between two distinct
      // notes (e.g. separate mini-examples in one sidebar).
      //
      // Some sidebars also embed a diagram mid-caption (text - image - text
      // continues). The image must stay exactly where it is - splicing it
      // out to join the caption text would misplace it - so on hitting a
      // figure we flush the caption-so-far (repairing a trailing hyphen in
      // place, since the word is about to be visually interrupted anyway),
      // emit the figure untouched, then start a fresh caption block for
      // whatever text resumes after it.
      let html = line.html;
      let text = line.text;
      let prevY = line.y;
      let j = i + 1;
      let flushedForFigure = false;
      while (j < mergedLines.length) {
        const next = mergedLines[j];
        if (boxOf(next) !== boxOf(line)) break;
        if (next.isFigure) {
          if (endsWithHardHyphen(text)) {
            // Can't confirm "next word starts lowercase" across an image the
            // way joinWrappedText does, but a hard hyphen at this exact spot
            // is always a mid-word PDF line-wrap break in this book's
            // sidebars, never an intentional compound - strip it in place.
            report.hyphenRepairs.push({ before: text.slice(-30) + ' / [figure] / (continues after figure)' });
            html = html.replace(/-$/, '');
            text = text.replace(/-$/, '');
          }
          blocks.push({ type: role, html: html.trim() });
          blocks.push({ type: 'figure', src: next.src, alt: next.alt });
          flushedForFigure = true;
          j++;
          if (j < mergedLines.length && classifyLine(mergedLines[j]) === role && boxOf(mergedLines[j]) === boxOf(line)) {
            html = mergedLines[j].html;
            text = mergedLines[j].text;
            prevY = mergedLines[j].y;
            flushedForFigure = false;
            j++;
            continue;
          }
          break;
        }
        if (classifyLine(next) !== role) break;
        if (!next.pageBoundary) {
          const gap = prevY - next.y;
          if (gap > expectedCaptionGap() * 1.3) break;
          captionGaps.push(gap);
        }
        const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
        if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
        html = joined.html; text = joined.text;
        prevY = next.y;
        j++;
      }
      if (!flushedForFigure) blocks.push({ type: role, html: html.trim() });
      i = j;
      continue;
    }

    if (role === 'table-heading' || role === 'small') {
      // Group the whole contiguous run of small/table-ish lines together;
      // exact column relationships aren't recoverable from this text alone,
      // so we preserve it verbatim and flag it for manual review.
      const group = [line];
      let j = i + 1;
      while (j < mergedLines.length && ['table-heading', 'small'].includes(classifyLine(mergedLines[j])) && boxOf(mergedLines[j]) === boxOf(line)) {
        group.push(mergedLines[j]);
        j++;
      }
      blocks.push({ type: 'table-like', lines: group.map((l) => l.html) });
      report.warnings.push({ type: 'table-needs-review', sample: group.map((l) => l.text).join(' | ').slice(0, 160) });
      i = j;
      continue;
    }

    if (role === 'code') {
      const group = [line];
      let j = i + 1;
      while (j < mergedLines.length && classifyLine(mergedLines[j]) === 'code' && boxOf(mergedLines[j]) === boxOf(line)) {
        group.push(mergedLines[j]);
        j++;
      }
      // Blank filler rows between table/code blocks (an empty positioned
      // element with no text) are page-layout artifacts, not content.
      if (group.some((l) => l.text.trim())) {
        blocks.push({ type: 'code', lines: group.map((l) => escapeHtml(l.text)) });
      }
      i = j;
      continue;
    }

    if (role === 'bullet' || role === 'numbered') {
      const markerRe = role === 'bullet' ? /^\s*[••]\s+/ : /^\s*\d+\.\s+/;
      const { items, nextIndex } = collectListItems(mergedLines, i, role, markerRe, report, expectedGap);
      blocks.push({ type: role === 'bullet' ? 'ul' : 'ol', items });
      i = nextIndex;
      continue;
    }

    if (role === 'dialogue-start') {
      // A dialogue turn continues, accumulating wrapped/continuation lines,
      // until the next bold "Speaker:" line or a role change ends it.
      let html = line.html;
      let text = line.text;
      let j = i + 1;
      while (j < mergedLines.length) {
        const next = mergedLines[j];
        const nextRole = classifyLine(next);
        if (nextRole !== 'paragraph' || boxOf(next) !== boxOf(line)) break;
        if (!continuesAcrossBoundary(next, text)) break;
        const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
        if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
        html = joined.html; text = joined.text;
        j++;
      }
      blocks.push({ type: 'dialogue', html: html.trim() });
      i = j;
      continue;
    }

    // Default: paragraph text, merge wrapped lines using the gap heuristic
    // (or, across a page turn, using punctuation/case continuity instead,
    // since absolute y coordinates reset on every new page).
    {
      let html = line.html;
      let text = line.text;
      let prevY = line.y;
      // Set once this paragraph proves to use looser leading than body
      // text (see isLooseLeadingWrap); its later wraps are judged against it.
      let localPitch = null;
      const used = [line];
      let j = i + 1;
      while (j < mergedLines.length) {
        const next = mergedLines[j];
        const nextRole = classifyLine(next);
        if (nextRole !== 'paragraph' || boxOf(next) !== boxOf(line)) break;
        // A short, entirely bold line over ordinary text is a run-in
        // heading ("Data governance" / "Data governance is ..."), not the
        // first line of a paragraph, however tight the spacing below it.
        const width = fullLineWidth();
        if (used.length === 1 && line.boldShare >= 0.95 && (next.boldShare || 0) < 0.5 &&
          line.endX != null && width != null && line.endX - line.x < width * 0.8) break;
        const danglingClosePunct = isClosingPunctuationOnly(next.text);
        // A bracketed aside like "[Context. ... some cases, a brief overview
        // of the pattern. However, ... rather than within the patterns.]"
        // can span more than one apparent "paragraph gap" in this book's
        // pattern-template sidebars while still being a single unclosed
        // note - keep absorbing lines until the bracket actually closes.
        const openBracketPending = /^\s*\[/.test(text) && !text.includes(']');
        if (!danglingClosePunct && !openBracketPending) {
          if (next.pageBoundary) {
            if (!continuesAcrossBoundary(next, text)) break;
          } else {
            const gap = prevY - next.y;
            if (gap > expectedGap() * 1.3) {
              if (!isLooseLeadingWrap(mergedLines, j, gap, text, expectedGap(), localPitch, width)) break; // paragraph break
              if (localPitch == null) localPitch = gap;
            } else {
              bodyGaps.push(gap);
              const wrapped = mergedLines[j - 1];
              if (wrapped.endX != null) bodyWidths.push(wrapped.endX - wrapped.x);
            }
          }
        }
        if (danglingClosePunct) {
          html = html.replace(/\s+$/, '') + next.html.trim();
          text = text.replace(/\s+$/, '') + next.text.trim();
        } else if (next.stacked && used[used.length - 1].stacked) {
          // Two halves of one glyph-stacked caption split by a page turn:
          // stacks carry no reliable spaces, so join raw and let
          // repairStackedText below find the words.
          html += next.html;
          text += next.text;
        } else {
          const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
          if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
          html = joined.html; text = joined.text;
        }
        used.push(next);
        prevY = next.y;
        j++;
      }
      // A div-only vertical spacer between sections has no text at all;
      // it's an empty layout element, not a paragraph.
      if (text.trim() && used.some((l) => l.stacked)) {
        text = repairStackedText(text);
        html = escapeHtml(text);
        if (used.filter((l) => l.italicShare > 0.5).length > used.length / 2) html = `<em>${html}</em>`;
      }
      if (text.trim()) {
        // Layout facts for structureBlocks' post-pass (headings, terms,
        // definition bodies). Weighted by characters, like the per-line
        // shares they're built from.
        const chars = used.map((l) => l.text.replace(/\s/g, '').length);
        const total = chars.reduce((a, b) => a + b, 0) || 1;
        const avg = (key) => used.reduce((n, l, k) => n + (l[key] || 0) * chars[k], 0) / total;
        blocks.push({
          type: 'p', html: html.trim(),
          x: line.x, lineCount: used.length, fs: line.fs,
          boldShare: avg('boldShare'), italicShare: avg('italicShare'),
          width: line.endX != null ? line.endX - line.x : null,
        });
      }
      i = j;
    }
  }
  if (openBox != null) blocks.push({ type: 'aside-end' });
  return blocks;
}

// --- Step 4 (generic PDF path only): recover structure from block layout -
// Runs over the finished block list, where each paragraph knows its own
// indent, line count and bold/italic share. The pdf2htmlEX path never calls
// this, so its output is unaffected.
const CAPTION_RE = /^(Figure|Table|Example)\s+[A-Z]?\d+(?:[-.–]\d+)*\.?\s/;
const CALLOUT_RE = /^(TIP|NOTE|WARNING|CAUTION|IMPORTANT)$/;
const stripTags = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

function structureBlocks(blocks) {
  const out = [];
  const plain = (b) => (b && b.html != null ? stripTags(b.html) : '');
  const isTerm = (b) => b && b.type === 'p' && b.lineCount === 1 && plain(b).length <= 120 &&
    (b.italicShare >= 0.95 || b.boldShare >= 0.95);
  const isBody = (b, term) => b && b.type === 'p' && b.x != null && b.x > term.x + 8;
  const hasH3 = blocks.some((b) => b.type === 'h3');
  const subLevel = hasH3 ? 'h4' : 'h3';
  let inCallout = false;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const prevOut = out[out.length - 1];

    // A table continued over a page turn arrives as two back-to-back
    // tables: one with only its header (or its first rows), then the rest,
    // often repeating the header.
    if (b.type === 'table' && prevOut && prevOut.type === 'table') {
      const prevHeaderOnly = prevOut.rows.every((r) => r.header);
      const sameWidth = Math.abs(b.rows[0].cells.length - prevOut.rows[0].cells.length) <= 1;
      if (prevHeaderOnly || (sameWidth && !b.rows[0].header) || (sameWidth && b.rows[0].cells.join() === prevOut.rows[0].cells.join())) {
        const repeatsHeader = b.rows[0].header && b.rows[0].cells.join() === prevOut.rows[0].cells.join();
        prevOut.rows.push(...b.rows.slice(repeatsHeader ? 1 : 0));
        if (!prevOut.caption && b.caption) prevOut.caption = b.caption;
        continue;
      }
    }

    // Sidebar/callout: its first paragraph is the title - "TIP"/"NOTE"
    // labels make it a callout, any other bold line names a sidebar.
    if (b.type === 'aside-start') {
      const first = blocks[i + 1];
      const title = first && first.type === 'p' && first.lineCount <= 2 && first.boldShare >= 0.95 ? plain(first) : null;
      const callout = title && CALLOUT_RE.test(title) ? title.toLowerCase() : null;
      out.push({ type: 'aside-start', kind: callout ? `note ${callout}` : 'sidebar', title: title && first.html });
      inCallout = !!callout;
      if (title) i++;
      continue;
    }
    if (b.type === 'aside-end') inCallout = false;
    // Callout bodies are often set a size down, which the size-based
    // classifier reads as a quote attribution; inside a TIP/NOTE box it's
    // simply the note's text.
    if (inCallout && b.type === 'attribution') {
      out.push({ type: 'p', html: b.html });
      continue;
    }

    // Captions: this book's are body-size italic, so the size-based
    // 'figure-caption' role never sees them. A figure's caption follows
    // it; a table's precedes it.
    if (b.type === 'p' && CAPTION_RE.test(plain(b))) {
      const next = blocks[i + 1];
      if (/^Figure/.test(plain(b)) && prevOut && prevOut.type === 'figure' && !prevOut.caption) {
        prevOut.caption = b.html;
        continue;
      }
      if (/^Table/.test(plain(b)) && next && next.type === 'table' && !next.caption) {
        next.caption = b.html;
        continue;
      }
      out.push({ type: 'caption', html: b.html });
      continue;
    }

    // Definition list: an italic/bold one-line term followed by one or
    // more paragraphs indented past it ("SQL" / "The most common
    // interface ..."), repeated.
    if (isTerm(b) && isBody(blocks[i + 1], b)) {
      const items = [];
      let k = i;
      while (isTerm(blocks[k]) && isBody(blocks[k + 1], blocks[k])) {
        const term = blocks[k];
        const bodies = [];
        k++;
        while (isBody(blocks[k], term)) { bodies.push(blocks[k].html); k++; }
        items.push({ term: term.html, bodies });
      }
      out.push({ type: 'dl', items });
      i = k - 1;
      continue;
    }

    // Run-in subheading: a short, entirely bold, standalone line.
    if (b.type === 'p' && b.lineCount <= 2 && b.boldShare >= 0.95 && plain(b).length <= 100 &&
      !/[.,;]$/.test(plain(b)) && !CALLOUT_RE.test(plain(b))) {
      out.push({ type: subLevel, html: b.html });
      continue;
    }

    // One level further down, many books (O'Reilly's among them) use a
    // standalone italic line: "Discoverability" / "In a data-driven
    // company ...". (Indented bodies were taken as definitions above.)
    if (b.type === 'p' && b.lineCount === 1 && b.italicShare >= 0.95 && plain(b).length <= 80 &&
      !/[.,;:!?”"]$/.test(plain(b)) && blocks[i + 1] && blocks[i + 1].type === 'p') {
      out.push({ type: 'h5', html: b.html });
      continue;
    }

    // A chapter-size fragment of a few letters ("The" from a cover's
    // stacked title) is display type, not a chapter: it would otherwise
    // open a near-empty page and a one-word TOC entry.
    // Bare numbers and Roman numerals ("IV") are real chapter titles, though.
    if (b.type === 'h1' && plain(b).replace(/[^A-Za-z]/g, '').length <= 3 &&
      /[A-Za-z]/.test(plain(b)) && !/^[IVXLCDM]+\.?$/.test(plain(b))) {
      out.push({ type: 'p', html: b.html });
      continue;
    }

    out.push(b);
  }
  return out;
}

module.exports = { mergeVisualLines, classifyLine, buildBlocks, FS, configure, setCorpus, buildCorpus, structureBlocks };
