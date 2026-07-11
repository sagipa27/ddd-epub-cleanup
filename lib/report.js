'use strict';

function newReport() {
  return {
    generatedAt: new Date().toISOString(),
    pagesProcessed: [],
    headersRemoved: 0,
    headerSamples: [],
    hyphenRepairs: [],
    warnings: [],
    imagesExtracted: [],
    blocksByType: {},
    textLengthBefore: 0,
    textLengthAfter: 0,
  };
}

function tally(report, blocks) {
  for (const b of blocks) {
    report.blocksByType[b.type] = (report.blocksByType[b.type] || 0) + 1;
  }
}

module.exports = { newReport, tally };
