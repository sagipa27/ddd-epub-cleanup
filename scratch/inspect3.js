const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const styles = $('style').map((i, el) => $(el).html()).get();
const combined = styles.join('\n');
console.log(combined.match(/\.h0\{[^}]*\}/g));
console.log(combined.match(/\.y1\{[^}]*\}/g));
console.log(combined.match(/\.y3\{[^}]*\}/g));
console.log(combined.match(/\.y3c1\{[^}]*\}/g));
console.log(combined.match(/\.y3d2\{[^}]*\}/g));
console.log(combined.match(/\.y16\{[^}]*\}/g));

const pf30 = $('#pf30');
const tdivs = pf30.find('div.t');
console.log('Number of t divs:', tdivs.length);
tdivs.each((i, el) => {
  const cls = $(el).attr('class');
  const text = $(el).text();
  console.log(i, '|', cls, '|', JSON.stringify(text.slice(0, 50)));
});
