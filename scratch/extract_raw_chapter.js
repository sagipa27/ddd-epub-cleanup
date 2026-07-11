#!/usr/bin/env node
// One-off: dump the *raw* pdf2htmlEX markup for a chapter's page range,
// pretty-printed (one element per line) so it's diffable against the
// cleaned XHTML output. Read-only against source/book.html.
'use strict';

const fs = require('fs');
const cheerio = require('cheerio');

function main() {
  const scopeArg = process.argv[2] || 'chapter:5';
  const outPath = process.argv[3] || 'scratch/chapter5-raw.html';

  const html = fs.readFileSync('source/book.html', 'utf8');
  const $ = cheerio.load(html, { xmlMode: false });
  const pageEls = $('div[id^="pf"]').toArray();
  const order = pageEls.map((el) => $(el).attr('id'));

  // Same chapter table as cleanup.js (duplicated here to keep this a
  // throwaway script rather than a shared module).
  const chapters = [
    { n: 5, startId: 'pf2c' },
    { n: 6, startId: 'pf46' },
  ];
  const m = /^chapter:(\d+)$/.exec(scopeArg);
  const n = parseInt(m[1], 10);
  const start = order.indexOf(chapters.find((c) => c.n === n).startId);
  const next = chapters.find((c) => c.n === n + 1);
  const end = next ? order.indexOf(next.startId) - 1 : order.length - 1;

  console.log(`pages[${start}..${end}] ids=${order[start]}..${order[end]}`);

  let out = '';
  for (let i = start; i <= end; i++) {
    let raw = $.html(pageEls[i]);
    // Pretty-print: newline after every closing '>' so the diff is line-based.
    raw = raw.replace(/></g, '>\n<');
    out += raw + '\n';
  }
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`wrote ${outPath} (${out.length} chars, ${out.split('\n').length} lines)`);
}

main();
