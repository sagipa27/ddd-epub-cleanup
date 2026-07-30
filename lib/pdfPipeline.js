'use strict';

// Orchestrates the generic "any PDF" path: ingest -> calibrate -> strip
// headers/footers -> detect chapters -> merge/build/render. Reuses every
// book-agnostic piece of the original pdf2htmlEX pipeline unchanged
// (mergeVisualLines, buildBlocks, renderBlocks, wrapXhtml, spliceFigures,
// stripHeaderFooter, detectHeaderY) and only swaps out the ingestion layer
// and the font-size thresholds that used to be hand-measured for one book.

const path = require('path');
const { ingestPdf } = require('./pdfIngest');
const { buildStyleProfile, estimateLineGap } = require('./calibrate');
const { stripHeaderFooter, detectHeaderY } = require('./pageExtract');
const blocks = require('./blocks');
const { mergeVisualLines, buildBlocks, classifyLine } = blocks;
const { renderBlocks, wrapXhtml } = require('./render');
const { spliceFigures } = require('./figures');
const { tally } = require('./report');
const { suggestRunTogetherSplit } = require('./wordSegment');

// Some PDFs (typically tightly-kerned/justified professional typesetting)
// encode inter-word gaps as pure positioning with no space character at
// all, in a size range pdf.js's own text-extraction heuristics don't
// reliably catch (its gap-to-space threshold intentionally errs towards
// *not* adding spaces, to avoid splitting normal letter-kerning). The
// item-boundary gap-fix in lib/blocks.js's joinFragments() catches this
// whenever it produces separate items, but if pdf.js still glues everything
// into one text item with no space at all, there's nothing left to detect
// a boundary between - the words are truly indistinguishable from a single
// run of letters at that point. Rather than guess where to split such a
// run, this only flags it (with a dictionary-derived *suggestion*, never
// applied automatically) for a human to check, per the same
// "report ambiguous cases, don't guess" rule as the hyphen-repair logic.
//
// A first cut of this flagged every long word verbatim, which is far too
// noisy to be useful on a real technical book: long real words
// ("understandability") and, especially, camelCase code identifiers from
// example listings ("calculateRevenueRecognitions") both look exactly like
// a run of glued-together words by length alone. suggestRunTogetherSplit()
// filters both of those out and only fires when the run *fully* decomposes
// into 2+ real dictionary words with no leftover, which is a much stronger
// signal of an actual extraction problem.
const RUN_TOGETHER_RE = /[A-Za-z]{16,}/g;
function flagRunTogetherWords(bodyHtml, report) {
  const text = bodyHtml.replace(/<[^>]+>/g, ' ');
  const seen = new Set();
  let m;
  while ((m = RUN_TOGETHER_RE.exec(text))) {
    const token = m[0];
    if (seen.has(token)) continue;
    seen.add(token);
    const suggestion = suggestRunTogetherSplit(token);
    if (suggestion && report.warnings.length < 500) {
      report.warnings.push({ type: 'possible-run-together-words', text: token, suggestion });
    }
  }
}

function resolvePdfScope(chapterStarts, numPages, scope) {
  if (scope === 'all') return { start: 0, end: numPages - 1 };
  const chapterMatch = /^chapter:(\d+)$/.exec(scope);
  if (chapterMatch) {
    const n = parseInt(chapterMatch[1], 10);
    if (n < 1 || n > chapterStarts.length) {
      throw new Error(`--scope=chapter:${n} out of range (${chapterStarts.length} chapters detected)`);
    }
    const start = chapterStarts[n - 1].page;
    const end = n < chapterStarts.length ? chapterStarts[n].page - 1 : numPages - 1;
    return { start, end, title: chapterStarts[n - 1].title };
  }
  const pagesMatch = /^pages:(\d+)-(\d+)$/.exec(scope);
  if (pagesMatch) return { start: parseInt(pagesMatch[1], 10), end: parseInt(pagesMatch[2], 10) };
  throw new Error(`Unrecognized --scope=${scope}`);
}

