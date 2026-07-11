const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const ids = $('div[id^="pf"]').map((i, el) => $(el).attr('id')).get();
console.log('Total matched:', ids.length);
const unique = new Set(ids);
console.log('Unique ids:', unique.size);

// count occurrences
const counts = {};
ids.forEach(id => counts[id] = (counts[id] || 0) + 1);
const dups = Object.entries(counts).filter(([k, v]) => v > 1);
console.log('Duplicate ids count:', dups.length);
console.log('First 10 duplicates:', dups.slice(0, 10));

// Are there non pfN pattern ids?
const nonStandard = ids.filter(id => !/^pf\d+$/.test(id));
console.log('Non-standard pf ids:', nonStandard.slice(0, 20));

// numeric range
const nums = ids.filter(id => /^pf\d+$/.test(id)).map(id => parseInt(id.slice(2), 10));
console.log('Min page num:', Math.min(...nums), 'Max page num:', Math.max(...nums));

// body structure
console.log('\n=== Body children ===');
$('body').children().each((i, el) => {
  console.log(i, el.tagName, 'id=', $(el).attr('id'), 'class=', $(el).attr('class'));
});
