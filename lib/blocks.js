'use strict';

// Turns the flat list of merged visual lines for one page into semantic
// blocks (headings, paragraphs, code, lists, dialogue, captions, ...),
// repairing PDF line-wrap hyphenation and merging wrapped lines into
// paragraphs along the way. All thresholds are derived from font metrics
// that are shared/constant across the whole book (verified empirically),
// not guessed per page.

const FS = {
  H1: 82.558862,
  H2: 56.590578,
  H3: 45.272462,
  CAPTION: 31.734672,
  SMALL: 30.181642,
  CODE: 28.446197,
};
const EPS = 0.6;
const near = (a, b) => Math.abs(a - b) < EPS;

const CODE_X = 110.35; // consistent left-indent used for every code sample, book-wide

const HYPHEN_SAFE_PREFIXES = new Set([
  'self', 'well', 'non', 'co', 'pre', 'post', 'multi', 'cross', 're', 'de',
  'under', 'over', 'out', 'in', 'up', 'down', 'off', 'on', 'one', 'two',
  'first', 'second', 'third', 'top', 'bottom', 'left', 'right', 'open',
  'closed', 'built', 'hand', 'large', 'small', 'single', 'role', 'rule',
  'business', 'real', 'high', 'low', 'long', 'short', 'object', 'model',
  'domain', 'data', 'type', 'sub', 'super', 'meta', 'inter', 'intra',
  'anti', 'semi', 'mid', 'back', 'side', 'time', 'life', 'world', 'end',
]);

