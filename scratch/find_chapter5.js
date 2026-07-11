const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const pages = $('div[id^="pf"]').toArray();
const order = pages.map(el => $(el).attr('id'));

const titles = [
  'Chapter Five. A Model Expressed in Software',
  'Chapter Six. The Life Cycle of a Domain',
  'Chapter Four. Isolating the Domain',
];

titles.forEach(title => {
  const words = title.split(' ').slice(0, 3).join(' ');
  for (const el of pages) {
    const $page = $(el);
    const text = $page.text();
    if (text.includes(words)) {
      console.log(title, '-> found on', $page.attr('id'), 'at order index', order.indexOf($page.attr('id')));
      break;
    }
  }
});
