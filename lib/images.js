'use strict';

const { PNG } = require('pngjs');

// pdf2htmlEX rasterizes every non-text drawing operation (rules, diagram
// lines/boxes, shading) for a page into one full-page background PNG, while
// leaving blank/white space wherever only selectable text is drawn (the text
// itself is layered on top as real HTML). To recover diagrams as proper
// <figure> images we have to find the "ink" inside that raster and crop it,
// while ignoring the thin decorative rule lines that run the full page width
// near the top/bottom margin of literally every page in this book.

const WHITE_THRESHOLD = 250; // treat channel values above this as "blank"
const FURNITURE_BAND_MAX_ROWS = 8; // max thickness of a full-width rule line
const FURNITURE_MIN_SPAN_RATIO = 0.85; // how much of the row width must be "ink"
const CLUSTER_GAP_ROWS = 20; // blank-row gap that separates distinct figures
const MIN_CONTENT_AREA_RATIO = 0.0015; // ignore specks / anti-aliasing noise

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

function rowHasInk(png, y) {
  const { width, data } = png;
  let inkCount = 0;
  let minX = -1, maxX = -1;
  for (let x = 0; x < width; x++) {
    const idx = (width * y + x) << 2;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
    if (a > 10 && (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD)) {
      if (minX === -1) minX = x;
      maxX = x;
      inkCount++;
    }
  }
  return { inkCount, minX, maxX };
}

// Returns an array of {top, bottom} row ranges (in image px, exclusive of
// furniture) that contain meaningful, non-furniture content.
function findContentRowClusters(png) {
  const { width, height } = png;
  const rowInfo = [];
  for (let y = 0; y < height; y++) {
    rowInfo.push(rowHasInk(png, y));
  }

  // Identify furniture bands: short runs of consecutive rows whose ink spans
  // almost the entire page width (i.e. a printed rule line), independent of
  // where they sit vertically (top margin, bottom margin, or both).
  const isFurnitureRow = new Array(height).fill(false);
  let runStart = null;
  for (let y = 0; y <= height; y++) {
    const spansFull = y < height && rowInfo[y].inkCount > 0 &&
      (rowInfo[y].maxX - rowInfo[y].minX) >= width * FURNITURE_MIN_SPAN_RATIO;
    if (spansFull) {
      if (runStart === null) runStart = y;
    } else {
      if (runStart !== null) {
        const runLen = y - runStart;
        if (runLen <= FURNITURE_BAND_MAX_ROWS) {
          for (let yy = runStart; yy < y; yy++) isFurnitureRow[yy] = true;
        }
        runStart = null;
      }
    }
  }

  // Cluster remaining ink rows into content bands, tolerating small gaps.
  const clusters = [];
  let clusterStart = null;
  let blankRun = 0;
  for (let y = 0; y < height; y++) {
    const hasInk = !isFurnitureRow[y] && rowInfo[y].inkCount > 0;
    if (hasInk) {
      if (clusterStart === null) clusterStart = y;
      blankRun = 0;
    } else if (clusterStart !== null) {
      blankRun++;
      if (blankRun > CLUSTER_GAP_ROWS) {
        clusters.push({ top: clusterStart, bottom: y - blankRun });
        clusterStart = null;
        blankRun = 0;
      }
    }
  }
  if (clusterStart !== null) {
    clusters.push({ top: clusterStart, bottom: height - 1 - blankRun });
  }

  // Compute a horizontal bbox for each cluster and filter out noise specks.
  const boxes = [];
  for (const c of clusters) {
    let minX = width, maxX = 0;
    let totalInk = 0;
    for (let y = c.top; y <= c.bottom; y++) {
      if (isFurnitureRow[y]) continue;
      const info = rowInfo[y];
      if (info.inkCount === 0) continue;
      if (info.minX < minX) minX = info.minX;
      if (info.maxX > maxX) maxX = info.maxX;
      totalInk += info.inkCount;
    }
    const area = (maxX - minX) * (c.bottom - c.top);
    if (totalInk > 0 && area / (width * height) > MIN_CONTENT_AREA_RATIO) {
      boxes.push({ x0: minX, y0: c.top, x1: maxX, y1: c.bottom });
    }
  }
  return boxes;
}

function cropPng(png, box, paddingPx) {
  const x0 = Math.max(0, box.x0 - paddingPx);
  const y0 = Math.max(0, box.y0 - paddingPx);
  const x1 = Math.min(png.width - 1, box.x1 + paddingPx);
  const y1 = Math.min(png.height - 1, box.y1 + paddingPx);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x0, y0, w, h, 0, 0);
  return { buffer: PNG.sync.write(out), width: w, height: h };
}

module.exports = { decodePng, findContentRowClusters, cropPng };
