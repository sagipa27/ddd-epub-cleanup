const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const pageId = process.argv[2] || 'pf30';
const outPath = process.argv[3] || 'bg.png';

const page = $('#' + pageId);
const img = page.find('img.bi').first();
const src = img.attr('src');
if (!src) {
  console.log('No background image found for', pageId);
  process.exit(1);
}
const m = src.match(/^data:(image\/\w+);base64,(.+)$/s);
if (!m) {
  console.log('Could not parse data URI');
  process.exit(1);
}
const buf = Buffer.from(m[2], 'base64');
fs.writeFileSync(outPath, buf);
console.log('Wrote', outPath, buf.length, 'bytes, mime=', m[1]);
