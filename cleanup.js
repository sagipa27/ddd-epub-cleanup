#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { buildCssIndex } = require('./lib/cssIndex');
const { extractPageLines, stripHeaderFooter, detectHeaderY } = require('./lib/pageExtract');
const { mergeVisualLines, buildBlocks } = require('./lib/blocks');
const { renderBlocks, wrapXhtml } = require('./lib/render');
const { extractFigures, spliceFigures } = require('./lib/figures');
const { newReport, tally } = require('./lib/report');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { mode: 'dry-run', input: 'source/book.html', output: 'cleaned-html', reportDir: 'reports', scope: 'all' };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'write') args.mode = 'write';
    else if (k === 'dry-run') args.mode = 'dry-run';
    else if (k === 'preview') args.mode = 'preview';
    else args[k] = v;
  }
  return args;
}

// Chapter table: physical page-index ranges (0-based, inclusive) within the
// document's page order, precomputed by inspecting the book's own heading
// text (see PHASE1_REPORT.md). Kept here so --scope=chapter:N is repeatable.
const CHAPTERS = [
  { n: 1, title: 'Chapter One. Crunching Knowledge', startId: 'pf2' },
  { n: 2, title: 'Chapter Two. Communication and the Use of Language', startId: 'pfc' },
  { n: 3, title: 'Chapter Three. Binding Model and Implementation', startId: 'pf19' },
  { n: 4, title: 'Chapter Four. Isolating the Domain', startId: 'pf24' },
  { n: 5, title: 'Chapter Five. A Model Expressed in Software', startId: 'pf2c' },
  { n: 6, title: 'Chapter Six. The Life Cycle of a Domain Object', startId: 'pf46' },
  { n: 7, title: 'Chapter Seven. Using the Language', startId: 'pf60' },
  { n: 8, title: 'Chapter Eight. Breakthrough', startId: 'pf73' },
  { n: 9, title: 'Chapter Nine. Making Implicit Concepts Explicit', startId: 'pf7b' },
  { n: 10, title: 'Chapter Ten. Supple Design', startId: 'pf93' },
  { n: 11, title: 'Chapter Eleven. Applying Analysis Patterns', startId: 'pfb5' },
  { n: 12, title: 'Chapter Twelve. Relating Design Patterns to the Model', startId: 'pfbf' },
  { n: 13, title: 'Chapter Thirteen. Refactoring Toward Deeper Insight', startId: 'pfc9' },
  { n: 14, title: 'Chapter Fourteen. Maintaining Model Integrity', startId: 'pfcd' },
  { n: 15, title: 'Chapter Fifteen. Distillation', startId: 'pff7' },
  { n: 16, title: 'Chapter Sixteen. Large-Scale Structure', startId: 'pf110' },
  { n: 17, title: 'Chapter Seventeen. Bringing the Strategy Together', startId: 'pf12d' },
];

