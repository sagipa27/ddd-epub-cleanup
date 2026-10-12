'use strict';

// Turns one pdf2htmlEX page <div id="pfN"> into an ordered list of logical
// "lines" (each corresponding to one visual line div.t, or one recovered
// figure) plus bookkeeping data used later for header/footer stripping and
// paragraph reconstruction.

const HEADER_Y_TOLERANCE = 1.0;

function isSpacerSpan($, el) {
  const cls = $(el).attr('class') || '';
  return /(^|\s)_(\s|$)/.test(cls);
}

// Renders the inline content of one div.t into an HTML fragment (escaping
// text and wrapping bold runs in <strong>), plus a parallel plain-text
// version used for all the classification heuristics.
function renderInline($, div, cssIndex) {
  const defaultBold = cssIndex.boldSc.has(getScClass($, div));
  let html = '';
  let text = '';

  function escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function walk(node, boldOverride) {
    if (node.type === 'text') {
      const t = node.data;
      text += t;
      // Never wrap whitespace-only runs in <strong>/<em>; a bold space is
      // meaningless and just produces noisy, fragmented markup.
      const wrap = boldOverride && /\S/.test(t);
      html += wrap ? `<strong>${escape(t)}</strong>` : escape(t);
      return;
    }
    if (node.type === 'tag' && node.name === 'span') {
      if (isSpacerSpan($, node)) {
        // pdf2htmlEX marks every kerning/justification adjustment as an
        // invisible "_" span (color:transparent). Some of these are purely
        // decorative margin nudges with no text node at all; others (used
        // as the sole source of an inter-word gap, e.g. right after "1.")
        // do contain a literal space character. Rendering whatever text
        // node is actually there - and nothing else - handles both
        // correctly without ever inventing or duplicating a space.
        $(node).contents().each((_, child) => {
          if (child.type !== 'text') return;
          let d = child.data;
          // Some lines already put a trailing space on the preceding word
          // AND carry a literal space inside the spacer span; collapse the
          // resulting run so we never emit two spaces for one word gap.
          if (/^\s+$/.test(d) && /\s$/.test(text)) return;
          text += d; html += escape(d);
        });
        return;
      }
      const scClass = getScClass($, node);
      const bold = scClass ? cssIndex.boldSc.has(scClass) : boldOverride;
      ($(node).contents().get() || []).forEach((child) => walk(child, bold));
      return;
    }
    // Any other unexpected inline element: just take its text.
    const t = $(node).text();
    text += t;
    html += escape(t);
  }

  $(div).contents().each((i, node) => walk(node, defaultBold));
  return { html, text };
}

function getScClass($, el) {
  const cls = ($(el).attr('class') || '').split(/\s+/);
  return cls.find((c) => /^sc\d+$/.test(c)) || null;
}

function extractPageLines($, pageEl, cssIndex) {
  const lines = [];
  $(pageEl).find('div.t').each((i, div) => {
    const classAttr = $(div).attr('class');
    const metrics = cssIndex.resolveLineMetrics(classAttr);
    const { html, text } = renderInline($, div, cssIndex);
    if (text.trim() === '' && html === '') return; // fully empty layout artifact
    lines.push({
      kind: 'text',
      x: metrics.x, y: metrics.y, h: metrics.h, fs: metrics.fs, ff: metrics.ff,
      italic: metrics.italic, bold: metrics.bold,
      html, text,
      domIndex: i,
    });
  });
  return lines;
}

// The running header (chapter title and/or page number) sits at one fixed,
// shared CSS y-position on every single page in the book, but is emitted
// *last* in the source (pdf2htmlEX writes page-template content after the
// main content stream). We detect it purely by that fixed y rather than by
// its position in the DOM, which makes the check robust regardless of
// ordering. Callers pass in the book-wide header y measured once up front.
function stripHeaderFooter(lines, headerY) {
  const kept = [];
  const removed = [];
  for (const line of lines) {
    const isHeaderBand = headerY != null && Math.abs(line.y - headerY) <= HEADER_Y_TOLERANCE;
    const looksLikePageFurniture = isHeaderBand && /\d\s*$/.test(line.text.trim());
    if (looksLikePageFurniture) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }
  return { kept, removed };
}

