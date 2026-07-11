const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const page = $('#pf2c');
const divs = page.find('div.t');
[1, 2, 3, 4].forEach((i) => {
  const div = divs.get(i);
  console.log(i, '=>', $.html(div).slice(0, 300));
  console.log('---');
});
