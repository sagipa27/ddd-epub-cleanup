const fs = require('fs');
const html = fs.readFileSync('source/book.html', 'utf8');
const idx = html.indexOf('“');
console.log('Index of “ (U+201C) in raw file:', idx);
if (idx >= 0) {
  const buf = Buffer.from('“', 'utf8');
  console.log('Expected UTF-8 bytes for “:', [...buf].map(b => b.toString(16)));
  console.log('Context:', JSON.stringify(html.slice(idx - 30, idx + 30)));
}
console.log('Any literal "Ô" char in raw file text:', html.includes('Ô'));
console.log('Any literal "ÔÇ" in raw file text:', html.includes('ÔÇ'));

// write a small sample file with fs.writeFileSync (proper utf8) for comparison
fs.writeFileSync('sample_utf8_test.txt', 'Test: “smart quotes” — em dash – en dash • bullet\n', 'utf8');