function detectHeaderY(lines) {
  // Pick the y-value shared by the largest number of "topmost per page"
  // lines; callers typically invoke this once across a sample of pages.
  const freq = new Map();
  for (const l of lines) {
    const key = l.y.toFixed(2);
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [k, c] of freq) {
    if (c > bestCount) { bestCount = c; best = k; }
  }
  return best != null ? parseFloat(best) : null;
}

// Generic-PDF page furniture: running headers/footers and page numbers,
// wherever the book puts them. stripHeaderFooter above only knows one
// header height and needs a trailing page number, so it misses footers
// ("8 | Chapter 1: Reliable, ..."), headers that lead with the number
// ("4 | THE STAFF ENGINEER'S PATH") and left/right pages set differently -
// all of which then leak into the text, even as fake headings. A page's
// topmost or bottommost line is furniture when it is no larger than body
// text, carries a page number at its start or end (arabic or roman), and
// either is nothing but that number, joins it with a "|" separator, or has
// text that repeats on other pages - and lines like it sit at that same
// height on at least 3 pages. Footnotes starting with a number fail the
// separator/repetition test and vary in height, so they're kept.
const PAGE_NO = '(?:\\d{1,4}|[ivxlcdm]{1,7})';
const LEADING_NO_RE = new RegExp(`^${PAGE_NO}(?:\\s*\\|\\s*|\\s+)(.*)$`, 'i');
const TRAILING_NO_RE = new RegExp(`^(.*?)(?:\\s*\\|\\s*|\\s+)${PAGE_NO}$`, 'i');
const BARE_NO_RE = new RegExp(`^${PAGE_NO}$`, 'i');

function stripPageFurniture(linesPerPage, bodySize, eps) {
  const candidates = [];
  linesPerPage.forEach((lines, pageIdx) => {
    const text = lines.filter((l) => !l.isFigure && l.text && l.text.trim());
    if (!text.length) return;
    const byY = [...text].sort((a, b) => b.y - a.y);
    const edges = new Set([byY[0], byY[byY.length - 1]]);
    for (const l of edges) {
      const t = l.text.trim();
      if (l.fs > bodySize + eps || t.length > 100) continue;
      const bare = BARE_NO_RE.test(t);
      const m = t.match(LEADING_NO_RE) || t.match(TRAILING_NO_RE);
      if (!bare && !m) continue;
      const rest = bare ? '' : m[1].trim();
      candidates.push({
        line: l, pageIdx, y: Math.round(l.y), bare, piped: /\|/.test(t),
        key: rest.toLowerCase().replace(/\d+/g, '#'),
      });
    }
  });
  const pagesAtY = new Map();
  const pagesWithKey = new Map();
  for (const c of candidates) {
    for (const y of [c.y - 1, c.y, c.y + 1]) {
      if (!pagesAtY.has(y)) pagesAtY.set(y, new Set());
      pagesAtY.get(y).add(c.pageIdx);
    }
    if (c.key) {
      if (!pagesWithKey.has(c.key)) pagesWithKey.set(c.key, new Set());
      pagesWithKey.get(c.key).add(c.pageIdx);
    }
  }
  const removed = linesPerPage.map(() => []);
  for (const c of candidates) {
    const recursAtY = pagesAtY.get(c.y).size >= 3;
    const looksLikeFurniture = c.bare || c.piped || (c.key && pagesWithKey.get(c.key).size >= 3);
    if (recursAtY && looksLikeFurniture) removed[c.pageIdx].push(c.line);
  }
  const kept = linesPerPage.map((lines, i) => lines.filter((l) => !removed[i].includes(l)));
  return { kept, removed };
}

module.exports = { extractPageLines, stripHeaderFooter, detectHeaderY, stripPageFurniture };
