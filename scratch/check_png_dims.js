const fs = require('fs');
const { PNG } = require('pngjs');
const buf = fs.readFileSync('bg_pf30.png');
const png = PNG.sync.read(buf);
console.log('PNG pixel dimensions:', png.width, 'x', png.height);
console.log('CSS w1/h0 expected ~891.75 x 1188');
console.log('Scale factor x:', png.width / 891.75, 'y:', png.height / 1188);
