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

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { buildStyleProfile };
