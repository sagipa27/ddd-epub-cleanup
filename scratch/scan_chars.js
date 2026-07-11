const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const freq = new Map();
$('div.t').each((i, el) => {
  const text = $(el).text();
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 127) {
      freq.set(ch, (freq.get(ch) || 0) + 1);
    }
  }
});

const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log('Distinct non-ASCII chars:', sorted.length);
sorted.forEach(([ch, count]) => {
  console.log(`U+${ch.codePointAt(0).toString(16).padStart(4, '0')} (${JSON.stringify(ch)}) count=${count}`);
});

// Check: does "Ô" ever appear NOT followed by "Ç"?
const fullText = $('div.t').map((i, el) => $(el).text()).get().join('\n');
const badOccurrences = [];
let idx = 0;
while ((idx = fullText.indexOf('Ô', idx)) !== -1) {
  const next = fullText[idx + 1];
  if (next !== 'Ç') {
    badOccurrences.push(fullText.slice(Math.max(0, idx - 20), idx + 20));
  }
  idx++;
}
console.log('\nOccurrences of Ô NOT followed by Ç:', badOccurrences.length);
badOccurrences.slice(0, 10).forEach(s => console.log(JSON.stringify(s)));

// Collect all distinct 3-char windows starting with ÔÇ
const windows = new Map();
idx = 0;
while ((idx = fullText.indexOf('ÔÇ', idx)) !== -1) {
  const w = fullText.slice(idx, idx + 3);
  windows.set(w, (windows.get(w) || 0) + 1);
  idx += 2;
}
console.log('\nDistinct ÔÇx windows:');
[...windows.entries()].sort((a,b)=>b[1]-a[1]).forEach(([w,c]) => console.log(JSON.stringify(w), [...w].map(ch=>'U+'+ch.codePointAt(0).toString(16)), c));
