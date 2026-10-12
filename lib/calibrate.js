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

// buildStyleProfile's "the three largest sizes are H1-H3" breaks on most
// trade PDFs: the largest sizes in a book are usually one-offs - the cover,
// the title page, a publisher's ad - so real chapter titles and section
// headings fall below the cut and are never recognized at all (the EPUB then
// has no table of contents and no chapter breaks). Heading levels are
// better told apart by how they behave:
//  - a heading size recurs across the book (3+ pages) and is short text;
//  - chapter titles open a page, so the chapter size is the recurring size
//    that most often sits at the top of its page;
//  - a larger recurring size that also opens pages is a part title;
//  - section levels are the next recurring sizes below the chapter size;
//  - "CHAPTER 1" / "| 1" / "PART I" labels have their own size and are
//    merged into the title that follows them (see mergeChapterLabels).
// Returns null when no chapter-like size is found; callers then keep the
// plain size-ranked profile.
const LABEL_RE = /^(?:(chapter|part|section|book)\s*\|?\s*)?\|?\s*([0-9]{1,3}|[ivxlcdm]{1,6}|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i;
const CHAPTER_WORD_RE = /^(chapter|part)\s*\|?\s*\S+$/i;
const isLabelText = (t) => LABEL_RE.test(t) || CHAPTER_WORD_RE.test(t);

function refineHeadingLevels(keptPerPage, profile) {
  const bucket = (fs) => Math.round(fs * 4) / 4;
  const stats = new Map();
  keptPerPage.forEach((lines, pageIdx) => {
    const text = lines.filter((l) => !l.isFigure && !l.isTable && l.text && l.text.trim());
    const byY = [...text].sort((a, b) => b.y - a.y);
    const topSet = new Set(byY.slice(0, 4));
    for (const l of text) {
      if (l.fs <= profile.BODY + profile.EPS) continue;
      const k = bucket(l.fs);
      if (!stats.has(k)) stats.set(k, { size: k, lines: 0, chars: 0, labels: 0, pages: new Set(), topPages: new Set() });
      const s = stats.get(k);
      s.lines++;
      s.chars += l.text.trim().length;
      if (isLabelText(l.text.trim())) s.labels++;
      s.pages.add(pageIdx);
      if (topSet.has(l)) s.topPages.add(pageIdx);
    }
  });
  const all = [...stats.values()].map((s) => ({
    ...s, pageCount: s.pages.size, topShare: s.topPages.size / s.pages.size,
    avgLen: s.chars / s.lines, labelShare: s.labels / s.lines,
  }));
  const labelSizes = all.filter((s) => s.pageCount >= 3 && s.labelShare >= 0.6).map((s) => s.size);
  const recurring = all.filter((s) => s.pageCount >= 3 && s.avgLen >= 3 && s.labelShare < 0.6);
  const chapterish = recurring.filter((s) => s.topShare >= 0.6);
  if (!chapterish.length) return null;
  const chapter = [...chapterish].sort((a, b) => b.pageCount - a.pageCount || b.size - a.size)[0];
  const part = chapterish.filter((s) => s.size > chapter.size).sort((a, b) => b.size - a.size)[0] || null;
  // Section sizes must be used at least a quarter as often as chapters are,
  // so a handful of stray display lines can't claim a heading level.
  // ...and, among the sizes below the chapter level, one used on a small
  // fraction of the pages the most common one is (a rare display size,
  // say 3 pages against 126) is not a heading level either.
  const minPages = Math.max(3, Math.floor(chapter.pageCount / 4));
  const below = recurring.filter((s) => s.size < chapter.size - profile.EPS && s.pageCount >= minPages);
  const busiest = Math.max(0, ...below.map((s) => s.pageCount));
  const sections = below.filter((s) => s.pageCount >= busiest * 0.15).sort((a, b) => b.size - a.size);
  const UNUSED = -1000; // matches no real line
  return {
    profile: {
      ...profile,
      PART: part ? part.size : UNUSED,
      H1: chapter.size,
      H2: sections[0] ? sections[0].size : UNUSED,
      H3: sections[1] ? sections[1].size : UNUSED,
    },
    labelSizes,
  };
}

// A chapter label printed on its own line above the title ("CHAPTER 1" /
// "Reliable, Scalable, and ...") is part of the title: fold it in as
// "Chapter 1. Reliable, Scalable, and ...", so the TOC entry and heading
// read as one. Only labels at a recognized label size are folded, into the
// chapter- or part-size line printed just below them on the same page -
// matched by position, since some PDFs store the label *after* the title
// in reading order even though it's printed above it.
function mergeChapterLabels(keptPerPage, profile, labelSizes, eps) {
  const near = (a, b) => Math.abs(a - b) <= eps;
  let merged = 0;
  for (const lines of keptPerPage) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.isFigure || l.isTable || !l.text || !labelSizes.some((s) => near(s, l.fs))) continue;
      const t = l.text.trim();
      if (!isLabelText(t)) continue;
      const next = lines
        .filter((n) => n !== l && !n.isFigure && !n.isTable && n.text && n.text.trim() &&
          (near(n.fs, profile.H1) || near(n.fs, profile.PART)) && n.y < l.y && l.y - n.y <= 8 * l.fs)
        .sort((a, b) => b.y - a.y)[0];
      if (!next) continue;
      const clean = t.replace(/\s*\|\s*/g, ' ').trim();
      // "CHAPTER 1" -> "Chapter 1.", "PART | I" -> "Part I.", "| 1" -> "1."
      const label = `${clean.replace(/^([a-z])([a-z]*)(?=\s)/i, (m, a, b) => a.toUpperCase() + b.toLowerCase())}.`;
      next.text = `${label} ${next.text.trimStart()}`;
      next.html = `${label} ${next.html.trimStart()}`;
      lines.splice(i, 1);
      i--;
      merged++;
    }
  }
  return merged;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { buildStyleProfile, estimateLineGap, refineHeadingLevels, mergeChapterLabels };
