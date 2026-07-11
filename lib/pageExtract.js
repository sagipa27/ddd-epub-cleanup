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

module.exports = { extractPageLines, stripHeaderFooter, detectHeaderY };
