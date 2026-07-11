const fs = require('fs');
const edges = JSON.parse(fs.readFileSync('page_edges.json', 'utf8'));

const yFreq = new Map();
edges.forEach(p => {
  const y = p.top.y.toFixed(2);
  yFreq.set(y, (yFreq.get(y) || 0) + 1);
});
console.log('Distinct top-line y values (should cluster around header y):');
[...yFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([y, c]) => console.log(y, c));

// Show pages where top.y is NOT in the dominant cluster
const dominant = [...yFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log('\nDominant header y =', dominant);
const outliers = edges.filter(p => p.top.y.toFixed(2) !== dominant);
console.log('Pages where top line is NOT at header y:', outliers.length);
outliers.slice(0, 20).forEach(p => console.log(p.pageId, p.dataPageNo, JSON.stringify(p.top.text.slice(0, 60)), 'y=', p.top.y.toFixed(2)));

// For dominant-cluster pages, examine text pattern: does it end in digits?
const headerPages = edges.filter(p => p.top.y.toFixed(2) === dominant);
let endsWithDigits = 0, notEndsWithDigits = [];
headerPages.forEach(p => {
  if (/\d+$/.test(p.top.text.trim())) endsWithDigits++;
  else notEndsWithDigits.push(p);
});
console.log('\nHeader-cluster pages ending with digits:', endsWithDigits, '/', headerPages.length);
console.log('Not ending with digits (sample):');
notEndsWithDigits.slice(0, 10).forEach(p => console.log(p.pageId, JSON.stringify(p.top.text)));
