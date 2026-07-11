const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('source/book.html', 'utf8');
const $ = cheerio.load(html, { xmlMode: false });

const pageArg = process.argv[2]; // can be decimal data-page-no or hex id like pf1a
const outFile = process.argv[3] || 'page_dump.html';

let target = null;
if (pageArg.startsWith('pf')) {
  target = $('#' + pageArg);
} else {
  target = $(`div[data-page-no="${pageArg}"]`);
}

if (!target.length) {
  console.log('Page not found for', pageArg);
  process.exit(1);
}

console.log('Found page, id=', target.attr('id'), 'data-page-no=', target.attr('data-page-no'));
fs.writeFileSync(outFile, $.html(target));
console.log('Written to', outFile, 'length=', $.html(target).length);

// Print text-only spans summary
const spans = target.find('span');
console.log('Number of spans on this page:', spans.length);
console.log('First 20 span texts with classes:');
spans.slice(0, 20).each((i, el) => {
  console.log(JSON.stringify($(el).text()), '| class=', $(el).attr('class'));
});
