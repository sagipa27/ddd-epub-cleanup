const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });
const styleText = $('style').map((i, el) => $(el).html()).get().join('\n');

['_', '_0', '_1', '_a'].forEach((cls) => {
  const re = new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'g');
  let m;
  const defs = [];
  while ((m = re.exec(styleText))) defs.push(m[1]);
  console.log(cls, '->', defs);
});
