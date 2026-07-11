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

const pages = $('div[id^="pf"]').toArray();
console.log('Total pages:', pages.length);

// Style combo survey: (ff,fs) -> count, sample texts
const styleCombo = {};
// per-page: first and last line text + y range, to find headers/footers
const pageEdgeLines = [];

pages.forEach((pageEl, pageIdx) => {
  const $page = $(pageEl);
  const pageId = $page.attr('id');
  const dataPageNo = $page.attr('data-page-no');
  const tdivs = $page.find('div.t').toArray();
  const rows = tdivs.map(el => {
    const cls = $(el).attr('class').split(/\s+/);
    let x=null,y=null,fs=null,ff=null,mm=null;
    for (const c of cls) {
      if (/^x\d+$/.test(c) && x===null) x=getNumeric(c,['left']);
      if (/^y[0-9a-f]+$/.test(c) && y===null) y=getNumeric(c,['bottom']);
      if (/^fs\d+$/.test(c) && fs===null) fs=getNumeric(c,['font-size']);
      if (/^ff\d+$/.test(c)) ff=c;
      if (/^m\d+$/.test(c)) mm=c;
    }
    const text = $(el).text();
    const key = `${ff}|${fs}|${mm}`;
    if (!styleCombo[key]) styleCombo[key] = { count: 0, samples: [] };
    styleCombo[key].count++;
    if (styleCombo[key].samples.length < 4) styleCombo[key].samples.push(text.slice(0,80));
    return {x,y,fs,ff,m:mm,text};
  });
  rows.sort((a,b)=>b.y-a.y);
  if (rows.length) {
    pageEdgeLines.push({
      pageId, dataPageNo,
      top: rows[0],
      bottom: rows[rows.length-1],
    });
  }
});

console.log('\n=== Style combos (ff|fs|m) sorted by fs desc ===');
const combos = Object.entries(styleCombo).map(([k,v])=>{
  const [ff,fs,mm]=k.split('|');
  return {ff,fs:parseFloat(fs),m:mm,count:v.count,samples:v.samples};
});
combos.sort((a,b)=>b.fs-a.fs);
combos.forEach(c=>{
  console.log(`ff=${c.ff} fs=${c.fs} m=${c.m} count=${c.count}`);
  c.samples.forEach(s=>console.log('    ', JSON.stringify(s)));
});

console.log('\n=== First 15 pages: top line text ===');
pageEdgeLines.slice(0,15).forEach(p=>console.log(p.pageId, p.dataPageNo, '| TOP:', JSON.stringify(p.top.text.slice(0,60)), '| BOTTOM:', JSON.stringify(p.bottom.text.slice(0,60))));

console.log('\n=== Pages 100-115: top/bottom line text ===');
pageEdgeLines.slice(100,115).forEach(p=>console.log(p.pageId, p.dataPageNo, '| TOP:', JSON.stringify(p.top.text.slice(0,60)), '| BOTTOM:', JSON.stringify(p.bottom.text.slice(0,60))));

fs.writeFileSync('style_combos.json', JSON.stringify(combos, null, 2));
fs.writeFileSync('page_edges.json', JSON.stringify(pageEdgeLines, null, 2));
