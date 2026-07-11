const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const styles = $('style').map((i, el) => $(el).html()).get();
const combined = styles.join('\n');

const classDefRe = /\.([a-zA-Z]+[0-9a-zA-Z]*)\{([^}]*)\}/g;
const classMap = {};
let m;
while ((m = classDefRe.exec(combined))) {
  const [_, name, body] = m;
  if (!classMap[name]) classMap[name] = [];
  classMap[name].push(body);
}
function getNumeric(cls, propNames) {
  const defs = classMap[cls];
  if (!defs) return null;
  for (const body of defs) {
    for (const prop of propNames) {
      const re = new RegExp(prop + ':([\\-0-9.]+)px');
      const mm = body.match(re);
      if (mm) return parseFloat(mm[1]);
    }
  }
  return null;
}

const buckets = { '28.446197': [], '22.756958': [] };
$('div.t').each((i, el) => {
  const cls = $(el).attr('class').split(/\s+/);
  let x = null, fsv = null;
  for (const c of cls) {
    if (/^x\d+$/.test(c) && x === null) x = getNumeric(c, ['left']);
    if (/^fs\d+$/.test(c) && fsv === null) fsv = getNumeric(c, ['font-size']);
  }
  const key = fsv !== null ? fsv.toFixed(6) : null;
  if (key && buckets[key]) {
    buckets[key].push({ x: x !== null ? x.toFixed(2) : null, text: $(el).text().slice(0, 40) });
  }
});

for (const key of Object.keys(buckets)) {
  console.log(`=== fs=${key} (n=${buckets[key].length}) ===`);
  const xFreq = new Map();
  buckets[key].forEach(r => xFreq.set(r.x, (xFreq.get(r.x) || 0) + 1));
  [...xFreq.entries()].sort((a, b) => b[1] - a[1]).forEach(([x, c]) => console.log('  x=', x, 'count=', c));
  console.log('  samples:');
  buckets[key].slice(0, 6).forEach(r => console.log('   ', r.x, JSON.stringify(r.text)));
  buckets[key].slice(-6).forEach(r => console.log('   (end)', r.x, JSON.stringify(r.text)));
}
