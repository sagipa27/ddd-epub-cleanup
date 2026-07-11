const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('./lib/cssIndex');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);

const page = $('#pf2c');
page.find('div.t').each((i, div) => {
  const classAttr = $(div).attr('class');
  const metrics = cssIndex.resolveLineMetrics(classAttr);
  const text = $(div).text();
  if (/compromise|MODEL|reframing|DRIVEN/i.test(text)) {
    console.log(i, 'y=', metrics.y, 'x=', metrics.x, 'fs=', metrics.fs, JSON.stringify(text.slice(0, 60)));
  }
});
