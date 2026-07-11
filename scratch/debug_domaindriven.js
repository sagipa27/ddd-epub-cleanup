const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

$('div[id^="pf"]').each((pi, pageEl) => {
  $(pageEl).find('div.t').each((i, div) => {
    const text = $(div).text();
    if (/domain/i.test(text) && /priorities|driven design/i.test(text)) {
      console.log('found on page', $(pageEl).attr('id'), 'idx', i);
      console.log($.html(div));
      console.log('---');
    }
  });
});
