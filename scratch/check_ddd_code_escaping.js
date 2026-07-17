'use strict';
const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('cleaned-html/all.xhtml', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
let found = 0;
$('pre code').each((i, el) => {
  const raw = $(el).html() || '';
  if (/&lt;|&gt;/.test(raw)) return; // already escaped, fine
  if (/<[a-zA-Z]/.test(raw)) {
    found++;
    console.log('--- suspect code block', i, '---');
    console.log(raw.slice(0, 200));
  }
});
console.log('total suspect blocks:', found);
