const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

console.log('=== Basic counts ===');
console.log('Total length (chars):', html.length);
console.log('Number of "pf" page divs:', $('div[id^="pf"]').length);
console.log('Number of img tags:', $('img').length);
console.log('Number of span tags:', $('span').length);
console.log('Number of div tags:', $('div').length);
console.log('Number of a tags:', $('a').length);

console.log('\n=== First 5 page ids ===');
$('div[id^="pf"]').slice(0, 5).each((i, el) => {
  console.log($(el).attr('id'), '-> class=', $(el).attr('class'), 'data-page-no=', $(el).attr('data-page-no'));
});

console.log('\n=== Last 5 page ids ===');
const pages = $('div[id^="pf"]');
for (let i = Math.max(0, pages.length - 5); i < pages.length; i++) {
  const el = pages[i];
  console.log($(el).attr('id'), '-> class=', $(el).attr('class'));
}

console.log('\n=== Sample of page 1 (title page) outer HTML length ===');
const pf1 = $('#pf1');
console.log('pf1 html length:', pf1.length ? pf1.html().length : 'NOT FOUND');

console.log('\n=== data-page-no distribution check ===');
console.log('Body direct children count:', $('body').children().length);
console.log('Body first-level child tags:', $('body').children().map((i, el) => el.tagName).get().slice(0, 10));
