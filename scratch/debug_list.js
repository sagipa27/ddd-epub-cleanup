const fs = require('fs');
const cheerio = require('cheerio');
const { buildCssIndex } = require('./lib/cssIndex');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const cssIndex = buildCssIndex($);

$('div[id^="pf"]').each((pi, pageEl) => {
  $(pageEl).find('div.t').each((i, div) => {
    const text = $(div).text();
    if (/Imposing a traversal/i.test(text)) {
      console.log('found on page', $(pageEl).attr('id'));
      const classAttr = $(div).attr('class');
      const metrics = cssIndex.resolveLineMetrics(classAttr);
      console.log(i, 'y=', metrics.y, 'x=', metrics.x, 'fs=', metrics.fs, JSON.stringify(text.slice(0, 90)));
      console.log('raw html:', $.html(div).slice(0, 400));
      // print neighbors
      const divs = $(pageEl).find('div.t');
      for (let k = Math.max(0, i - 2); k <= Math.min(divs.length - 1, i + 2); k++) {
        const d = divs.get(k);
        const cm = cssIndex.resolveLineMetrics($(d).attr('class'));
        console.log('  neighbor', k, 'y=', cm.y, 'x=', cm.x, JSON.stringify($(d).text().slice(0, 60)));
      }
    }
  });
});