function resolveScope(order, scope) {
  if (scope === 'all') return { start: 0, end: order.length - 1 };
  const chapterMatch = /^chapter:(\d+)$/.exec(scope);
  if (chapterMatch) {
    const n = parseInt(chapterMatch[1], 10);
    const chapter = CHAPTERS.find((c) => c.n === n);
    if (!chapter || !chapter.startId) throw new Error(`Unknown/unresolved chapter ${n}`);
    const next = CHAPTERS.find((c) => c.n === n + 1 && c.startId);
    const start = order.indexOf(chapter.startId);
    const end = next ? order.indexOf(next.startId) - 1 : order.length - 1;
    return { start, end, title: chapter.title };
  }
  const pagesMatch = /^pages:(\d+)-(\d+)$/.exec(scope);
  if (pagesMatch) return { start: parseInt(pagesMatch[1], 10), end: parseInt(pagesMatch[2], 10) };
  throw new Error(`Unrecognized --scope=${scope}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = newReport();

  console.log(`[cleanup] reading ${args.input} ...`);
  const html = fs.readFileSync(args.input, 'utf8');
  const $ = cheerio.load(html, { xmlMode: false });
  const cssIndex = buildCssIndex($);
  const pageEls = $('div[id^="pf"]').toArray();
  const order = pageEls.map((el) => $(el).attr('id'));

  const { start, end, title } = resolveScope(order, args.scope);
  console.log(`[cleanup] scope=${args.scope} -> pages[${start}..${end}] of ${order.length} (${end - start + 1} pages)`);

  // Header y is a book-wide constant; detecting it from just this scope's
  // pages is enough (verified identical across the whole book).
  const topLines = [];
  for (let i = start; i <= end; i++) {
    const lines = extractPageLines($, pageEls[i], cssIndex);
    if (lines.length) {
      const top = lines.reduce((a, b) => (b.y > a.y ? b : a));
      topLines.push(top);
    }
  }
  const headerY = detectHeaderY(topLines);
  console.log(`[cleanup] detected running-header y = ${headerY}`);

  const imagesOutDir = path.join(args.output, 'images');
  const chapterLines = [];
  let textLengthBefore = 0;

  for (let i = start; i <= end; i++) {
    const pageEl = pageEls[i];
    const pageId = order[i];
    const rawLines = extractPageLines($, pageEl, cssIndex);
    textLengthBefore += rawLines.reduce((sum, l) => sum + l.text.length, 0);

    const { kept, removed } = stripHeaderFooter(rawLines, headerY);
    report.headersRemoved += removed.length;
    removed.forEach((r) => report.headerSamples.length < 25 && report.headerSamples.push({ page: pageId, text: r.text }));

    const merged = mergeVisualLines(kept);
    const figures = extractFigures($, pageEl, cssIndex.pageHeight, imagesOutDir, pageId, report);
    const spliced = spliceFigures(merged, figures);

    if (chapterLines.length && spliced.length) spliced[0].pageBoundary = true;
    chapterLines.push(...spliced);
    report.pagesProcessed.push(pageId);
  }

  report.textLengthBefore = textLengthBefore;

  const blocks = buildBlocks(chapterLines, report);
  tally(report, blocks);
  const bodyHtml = renderBlocks(blocks);
  const textLengthAfter = bodyHtml.replace(/<[^>]+>/g, '').length;
  report.textLengthAfter = textLengthAfter;

  const scopeSlug = args.scope.replace(/[^a-z0-9]+/gi, '-');
  const outFile = path.join(args.output, `${scopeSlug}.xhtml`);
  const fullDoc = wrapXhtml(title || 'Chapter', bodyHtml, 'styles/epub.css');

  if (args.mode === 'write') {
    fs.mkdirSync(args.output, { recursive: true });
    fs.mkdirSync(path.join(args.output, 'styles'), { recursive: true });
    fs.copyFileSync('styles/epub.css', path.join(args.output, 'styles', 'epub.css'));
    fs.writeFileSync(outFile, fullDoc, 'utf8');
    console.log(`[cleanup] wrote ${outFile}`);
  } else if (args.mode === 'preview') {
    console.log(bodyHtml);
  } else {
    console.log('[cleanup] dry-run: not writing output. Preview (first 2000 chars):');
    console.log(bodyHtml.slice(0, 2000));
  }

  fs.mkdirSync(args.reportDir, { recursive: true });
  fs.writeFileSync(path.join(args.reportDir, 'cleanup-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[cleanup] report written to ${args.reportDir}/cleanup-report.json`);
  console.log(`[cleanup] pages=${report.pagesProcessed.length} headersRemoved=${report.headersRemoved} hyphenRepairs=${report.hyphenRepairs.length} imagesExtracted=${report.imagesExtracted.length} warnings=${report.warnings.length}`);
  console.log(`[cleanup] textLengthBefore=${textLengthBefore} textLengthAfter=${textLengthAfter} delta=${textLengthAfter - textLengthBefore}`);
}

main();
