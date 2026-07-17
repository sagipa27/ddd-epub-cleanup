'use strict';

// Generic PDF ingestion: reads text (with position/size/style) and embedded
// raster images directly from an arbitrary PDF via pdfjs-dist, producing the
// exact same "raw line" / "figure" shapes that lib/pageExtract.js produces
// from pdf2htmlEX's HTML output. This lets the rest of the pipeline
// (mergeVisualLines / buildBlocks / renderBlocks - lib/blocks.js, lib/render.js)
// stay completely unchanged and work on either source.
//
// pdfjs-dist ships as ESM-only; this file stays CommonJS (like the rest of
// the project) and loads it via dynamic import.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

let pdfjsLibPromise = null;
function loadPdfJs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLibPromise;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Wrap a run of characters in <strong>/<em> per its resolved font style.
// Kept deliberately simple (whole text item, not sub-run) since pdf.js text
// items already come back as fairly coherent runs of one style.
function renderInlineText(str, bold, italic) {
  const text = str;
  let html = escapeHtml(str);
  if (!/\S/.test(str)) return { html, text };
  if (italic) html = `<em>${html}</em>`;
  if (bold) html = `<strong>${html}</strong>`;
  return { html, text };
}

// Resolves a text item's style via the page's shared font objects - pdf.js's
// own text-content items carry no style flags of their own. Crucially, this
// prefers pdf.js's own .bold/.italic/.fallbackName, which it derives from
// the font's actual descriptor (weight, ItalicAngle, the FixedPitch flag),
// not from the font's name string. That matters a lot for real-world PDFs:
// most embedded/subsetted fonts have opaque names like "ABCDEF+Arial" or
// just "F1" with no "Bold"/"Italic"/"Mono" substring to regex-match, so a
// name-based heuristic alone would silently miss most emphasis and code
// blocks outside of documents that (like our synthetic test fixture) happen
// to use the 14 standard PostScript font names.
function resolveFontStyle(page, fontName, cache) {
  if (cache.has(fontName)) return cache.get(fontName);
  let style = { bold: false, italic: false, monospace: false };
  try {
    const obj = page.commonObjs.get(fontName);
    if (obj) {
      const name = obj.name || obj.fallbackName || '';
      style = {
        bold: !!obj.bold || /bold|black|heavy/i.test(name),
        italic: !!obj.italic || /italic|oblique/i.test(name),
        monospace: obj.fallbackName === 'monospace' || /mono|courier|consol|typewriter/i.test(name),
      };
    }
  } catch {
    // Not resolved yet - caller must have awaited getOperatorList() first;
    // falls back to the all-false default above rather than throwing.
  }
  cache.set(fontName, style);
  return style;
}

