'use strict';
const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('../lib/cssIndex');
const { extractPageLines } = require('../lib/pageExtract');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);
const pages = $('div[id^="pf"]').toArray();
console.log('total pages matched:', pages.length);
console.log('first 15 ids:', pages.slice(0, 15).map((p) => $(p).attr('id')));

for (let i = 0; i < 15; i++) {
  const id = $(pages[i]).attr('id');
  const lines = extractPageLines($, pages[i], cssIndex);
  const text = lines.map((l) => l.text).join(' | ');
  console.log(`--- ${id} (${lines.length} lines) ---`);
  console.log(text.slice(0, 300));
}