async function runPdfPipeline(args, report) {
  console.log(`[cleanup] reading PDF ${args.pdf} ...`);
  const imagesOutDir = path.join(args.output, 'images');
  const { metadata, pages, numPages } = await ingestPdf(args.pdf, imagesOutDir, report.warnings);
  console.log(`[cleanup] ingested ${numPages} pages from PDF`);

  // 1) Header/footer band: same fixed-relative-y detection as the HTML
  // path, just fed from every page's topmost line instead of one page div's
  // CSS-resolved metrics.
  const topLines = [];
  for (const pg of pages) {
    if (pg.lines.length) topLines.push(pg.lines.reduce((a, b) => (b.y > a.y ? b : a)));
  }
  const headerY = detectHeaderY(topLines);
  console.log(`[cleanup] detected running-header y = ${headerY}`);

  // 2) Coalesce same-y fragments into whole visual lines *before* stripping
  // headers/footers: unlike pdf2htmlEX (whose div.t is already one whole
  // line), pdf.js hands back one item per content-stream text-show
  // operator, so a running header like "Chapter One    12" typically
  // arrives as several separate fragments ("Chapter One", " ", "12") at the
  // same y. stripHeaderFooter's page-furniture check needs the whole line's
  // text (it looks for a trailing page number), so merging first is
  // required for it to work at all.
  // (Removed-header bookkeeping is deferred until the scope is resolved
  // below, so the report only reflects the pages actually being output -
  // this whole-document pass exists purely to find chapter boundaries.)
  const keptPerPage = [];
  const removedPerPage = [];
  for (const pg of pages) {
    const wholeLines = mergeVisualLines(pg.lines);
    const { kept, removed } = stripHeaderFooter(wholeLines, headerY);
    keptPerPage.push(kept);
    removedPerPage.push(removed);
  }

  // 3) Calibrate this document's own font-size thresholds and switch
  // lib/blocks.js over to them (the pdf2htmlEX/HTML path never calls
  // configure(), so its behavior is unaffected).
  const allKept = keptPerPage.flat();
  const profile = buildStyleProfile(allKept);
  const lineGap = estimateLineGap(keptPerPage, profile.BODY, profile.EPS);
  blocks.configure({ FS: profile, EPS: profile.EPS, LINE_GAP: lineGap });
  console.log(`[cleanup] calibrated style profile: ${JSON.stringify(profile)}, lineGap=${lineGap}`);

  // 4) Chapter detection: any line classified 'h1' (now judged against the
  // calibrated thresholds) marks a chapter start; record the first one per
  // page in case a title wraps onto a second line at the same size.
  const chapterStarts = [];
  keptPerPage.forEach((kept, pageIdx) => {
    for (const line of kept) {
      if (classifyLine(line) === 'h1') {
        chapterStarts.push({ page: pageIdx, title: line.text.trim() });
        break;
      }
    }
  });
  console.log(`[cleanup] detected ${chapterStarts.length} chapter heading(s)`);

  // 5) Resolve --scope against the page-index space (0-based, contiguous -
  // no per-document id table needed, unlike the pdf2htmlEX path's CHAPTERS).
  const { start, end, title } = resolvePdfScope(chapterStarts, numPages, args.scope);
  console.log(`[cleanup] scope=${args.scope} -> pages[${start}..${end}] of ${numPages}`);

  // 6) Splice in figures (lines are already merged - see step 2), mark page
  // turns, and now that the scope is known, fold in this range's
  // header-strip bookkeeping and before/after text length.
  const chapterLines = [];
  let textLengthBefore = 0;
  for (let i = start; i <= end; i++) {
    const spliced = spliceFigures(keptPerPage[i], pages[i].figures);
    if (chapterLines.length && spliced.length) spliced[0].pageBoundary = true;
    chapterLines.push(...spliced);
    report.pagesProcessed.push(pages[i].pageNo);
    pages[i].figures.forEach((fig) => report.imagesExtracted.push({ page: pages[i].pageNo, file: path.basename(fig.src) }));

    const removed = removedPerPage[i];
    report.headersRemoved += removed.length;
    removed.forEach((r) => report.headerSamples.length < 25 && report.headerSamples.push({ page: pages[i].pageNo, text: r.text }));
    textLengthBefore += pages[i].lines.reduce((sum, l) => sum + l.text.length, 0);
  }
  report.textLengthBefore = textLengthBefore;

  const builtBlocks = buildBlocks(chapterLines, report);
  tally(report, builtBlocks);
  const bodyHtml = renderBlocks(builtBlocks);
  flagRunTogetherWords(bodyHtml, report);

  return {
    bodyHtml,
    title: title || metadata.title || 'Book',
    metadata,
    chapterStarts,
    textLengthBefore,
  };
}

module.exports = { runPdfPipeline };
