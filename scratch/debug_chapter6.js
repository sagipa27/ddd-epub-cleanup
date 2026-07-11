const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('./lib/cssIndex');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);

$('div[id^="pf"]').each((pi, pageEl) => {
  $(pageEl).find('div.t').each((i, div) => {
    const text = $(div).text();
    if (/I will discuss some supporting/i.test(text) || /Chapter 6/.test(text)) {
      const cm = cssIndex.resolveLineMetrics($(div).attr('class'));
      console.log($(pageEl).attr('id'), i, 'y=', cm.y, 'x=', cm.x, JSON.stringify($.html(div)));
    }
  });
});
