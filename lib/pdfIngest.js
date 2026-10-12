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
function renderInlineText(str, bold, italic, monospace) {
  const text = str;
  let html = escapeHtml(str);
  if (!/\S/.test(str)) return { html, text };
  if (monospace) html = `<code>${html}</code>`;
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
async function extractPageFigures(pdfjsLib, page, opList, pageHeight, imagesOutDir, imgPrefix, warnings, docState, options = {}) {
  const { knownBadObjIds, imageFiles } = docState;
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
      // Images used on more than one page are promoted by pdf.js to the
      // document-wide store, with a "g_" id; asking the page's own store for
      // one waits forever (pdf.js's own renderer picks the store the same
      // way). That wait is what made image-heavy books crawl - 20s per
      // image, 20 minutes for a single 60-image page - or look hung.
      const store = typeof objId === 'string' && objId.startsWith('g_') ? page.commonObjs : page.objs;
      // Kept as a safety net: an object that still never arrives becomes an
      // ordinary per-image failure rather than a stall (or, once nothing
      // else keeps Node's event loop alive, a silent exit mid-book). A bad
      // objId is often reused across pages (a shared logo), so remember it
      // and don't pay the wait twice.
      let timer;
      const objPromise = new Promise((resolve, reject) => {
        try { store.get(objId, resolve); } catch (e) { reject(e); }
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for page object "${objId}"`)), 20000);
      });
      let img;
      try {
        img = await Promise.race([objPromise, timeout]);
      } catch (err) {
        knownBadObjIds.add(objId);
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (!img || !img.data || !img.width || !img.height) continue;
      // An image drawn more than once (a shared "g_" object) is written to
      // disk once, and every draw points at that one file.
      let src = imageFiles.get(objId);
      if (!src) {
        const png = imageObjToPng(img, options.grayscale);
        if (!png) continue;
        figIdx++;
        const fileName = `${imgPrefix}-fig${figIdx}.png`;
        fs.mkdirSync(imagesOutDir, { recursive: true });
        fs.writeFileSync(path.join(imagesOutDir, fileName), png);
        src = `images/${fileName}`;
        imageFiles.set(objId, src);
      }
      figures.push({
        isFigure: true,
        objId,
        src,
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

// An image printed on many different pages is page decoration - a running
// logo, a callout icon, a chapter ornament, a background - not a figure;
// kept, it would show up as a picture on every one of those pages. Across
// a 44-book library, every shared image on 3+ pages turned out to be
// decoration (O'Reilly's callout scorpion on 4 pages, blank layout sheets
// on 7) while real figures sat on exactly one page, so anything on
// DECORATION_PAGES or more pages is dropped, file included.
const DECORATION_PAGES = 3;
function dropRepeatedDecorations(pages, imagesOutDir, imageFiles) {
  const pagesByObj = new Map();
  pages.forEach((pg, i) => pg.figures.forEach((f) => {
    if (!f.objId) return;
    if (!pagesByObj.has(f.objId)) pagesByObj.set(f.objId, new Set());
    pagesByObj.get(f.objId).add(i);
  }));
  const decorative = [...pagesByObj].filter(([, s]) => s.size >= DECORATION_PAGES).map(([id]) => id);
  if (!decorative.length) return;
  const drop = new Set(decorative);
  for (const pg of pages) pg.figures = pg.figures.filter((f) => !drop.has(f.objId));
  for (const id of decorative) {
    const src = imageFiles.get(id);
    if (src) fs.rmSync(path.join(imagesOutDir, path.basename(src)), { force: true });
  }
}

// Collects the page's vector shapes that carry document structure but no
// text: bullet dots (many PDFs draw list bullets as tiny filled circles
// rather than a "•" glyph, so the text layer alone never sees a list at
// all), shaded/outlined boxes (sidebars, TIP/NOTE callouts) and thin filled
// rules (table grid lines). Same CTM tracking as extractPageFigures, plus
// form XObjects, which carry their own matrix. Everything is returned in
// page space (bottom-left origin, y up), like every text line.
function extractPageShapes(OPS, opList, pageWidth, pageHeight) {
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
  const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const STROKE_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let fillColor = null;
  const dots = [];
  const boxes = [];
  const rules = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) { stack.push(m); continue; }
    if (fn === OPS.restore) { m = stack.pop() || m; continue; }
    if (fn === OPS.transform) { m = mul(args, m); continue; }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push(m);
      if (Array.isArray(args[0]) || (args[0] && args[0].length === 6)) m = mul(Array.from(args[0]), m);
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) { m = stack.pop() || m; continue; }
    if (fn === OPS.setFillRGBColor || fn === OPS.setFillGray || fn === OPS.setFillCMYKColor) {
      fillColor = typeof args[0] === 'string' ? args[0].toLowerCase() : null;
      continue;
    }
    if (fn !== OPS.constructPath || !args || !args[2]) continue;
    const paintOp = args[0];
    const isFill = FILL_OPS.has(paintOp);
    const isStroke = STROKE_OPS.has(paintOp);
    if (!isFill && !isStroke) continue; // clip-only / endPath
    const mm = args[2];
    if (!isFinite(mm[0]) || !isFinite(mm[3])) continue;
    const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]]
      .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    const w = x1 - x0, h = y1 - y0;
    // Page-sized white background fills are paper, not structure.
    if (w > pageWidth * 0.95 || h > pageHeight * 0.95) continue;
    const isWhite = isFill && !isStroke && /^#f{3}(f{3})?$/.test(fillColor || '');
    if (isFill && w >= 1.5 && w <= 8 && h >= 1.5 && h <= 8 && w / h > 0.5 && w / h < 2 && !isWhite) {
      dots.push({ x0, x1, y0, y1 });
    } else if (isFill && !isStroke && h <= 1.5 && w >= 10) {
      rules.push({ x0, x1, y: (y0 + y1) / 2 });
    } else if (w >= 150 && h >= 20 && !isWhite) {
      boxes.push({ x0, x1, y0, y1, filled: isFill });
    }
  }
  return { dots, boxes, rules };
}

// pdf.js hands back already-decoded raw pixel data (it implements every PDF
// image filter - DCT/JBIG2/CCITT/JPX - in pure JS so it can render without a
// native canvas), so turning that into a PNG is just a re-encode, no image
// decoding of our own required.
function imageObjToPng(img, grayscale) {
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
  // Flatten any transparency onto white paper, then write only the
  // channels that carry information: 8-bit grayscale for e-ink (default,
  // luminance-weighted so colored lines keep their relative contrast), or
  // RGB with no alpha channel. Both are far smaller than full RGBA.
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    let r = d[i] * a + 255 * (1 - a), g = d[i + 1] * a + 255 * (1 - a), b = d[i + 2] * a + 255 * (1 - a);
    if (grayscale) r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  return PNG.sync.write(downscale(png, MAX_IMAGE_SIDE), { colorType: grayscale ? 0 : 2 });
}

// A Paperwhite screen is 1072x1448; scans and print-resolution figures in
// PDFs are often 2-3x that, which multiplies the EPUB's size (70+ MB for
// one scanned book) for detail the device can't show. Capping the long
// side a little above the screen keeps some zoom headroom.
const MAX_IMAGE_SIDE = 1600;

// Area-average (box filter) downscale - every source pixel contributes to
// exactly the output pixels it overlaps, so thin diagram lines fade rather
// than vanish the way nearest-neighbour sampling would drop them.
function downscale(png, maxSide) {
  const { width: w, height: h, data: src } = png;
  const scale = maxSide / Math.max(w, h);
  if (scale >= 1) return png;
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const out = new PNG({ width: W, height: H });
  const acc = new Float64Array(W * H * 4);
  const weight = new Float64Array(W * H);
  const fx = W / w, fy = H / h;
  for (let y = 0; y < h; y++) {
    const oy0 = y * fy, oy1 = (y + 1) * fy;
    for (let oy = Math.floor(oy0); oy < Math.min(H, Math.ceil(oy1)); oy++) {
      const wy = Math.min(oy1, oy + 1) - Math.max(oy0, oy);
      if (wy <= 0) continue;
      for (let x = 0; x < w; x++) {
        const ox0 = x * fx, ox1 = (x + 1) * fx;
        const si = (y * w + x) * 4;
        for (let ox = Math.floor(ox0); ox < Math.min(W, Math.ceil(ox1)); ox++) {
          const wgt = wy * (Math.min(ox1, ox + 1) - Math.max(ox0, ox));
          if (wgt <= 0) continue;
          const oi = oy * W + ox;
          acc[oi * 4] += src[si] * wgt;
          acc[oi * 4 + 1] += src[si + 1] * wgt;
          acc[oi * 4 + 2] += src[si + 2] * wgt;
          acc[oi * 4 + 3] += src[si + 3] * wgt;
          weight[oi] += wgt;
        }
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 4; c++) out.data[i * 4 + c] = Math.round(acc[i * 4 + c] / weight[i]);
  }
  return out;
}

// Main entry point: parses the whole PDF into per-page raw lines + figures,
// plus whatever title/author metadata the PDF itself carries.
async function ingestPdf(pdfPath, imagesOutDir, warnings, options = {}) {
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
  // Per-document image state: objects that never resolved, and the file
  // each already-extracted image object was written to.
  const docState = { knownBadObjIds: new Set(), imageFiles: new Map() };
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
      const { html, text } = renderInlineText(item.str, bold, italic, style.monospace);
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

    const figures = await extractPageFigures(pdfjsLib, page, opList, viewport.height, imagesOutDir, `p${p}`, warnings, docState, options);
    const shapes = extractPageShapes(pdfjsLib.OPS, opList, viewport.width, viewport.height);

    pages.push({ pageNo: p, width: viewport.width, height: viewport.height, lines, figures, shapes });
    page.cleanup();
    if (options.onPage) options.onPage(p, doc.numPages);
  }

  dropRepeatedDecorations(pages, imagesOutDir, docState.imageFiles);
  return { metadata, pages, numPages: doc.numPages };
}

module.exports = { ingestPdf };
