const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const styles = $('style').map((i, el) => $(el).html()).get();
const combined = styles.join('\n');

const re = /\.m(\d+)\{transform:matrix\(([^)]+)\)/g;
let m;
const results = [];
while ((m = re.exec(combined))) {
  const nums = m[2].split(',').map(parseFloat);
  results.push({ cls: 'm' + m[1], c: nums[2] }); // matrix(a,b,c,d,e,f) - c is skew term
}
console.log('Total m classes:', results.length);
const italic = results.filter(r => Math.abs(r.c) > 0.001);
const normal = results.filter(r => Math.abs(r.c) <= 0.001);
console.log('Italic (skewed) m classes:', italic.length);
console.log('Normal m classes:', normal.length);
console.log('Sample italic classes:', italic.slice(0, 5));
console.log('Sample normal classes:', normal.slice(0, 5));
// unique skew values
const skewSet = new Set(italic.map(r => r.c.toFixed(4)));
console.log('Distinct skew values used:', [...skewSet]);

// Also check sc classes book-wide
const scRe = /\.sc(\d+)\{/g;
const scSet = new Set();
while ((m = scRe.exec(combined))) scSet.add('sc' + m[1]);
console.log('\nAll sc classes found:', [...scSet]);