// --- Step 1: merge divs that share the same visual line (same y) ---------
function mergeVisualLines(rawLines) {
  const groups = new Map();
  for (const l of rawLines) {
    const key = l.y.toFixed(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const merged = [];
  for (const [, frags] of groups) {
    // Sort left-to-right; an unresolved x (missing class) must never be
    // coerced to 0 by bare subtraction, or it would jump to the front of
    // the line ahead of everything else.
    frags.sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity));
    const text = frags.map((f) => f.text).join('');
    const html = frags.map((f) => f.html).join('');
    // Dominant style = the fragment contributing the most characters, so a
    // short inline emphasis run doesn't hijack the whole line's role.
    const dominant = frags.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const firstFrag = frags[0];
    const boldColonPrefix = /^\s*[A-Z][\w .'()-]{0,38}?:\s/.test(text) && firstFrag.bold;
    merged.push({
      x: frags[0].x,
      y: frags[0].y,
      fs: dominant.fs,
      italic: dominant.italic,
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
  const t = line.text.trim();
  if (near(line.fs, FS.H1)) return 'h1';
  if (near(line.fs, FS.H2)) return 'h2';
  if (near(line.fs, FS.H3)) return 'h3';
  if (near(line.fs, FS.CODE) || (Math.abs(line.x - CODE_X) < 1 && looksLikeCode(t))) return 'code';
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

function joinWrappedText(prevHtml, prevText, nextHtml, nextText, warnings) {
  if (endsWithHardHyphen(prevText)) {
    if (/^[a-z]/.test(nextText.trimStart())) {
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

function continuesAcrossBoundary(next, prevText) {
  const prevEndsOpen = !/[.!?:;"'”)\]]\s*$/.test(prevText.trimEnd()) || endsWithHardHyphen(prevText);
  const nextTrimmed = next.text.trimStart();
  // A lowercase start is the usual continuation signal, but this book also
  // renders its own glossary terms (ENTITY, VALUE OBJECT, MODULE, ...) in
  // full caps, so a wrap that resumes mid-term looks like "...VALUE" /
  // "OBJECT." - still a continuation, just capitalized differently.
  const nextLooksLikeContinuation = /^[a-z]/.test(nextTrimmed) || /^[A-Z]{2,}\b/.test(nextTrimmed);
  return prevEndsOpen && nextLooksLikeContinuation;
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

// List items can wrap onto a second (unmarked) visual line just like body
// text does. A genuine same-item wrap reads as a lowercase-continuing
// sentence fragment - the same signal used for cross-page paragraph
// continuation - which is a safer test here than a vertical-gap threshold,
// since list items are often spaced further apart than a single line of
// their own wrapped text (risking swallowing whatever prose follows the
// list entirely).
function collectListItems(mergedLines, startIndex, role, markerRe, report) {
  const items = [];
  let html = mergedLines[startIndex].html.replace(markerRe, '');
  let text = mergedLines[startIndex].text.replace(markerRe, '');
  let j = startIndex + 1;
  while (j < mergedLines.length) {
    const next = mergedLines[j];
    const nextRole = classifyLine(next);
    if (nextRole === role) {
      items.push(html);
      html = next.html.replace(markerRe, '');
      text = next.text.replace(markerRe, '');
      j++;
      continue;
    }
    const isProseContinuation = nextRole === 'paragraph' || nextRole === 'attribution' || nextRole === 'small';
    if (!isProseContinuation || next.pageBoundary || !continuesAcrossBoundary(next, text)) break;
    const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
    if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
    html = joined.html; text = joined.text;
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
      if (gaps.length < 3) return 20; // sane default before we have data
      const sorted = [...gaps].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
  }
  const expectedGap = makeExpectedGap(bodyGaps);
  const expectedCaptionGap = makeExpectedGap(captionGaps);

  while (i < mergedLines.length) {
    const line = mergedLines[i];

    if (line.isFigure) {
      blocks.push({ type: 'figure', src: line.src, alt: line.alt });
      i++;
      continue;
    }

    const role = classifyLine(line);

    if (role === 'h1' || role === 'h2' || role === 'h3') {
      blocks.push({ type: role, html: line.html.trim() });
      i++;
      continue;
    }

    if (role === 'figure-caption' || role === 'attribution') {
      // Captions/side-notes wrap across multiple caption-sized visual lines
      // just like body paragraphs do, including line-wrap hyphenation, but
      // a large vertical gap still marks a real break between two distinct
      // notes (e.g. separate mini-examples in one sidebar).
      let html = line.html;
      let text = line.text;
      let prevY = line.y;
      let j = i + 1;
      while (j < mergedLines.length && classifyLine(mergedLines[j]) === role) {
        const next = mergedLines[j];
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
      blocks.push({ type: role, html: html.trim() });
      i = j;
      continue;
    }

    if (role === 'table-heading' || role === 'small') {
      // Group the whole contiguous run of small/table-ish lines together;
      // exact column relationships aren't recoverable from this text alone,
      // so we preserve it verbatim and flag it for manual review.
      const group = [line];
      let j = i + 1;
      while (j < mergedLines.length && ['table-heading', 'small'].includes(classifyLine(mergedLines[j]))) {
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
      while (j < mergedLines.length && classifyLine(mergedLines[j]) === 'code') {
        group.push(mergedLines[j]);
        j++;
      }
      // Blank filler rows between table/code blocks (an empty positioned
      // element with no text) are page-layout artifacts, not content.
      if (group.some((l) => l.text.trim())) {
        blocks.push({ type: 'code', lines: group.map((l) => l.text) });
      }
      i = j;
      continue;
    }

    if (role === 'bullet' || role === 'numbered') {
      const markerRe = role === 'bullet' ? /^\s*[•\u2022]\s+/ : /^\s*\d+\.\s+/;
      const { items, nextIndex } = collectListItems(mergedLines, i, role, markerRe, report);
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
        if (nextRole !== 'paragraph') break;
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
      let j = i + 1;
      while (j < mergedLines.length) {
        const next = mergedLines[j];
        const nextRole = classifyLine(next);
        if (nextRole !== 'paragraph') break;
        if (next.pageBoundary) {
          if (!continuesAcrossBoundary(next, text)) break;
        } else {
          const gap = prevY - next.y;
          if (gap > expectedGap() * 1.3) break; // paragraph break
          bodyGaps.push(gap);
        }
        const joined = joinWrappedText(html, text, next.html, next.text, report.warnings);
        if (joined.repaired) report.hyphenRepairs.push(joined.repaired);
        html = joined.html; text = joined.text;
        prevY = next.y;
          j++;
        }
        // A div-only vertical spacer between sections has no text at all;
        // it's an empty layout element, not a paragraph.
        if (text.trim()) blocks.push({ type: 'p', html: html.trim() });
        i = j;
      }
  }
  return blocks;
}

module.exports = { mergeVisualLines, classifyLine, buildBlocks, FS };
