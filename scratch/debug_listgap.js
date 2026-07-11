const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('../lib/cssIndex');
const html = fs.readFileSync('../source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);

const page = $('#pf2d');
page.find('div.t').each((i, div) => {
  const cm = cssIndex.resolveLineMetrics($(div).attr('class'));
  const text = $(div).text();
  if (i >= 23 && i <= 31) console.log(i, 'y=', cm.y, JSON.stringify(text.slice(0, 60)));
});
