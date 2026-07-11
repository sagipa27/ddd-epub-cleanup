const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const styles = $('style').map((i, el) => $(el).html()).get();
const combined = styles.join('\n');

// Build a map of class -> css text for all single-letter-prefixed classes (x,y,h,w,fs)
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

const pf30 = $('#pf30');
const tdivs = pf30.find('div.t');
const rows = [];
tdivs.each((i, el) => {
  const cls = $(el).attr('class').split(/\s+/);
  let x = null, y = null, h = null, fs = null, ff = null, m0or1 = null;
  for (const c of cls) {
    if (/^x\d+$/.test(c) && x === null) x = getNumeric(c, ['left']);
    if (/^y[0-9a-f]+$/.test(c) && y === null) y = getNumeric(c, ['bottom']);
    if (/^h\d+$/.test(c) && h === null) h = getNumeric(c, ['height']);
    if (/^fs\d+$/.test(c) && fs === null) fs = getNumeric(c, ['font-size']);
    if (/^ff\d+$/.test(c)) ff = c;
    if (/^m\d+$/.test(c)) m0or1 = c;
  }
  rows.push({ i, x, y, h, fs, ff, m: m0or1, text: $(el).text().slice(0, 40) });
});

rows.sort((a, b) => b.y - a.y); // descending y = top to bottom reading order
let prevY = null;
rows.forEach(r => {
  const gap = prevY !== null ? (prevY - r.y).toFixed(2) : '-';
  console.log(`y=${r.y?.toFixed(2)} gap=${gap} x=${r.x?.toFixed(2)} h=${r.h} fs=${r.fs} ff=${r.ff} m=${r.m} | ${JSON.stringify(r.text)}`);
  prevY = r.y;
});
