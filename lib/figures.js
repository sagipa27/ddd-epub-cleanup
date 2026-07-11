'use strict';

const fs = require('fs');
const path = require('path');
const { decodePng, findContentRowClusters, cropPng } = require('./images');

const IMG_TO_CSS_SCALE = 1.3333333333; // pdf2htmlEX renders page backgrounds at ~1.33x CSS px

// Every page's diagrams/illustrations are baked into one full-page raster
// background (see lib/images.js for why). This recovers each distinct
// diagram as its own cropped PNG and reports where it belongs in the
// reading order, expressed in the same "distance from page bottom" (y)
// coordinate space used for every text line on the page.
function extractFigures($, pageEl, pageHeightCss, imagesOutDir, imgPrefix, report) {
  const img = $(pageEl).find('img.bi').first();
  if (!img.length) return [];
  const src = img.attr('src') || '';
  const m = src.match(/^data:image\/png;base64,(.+)$/s);
  if (!m) {
    if (src) report.warnings.push({ type: 'unsupported-background-image', pageId: $(pageEl).attr('id') });
    return [];
  }
  const buf = Buffer.from(m[1], 'base64');
  const png = decodePng(buf);
  const boxes = findContentRowClusters(png);
  if (!boxes.length) return [];

  const figures = [];
  boxes.forEach((box, idx) => {
    const { buffer } = cropPng(png, box, 8);
    const fileName = `${imgPrefix}-fig${idx + 1}.png`;
    fs.mkdirSync(imagesOutDir, { recursive: true });
    fs.writeFileSync(path.join(imagesOutDir, fileName), buffer);

    const topCssFromTop = box.y0 / IMG_TO_CSS_SCALE;
    const bottomCssFromTop = box.y1 / IMG_TO_CSS_SCALE;
    const bottomEdgeBottomAnchored = pageHeightCss - bottomCssFromTop;
    const topEdgeBottomAnchored = pageHeightCss - topCssFromTop;

    figures.push({
      isFigure: true,
      src: `images/${fileName}`,
      alt: '',
      bottomEdgeBottomAnchored,
      topEdgeBottomAnchored,
      x: 0,
    });
    report.imagesExtracted.push({ page: $(pageEl).attr('id'), file: fileName });
  });
  return figures;
}

// Insert each figure right before the first text line that is clearly below
// it (see docs/investigation notes: using the figure's bottom edge, rather
// than its top edge, matches the book's actual side-by-side text/diagram
// layout far better than a naive "insert into the biggest vertical gap").
function spliceFigures(mergedLines, figures) {
  if (!figures.length) return mergedLines;
  const result = [...mergedLines];
  for (const fig of figures) {
    let insertAt = result.findIndex((l) => !l.isFigure && l.y < fig.bottomEdgeBottomAnchored);
    if (insertAt === -1) insertAt = result.length;
    result.splice(insertAt, 0, fig);
  }
  return result;
}

module.exports = { extractFigures, spliceFigures };
