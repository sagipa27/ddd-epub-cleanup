const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const pages = $('div[id^="pf"]').toArray();
const order = pages.map((el) => $(el).attr('id'));
pages.forEach((el) => {
  const $page = $(el);
  const id = $page.attr('id');
  const text = $page.text();
  const m = text.match(/Chapter\s+[A-Za-z]+\.\s*[A-Z][a-zA-Z ]{0,40}/);
  if (m) {
    console.log(id, '(idx', order.indexOf(id), ', tdivs=', $page.find('div.t').length, ') ->', JSON.stringify(m[0]));
  }
});