// Walks one page's operator list tracking the graphics-state transform
// stack (save/restore/transform), so that every paintImageXObject can be
// placed in page space (PDF's native bottom-left-origin, y-up coordinate
// system - the same convention already used throughout lib/blocks.js).
async function extractPageFigures(pdfjsLib, page, opList, pageHeight, imagesOutDir, imgPrefix, warnings, knownBadObjIds) {
  const OPS = pdfjsLib.OPS;
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];

  const figures = [];
  let figIdx = 0;
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.save) { stack.push(m); continue; }
    if (fn === OPS.restore) { m = stack.pop() || m; continue; }
    if (fn === OPS.transform) { m = mul(opList.argsArray[i], m); continue; }
    if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject) continue;

    // Unit square [0,1]x[0,1] transformed by the current CTM gives the
    // image's placed bounding box in page space.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
      m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5],
    ]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);

    try {
      const objId = opList.argsArray[i][0];
      if (knownBadObjIds.has(objId)) continue; // already timed out once for this doc - don't pay the wait again
      // page.objs.get()'s callback occasionally (rarely, but reproducibly on
      // some real-world PDFs) just never fires for a specific image object -
      // not an error, not a rejection, it simply never resolves. Since
      // nothing else is keeping the event loop alive at that point, Node
      // doesn't hang - it silently exits (code 0, no stack trace, nothing
      // to catch) the instant every other pending task drains, which looks
      // exactly like the whole batch process vanishing partway through a
      // book for no visible reason. A timeout turns that silent process
      // death into an ordinary, catchable, per-image failure instead. The
      // same broken objId is often reused across many pages (a shared
      // logo/background XObject), so remember it and skip the second
      // attempt entirely rather than paying the same 20s wait every time.
      const objPromise = new Promise((resolve, reject) => {
        try { page.objs.get(objId, resolve); } catch (e) { reject(e); }
      });
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timed out waiting for page object "${objId}"`)), 20000);
      });
      let img;
      try {
        img = await Promise.race([objPromise, timeout]);
      } catch (err) {
        knownBadObjIds.add(objId);
        throw err;
      }
      if (!img || !img.data || !img.width || !img.height) continue;
      const png = imageObjToPng(img);
      if (!png) continue;
      figIdx++;
      const fileName = `${imgPrefix}-fig${figIdx}.png`;
      fs.mkdirSync(imagesOutDir, { recursive: true });
      fs.writeFileSync(path.join(imagesOutDir, fileName), png);
      figures.push({
        isFigure: true,
        src: `images/${fileName}`,
        alt: '',
        bottomEdgeBottomAnchored: y0,
        topEdgeBottomAnchored: y1,
        x: x0,
      });
    } catch (e) {
      warnings.push({ type: 'image-extraction-failed', detail: String(e && e.message || e) });
    }
  }
  return figures;
}

// pdf.js hands back already-decoded raw pixel data (it implements every PDF
// image filter - DCT/JBIG2/CCITT/JPX - in pure JS so it can render without a
// native canvas), so turning that into a PNG is just a re-encode, no image
// decoding of our own required.
function imageObjToPng(img) {
  const { width, height, data, kind } = img;
  const png = new PNG({ width, height });
  if (kind === 3) { // RGBA_32BPP
    png.data.set(data);
  } else if (kind === 2) { // RGB_24BPP
    for (let px = 0, di = 0; px < width * height; px++, di += 3) {
      png.data[px * 4] = data[di];
      png.data[px * 4 + 1] = data[di + 1];
      png.data[px * 4 + 2] = data[di + 2];
      png.data[px * 4 + 3] = 255;
    }
  } else if (kind === 1) { // GRAYSCALE_1BPP (packed bits)
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * rowBytes + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const di = (y * width + x) * 4;
        png.data[di] = png.data[di + 1] = png.data[di + 2] = v;
        png.data[di + 3] = 255;
      }
    }
  } else {
    return null; // unknown/unsupported image kind - skip rather than guess
  }
  return PNG.sync.write(png);
}

// Main entry point: parses the whole PDF into per-page raw lines + figures,
// plus whatever title/author metadata the PDF itself carries.
async function ingestPdf(pdfPath, imagesOutDir, warnings) {
  const pdfjsLib = await loadPdfJs();
  // Despite the option names looking like URLs, pdf.js's own Node build
  // (NodeBinaryDataFactory, used whenever isNodeJS is true, which is always
  // true here) resolves these by handing the string straight to Node's
  // `fs.readFile()` - not by fetching it. A `file://` URL *string* doesn't
  // work there (fs only special-cases an actual `URL` object, not a string
  // that merely looks like one) and fails silently/late, only once pdf.js
  // actually needs that asset - which is why this went unnoticed until a
  // PDF that needed the JBIG2 wasm decoder (for fax/scanned-style
  // compressed images) surfaced it; plain standard-fonts/CJK-cmap PDFs
  // never exercised this path at all. Plain OS paths (forward slashes are
  // fine on Windows too) are what actually works here.
  const pdfjsDistDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const toDir = (p) => p.replace(/\\/g, '/').replace(/\/?$/, '/');
  const standardFontDataUrl = toDir(path.join(pdfjsDistDir, 'standard_fonts'));
  const cmapUrl = toDir(path.join(pdfjsDistDir, 'cmaps'));
  const wasmUrl = toDir(path.join(pdfjsDistDir, 'wasm'));
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl, cMapUrl: cmapUrl, cMapPacked: true, wasmUrl, useSystemFonts: true }).promise;

  const metaObj = await doc.getMetadata().catch(() => null);
  const metadata = {
    title: (metaObj && metaObj.info && metaObj.info.Title) || null,
    author: (metaObj && metaObj.info && metaObj.info.Author) || null,
  };

  const pages = [];
  const styleCache = new Map();
  const knownBadObjIds = new Set();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    // Building the operator list first is what actually resolves fonts AND
    // images into page.commonObjs/page.objs - text content extraction alone
    // never triggers that resolution.
    const opList = await page.getOperatorList();
    const content = await page.getTextContent();

    const lines = [];
    let domIndex = 0;
    for (const item of content.items) {
      if (!item.str) continue; // truly empty run (e.g. a bare EOL marker) - not even whitespace
      const [a, b, , , e, f] = item.transform;
      const fontSize = Math.hypot(a, b) || 1;
      const skewItalic = Math.abs(item.transform[2]) > 0.02;
      const style = resolveFontStyle(page, item.fontName, styleCache);
      const bold = style.bold;
      const italic = style.italic || skewItalic;
      const { html, text } = renderInlineText(item.str, bold, italic);
      lines.push({
        kind: 'text',
        // endX lets lib/blocks.js's mergeVisualLines tell a real word-gap
        // apart from two glyphs that just happen to touch: plenty of PDFs
        // (unlike pdf2htmlEX's HTML, which always has an explicit spacer
        // span) encode inter-word spacing purely as horizontal positioning
        // between separate text-show operators, with no space character in
        // either run's string at all.
        x: e, y: f, endX: e + (item.width || 0), h: fontSize, fs: fontSize, ff: null,
        italic, bold, monospace: style.monospace,
        html, text,
        domIndex: domIndex++,
      });
    }

    const figures = await extractPageFigures(pdfjsLib, page, opList, viewport.height, imagesOutDir, `p${p}`, warnings, knownBadObjIds);

    pages.push({ pageNo: p, width: viewport.width, height: viewport.height, lines, figures });
    page.cleanup();
  }

  return { metadata, pages, numPages: doc.numPages };
}

module.exports = { ingestPdf };
