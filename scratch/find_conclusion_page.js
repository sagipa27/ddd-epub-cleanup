'use strict';
const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('../lib/cssIndex');
const { extractPageLines } = require('../lib/pageExtract');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);
const pages = $('div[id^="pf"]').toArray();

for (const p of pages) {
  const txt = $(p).text();
  if (/Conclusion/.test(txt) && txt.length < 3000) {
    const id = $(p).attr('id');
    console.log('=== PAGE', id, '===');
    const lines = extractPageLines($, p, cssIndex);
    for (const l of lines) {
      console.log(`fs=${l.fs} x=${l.x} y=${l.y} :: ${JSON.stringify(l.text)}`);
    }
  }
}
