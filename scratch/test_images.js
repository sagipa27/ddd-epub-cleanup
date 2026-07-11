const fs = require('fs');
const { decodePng, findContentRowClusters, cropPng } = require('./lib/images');

const buf = fs.readFileSync('bg_pf30.png');
const png = decodePng(buf);
console.log('Image size:', png.width, png.height);
const boxes = findContentRowClusters(png);
console.log('Found', boxes.length, 'content cluster(s):');
boxes.forEach((b, i) => {
  console.log(i, b, 'css px (÷1.333):', {
    x0: (b.x0 / 1.3333).toFixed(1), y0: (b.y0 / 1.3333).toFixed(1),
    x1: (b.x1 / 1.3333).toFixed(1), y1: (b.y1 / 1.3333).toFixed(1),
  });
  const { buffer } = cropPng(png, b, 10);
  fs.writeFileSync(`crop_test_${i}.png`, buffer);
});
