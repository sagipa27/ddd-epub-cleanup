const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
console.log('span.m1 count:', $('span.m1').length);
console.log('span.m0 count:', $('span.m0').length);
console.log('div.m1 count:', $('div.m1').length);
console.log('span.sc1 count:', $('span.sc1').length);
console.log('div.sc1.t count:', $('div.sc1.t').length);
console.log('span classes sample (non _):');
let n = 0;
$('span').each((i, el) => {
  const c = $(el).attr('class');
  if (c && !c.startsWith('_') && n < 15) {
    console.log(c, JSON.stringify($(el).text().slice(0, 30)));
    n++;
  }
});
