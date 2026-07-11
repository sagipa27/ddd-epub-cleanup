#!/usr/bin/env node
// One-off: compute extra before/after metrics for chapter 5 that
// cleanup-report.json doesn't carry directly (raw visual-line count,
// paragraph-merge count, page-number count within the removed headers).
'use strict';

const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('../lib/cssIndex');
const { extractPageLines, stripHeaderFooter, detectHeaderY } = require('../lib/pageExtract');
const { mergeVisualLines, buildBlocks } = require('../lib/blocks');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);
const pageEls = $('div[id^="pf"]').toArray();
const order = pageEls.map((el) => $(el).attr('id'));

const start = order.indexOf('pf2c');
const end = order.indexOf('pf46') - 1;

let rawVisualLines = 0;
let strippedHeaderFooterCount = 0;
let pageNumberOnlyCount = 0;
const chapterLines = [];
const topLines = [];
for (let i = start; i <= end; i++) {
  const lines = extractPageLines($, pageEls[i], cssIndex);
  if (lines.length) topLines.push(lines.reduce((a, b) => (b.y > a.y ? b : a)));
}
const headerY = detectHeaderY(topLines);

for (let i = start; i <= end; i++) {
  const rawLines = extractPageLines($, pageEls[i], cssIndex);
  rawVisualLines += rawLines.length;
  const { kept, removed } = stripHeaderFooter(rawLines, headerY);
  strippedHeaderFooterCount += removed.length;
  removed.forEach((r) => {
    if (/^\d+$/.test(r.text.trim())) pageNumberOnlyCount++;
  });
  const merged = mergeVisualLines(kept);
  if (chapterLines.length && merged.length) merged[0].pageBoundary = true;
  chapterLines.push(...merged);
}

const mergedVisualLineCount = chapterLines.length;

const report = { pagesProcessed: [], headersRemoved: 0, headerSamples: [], hyphenRepairs: [], warnings: [], imagesExtracted: [], blocksByType: {} };
const blocks = buildBlocks(chapterLines, report);

let proseLinesFeedingParagraphs = 0;
for (const l of chapterLines) {
  if (!l.isFigure) proseLinesFeedingParagraphs++;
}

const pCount = blocks.filter((b) => b.type === 'p').length;
const listItemCount = blocks.reduce((sum, b) => sum + (b.items ? b.items.length : 0), 0);
const headingCount = blocks.filter((b) => /^h[1-3]$/.test(b.type)).length;
const codeLineBlocks = blocks.filter((b) => b.type === 'code').length;
const figureCount = blocks.filter((b) => b.type === 'figure').length;
const tableCount = blocks.filter((b) => b.type === 'table-like').length;
const attributionCount = blocks.filter((b) => b.type === 'attribution' || b.type === 'figure-caption').length;

console.log(JSON.stringify({
  rawVisualLines,
  mergedVisualLineCount,
  strippedHeaderFooterCount,
  pageNumberOnlyCount,
  runningHeaderTextCount: strippedHeaderFooterCount - pageNumberOnlyCount,
  proseLinesFeedingParagraphs,
  finalBlockCount: blocks.length,
  pCount,
  listItemCount,
  headingCount,
  codeLineBlocks,
  figureCount,
  tableCount,
  attributionCount,
  // "lines collapsed into paragraphs" = prose-classified visual lines minus
  // the paragraph/list-item/attribution blocks they ended up inside.
  linesCollapsedIntoParagraphs: proseLinesFeedingParagraphs - (pCount + listItemCount + attributionCount) - headingCount - codeLineBlocks,
}, null, 2));
