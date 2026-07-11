const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const pages = $('div[id^="pf"]').toArray();
const chapterStarts = [];
pages.forEach((el) => {
  const $page = $(el);
  const id = $page.attr('id');
  const text = $page.text();
  const m = text.match(/Chapter\s+\w+\.\s*/);
  if (m && $page.find('div.t').length < 15) {
    // Likely a chapter title page (few lines, mostly heading)
    chapterStarts.push({ id, snippet: text.slice(0, 80).replace(/\s+/g, ' ') });
  }
});
console.log('Candidate chapter start pages:');
chapterStarts.forEach(c => console.log(c.id, '|', c.snippet));

// Index of each page in doc order
const order = pages.map(el => $(el).attr('id'));
fs.writeFileSync('page_order.json', JSON.stringify(order, null, 2));
console.log('\nTotal page order length:', order.length);
console.log('Index of pf30 in order:', order.indexOf('pf30'));
