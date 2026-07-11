const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

let found = null;
$('div[id^="pf"]').each((i, el) => {
  const text = $(el).text();
  if (text.includes('Table: BROKERAGE_ACCOUNT')) {
    found = $(el).attr('id');
  }
});
console.log('Found table page:', found);

if (found) {
  const page = $('#' + found);
  const tdivs = page.find('div.t').toArray();
  console.log('t-div count:', tdivs.length);
  tdivs.forEach((el, i) => {
    const cls = $(el).attr('class');
    const text = $(el).text();
    console.log(i, '|', cls, '|', JSON.stringify(text));
  });
}
