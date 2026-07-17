#!/usr/bin/env node
// One-off: synthesize a small multi-page PDF with realistic structure
// (headings, wrapped/hyphenated paragraphs, a list, a code block, a running
// header+page number, and an embedded image) to smoke-test the generic PDF
// ingestion pipeline without needing a real book PDF.
'use strict';

const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function main() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await doc.embedFont(StandardFonts.HelveticaOblique);
  const mono = await doc.embedFont(StandardFonts.Courier);

  // A tiny 2x2 red PNG to stand in for a diagram.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mNk+M9Q' +
    'z0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
    'base64'
  );
  const png = await doc.embedPng(pngBytes);

  const PAGE_W = 400, PAGE_H = 600;
  function newPage(pageNo, chapterTitle) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(`${chapterTitle}    ${pageNo}`, {
      x: 50, y: PAGE_H - 30, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4),
    });
    return page;
  }

  // --- Page 1: Chapter heading + wrapped/hyphenated paragraph ---
  let page = newPage(1, 'Chapter One');
  page.drawText('Chapter One. A Test Domain', { x: 50, y: 540, size: 22, font: helvBold });
  const bodyLines = [
    'This is an ordinary paragraph that wraps across several visual',
    'lines just like a real PDF would, and it even contains an in-',
    'stance of a word that was split across the line boundary.',
  ];
  bodyLines.forEach((line, i) => {
    page.drawText(line, { x: 50, y: 490 - i * 16, size: 11, font: helv });
  });
  page.drawText('Developer: So the type of component determines the pushes.', {
    x: 50, y: 430, size: 11, font: helvBold,
  });
  page.drawText('Expert: That is correct, yes.', { x: 50, y: 410, size: 11, font: helvBold });
  page.drawImage(png, { x: 50, y: 300, width: 80, height: 80 });
  page.drawText('Figure 1. A tiny test diagram.', { x: 50, y: 285, size: 9, font: helvOblique });

  // --- Page 2: list + code block ---
  page = newPage(2, 'Chapter One');
  page.drawText('1. First imposing item', { x: 50, y: 540, size: 11, font: helv });
  page.drawText('2. Second item, which wraps onto a', { x: 50, y: 522, size: 11, font: helv });
  page.drawText('continuation line without its own marker', { x: 50, y: 504, size: 11, font: helv });
  page.drawText('3. Third item', { x: 50, y: 486, size: 11, font: helv });
  page.drawText('function add(a, b) {', { x: 50, y: 440, size: 10, font: mono });
  page.drawText('  return a + b;', { x: 50, y: 424, size: 10, font: mono });
  page.drawText('}', { x: 50, y: 408, size: 10, font: mono });
  page.drawText('This italic sentence emphasizes a point.', {
    x: 50, y: 370, size: 11, font: helvOblique,
  });

  // --- Page 3: second chapter heading ---
  page = newPage(3, 'Chapter Two');
  page.drawText('Chapter Two. Another Test Chapter', { x: 50, y: 540, size: 22, font: helvBold });
  page.drawText('A short final paragraph to close out the test document.', {
    x: 50, y: 500, size: 11, font: helv,
  });

  const bytes = await doc.save();
  fs.writeFileSync('scratch/sample-book.pdf', bytes);
  console.log('wrote scratch/sample-book.pdf', bytes.length, 'bytes');
}

main();
