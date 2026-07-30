'use strict';

// Derives per-document font-size thresholds (body/H1/H2/H3/caption/small)
// from the actual distribution of font sizes in the extracted text, instead
// of the fixed pixel values in lib/blocks.js's default FS table (which were
// measured by hand for one specific book's pdf2htmlEX export). Any PDF's
// own body-text size becomes the new baseline, and heading/caption sizes
// are picked relative to it.
function buildStyleProfile(rawLines) {
  const sizeCounts = new Map(); // rounded font size -> total character count
  for (const l of rawLines) {
    if (l.isFigure || !l.text) continue;
    const key = Math.round(l.fs * 4) / 4; // quarter-point buckets
    sizeCounts.set(key, (sizeCounts.get(key) || 0) + l.text.length);
  }

  if (!sizeCounts.size) {
    // No text at all (shouldn't happen for a real document) - fall back to
    // some plausible defaults rather than dividing by nothing.
    return { BODY: 12, H1: 24, H2: 18, H3: 14.5, CAPTION: 10, SMALL: 9.5, EPS: 0.6 };
  }

  const byCount = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const bodySize = byCount[0][0]; // most-used size, by character volume, = body prose

  const distinctDesc = [...sizeCounts.keys()].sort((a, b) => b - a);
  const larger = distinctDesc.filter((s) => s > bodySize + 0.5);
  const smaller = distinctDesc.filter((s) => s < bodySize - 0.5);

  const H1 = larger[0] ?? round1(bodySize * 1.8);
  const H2 = larger[1] ?? (larger[0] ? round1((larger[0] + bodySize) / 2) : round1(bodySize * 1.4));
  const H3 = larger[2] ?? round1(bodySize * 1.15);
  const CAPTION = smaller[0] ?? round1(bodySize * 0.85);
  const SMALL = smaller[1] ?? round1(bodySize * 0.8);

  // Tolerance for "is this line's size close enough to bucket X" - scales
  // with the document's own font sizes rather than a fixed pixel constant,
  // since a PDF's internal units vary in scale from book to book.
  const EPS = Math.max(0.5, bodySize * 0.03);

  return { BODY: bodySize, H1, H2, H3, CAPTION, SMALL, EPS };
}

// The paragraph-merger in lib/blocks.js needs a "does this vertical gap
// look like a same-paragraph line wrap, or a real paragraph break" call,
// and bootstraps that purely from gaps it measures as it goes (see
// makeExpectedGap there) - but it only starts measuring *after* a gap has
// already passed the check, so a bad initial guess before any real samples
// exist can wrongly reject every single line, permanently starving itself
// of the data it needs to correct that guess. The old hardcoded "20" was
// hand-measured for one book's pica-based units; a modern trade book set
// with more generous leading (e.g. 15pt body / 26.25pt line pitch) blows
// straight through it and never recovers. Estimating the *document's own*
// typical body-text line pitch up front - the same "measure this book,
// don't guess" approach buildStyleProfile already uses for font sizes -
// gives the merger a sane starting point on every book, not just the one
// this was tuned on.
function estimateLineGap(keptPerPage, bodySize, eps) {
  const gaps = [];
  for (const page of keptPerPage) {
    for (let i = 1; i < page.length; i++) {
      const prev = page[i - 1];
      const cur = page[i];
      if (Math.abs(prev.fs - bodySize) > eps || Math.abs(cur.fs - bodySize) > eps) continue;
      const gap = prev.y - cur.y;
      // Excludes non-adjacent-line gaps (paragraph breaks, section gaps,
      // stray same-size captions elsewhere) so those don't drag the
      // estimate away from the true single-line pitch: real paragraph
      // breaks are reliably >1.3x the single-line pitch (that's the exact
      // ratio the merger itself later tests against), so anything only
      // modestly larger than the smallest common gap is still one line.
      if (gap > 0 && gap < bodySize * 3) gaps.push(gap);
    }
  }
  if (gaps.length < 5) return null; // too little data to trust - caller keeps its own default
  const sorted = gaps.sort((a, b) => a - b);
  // The *smallest* common gap, not the median, is what we want: paragraph
  // breaks are also "common" in most books (every paragraph has exactly
  // one), so the median can land on the break gap instead of the in-
  // paragraph one whenever paragraphs run short - the single-line pitch is
  // always the smaller of the two clusters, so anchoring near the low end
  // of the distribution (10th percentile) reliably lands on it instead.
  return sorted[Math.floor(sorted.length * 0.1)];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { buildStyleProfile, estimateLineGap };
