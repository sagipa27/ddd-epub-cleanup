const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const styles = $('style').map((i, el) => $(el).html()).get();
console.log('Number of style blocks:', styles.length);
styles.forEach((s, i) => console.log(`Style block ${i} length:`, s.length));

// Combine all styles except font-face (too big) for class inspection
const combined = styles.join('\n');

// helper to find a class def
function findClass(name) {
  const re = new RegExp('\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*\\}', 'g');
  return combined.match(re);
}

['sc0','sc1','sc2','ff11','ff12','fc0','fc1','fs1','fs2','fs3','fs4','fs5','m0','m1','m2', 'x10','x3','x80', 'y16', 'h3','h5','h7', 'w0','w1','w2', '_', 'bi', 'pi', 'c ', '\\bt\\b'].forEach(cls => {
  console.log('---', cls, '---');
  console.log(findClass(cls));
});

// Look at .c and .t base class defs (not positional variants)
console.log('\n=== .c{...} and .t{...} base ===');
console.log(combined.match(/\.c\{[^}]*\}/g));
console.log(combined.match(/\.t\{[^}]*\}/g));
console.log(combined.match(/\._\{[^}]*\}/g));
console.log(combined.match(/\.pf\{[^}]*\}/g));
console.log(combined.match(/\.pc\{[^}]*\}/g));
console.log(combined.match(/\.bi\{[^}]*\}/g));
console.log(combined.match(/\.pi\{[^}]*\}/g));
