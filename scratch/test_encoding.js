const iconv = require('iconv-lite');

const samples = ['ÔÇ£', 'ÔÇØ', 'ÔÇÖ', 'ÔÇÿ', 'ÔÇö', 'ÔÇô', 'ÔÇó', 'ÔÇé'];
const encodings = ['win1252', 'macintosh', 'iso88591', 'iso885915', 'cp437', 'cp850'];

for (const s of samples) {
  console.log('=== Input:', JSON.stringify(s), 'codepoints:', [...s].map(c => c.codePointAt(0).toString(16)));
  for (const enc of encodings) {
    try {
      const bytes = iconv.encode(s, enc);
      const decoded = iconv.decode(bytes, 'utf8');
      console.log(`  ${enc}: bytes=[${[...bytes].map(b=>b.toString(16)).join(' ')}] -> utf8-decoded=${JSON.stringify(decoded)}`);
    } catch (e) {
      console.log(`  ${enc}: ERROR ${e.message}`);
    }
  }
}
