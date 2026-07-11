#!/usr/bin/env node
// One-off: reproduces the "words joined together" bug reported against a
// real book PDF - a PDF whose content stream draws each word as its own
// separately-positioned text-show operator with no literal space character
// anywhere, relying purely on horizontal positioning for the visual gap
// (this is exactly what pdf-lib does if you call drawText once per word at
// a manually advanced x, instead of once for a whole string).
'use strict';

const fs = require('fs');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function main() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);

  const words = ["I'd", 'been', 'doing', 'this', 'kind', 'of', 'thing', 'for', 'ages', 'with', 'C++,', 'Smalltalk,', 'and', 'CORBA.'];
  const size = 11;
  let x = 50;
  const y = 150;
  for (const w of words) {
    page.drawText(w, { x, y, size, font: helv });
    x += helv.widthOfTextAtSize(w, size) + helv.widthOfTextAtSize(' ', size);
  }

  const bytes = await doc.save();
  fs.writeFileSync('scratch/gap-test.pdf', bytes);
  console.log('wrote scratch/gap-test.pdf');
}

main();
