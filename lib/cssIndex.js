'use strict';

// Parses the pdf2htmlEX <style> blocks and builds a lookup table that
// resolves positioning / typography classes (x*, y*, h*, w*, fs*, m*, sc*)
// to their numeric CSS values. pdf2htmlEX emits one CSS rule per class, so a
// simple brace-matching regex over the concatenated style text is sufficient
// and much faster than a full CSS parser for a file this size.
function buildCssIndex($) {
  const styleText = $('style').map((i, el) => $(el).html()).get().join('\n');

  const classDefRe = /\.([a-zA-Z]+[0-9a-zA-Z]*)\{([^}]*)\}/g;
  const classMap = new Map();
  let m;
  while ((m = classDefRe.exec(styleText))) {
    const name = m[1];
    const body = m[2];
    if (!classMap.has(name)) classMap.set(name, []);
    classMap.get(name).push(body);
  }

  function getNumericPx(cls, propNames) {
    const defs = classMap.get(cls);
    if (!defs) return null;
    for (const body of defs) {
      for (const prop of propNames) {
        const re = new RegExp(prop + ':([\\-0-9.]+)px');
        const mm = body.match(re);
        if (mm) return parseFloat(mm[1]);
      }
    }
    return null;
  }

  // Italic detection: pdf2htmlEX represents italic (or any skewed) glyphs by
  // applying a transform matrix with a non-zero skew (3rd) component via an
  // "mN" class. Precompute the full set once instead of parsing per line.
  const italicM = new Set();
  const matrixRe = /\.m(\d+)\{transform:matrix\(([^)]+)\)/g;
  while ((m = matrixRe.exec(styleText))) {
    const nums = m[2].split(',').map(parseFloat);
    if (Math.abs(nums[2]) > 0.001) italicM.add('m' + m[1]);
  }

  // Bold-ish emphasis: pdf2htmlEX fakes a bold weight with a text-stroke /
  // text-shadow outline via "scN" classes. sc0 is always the "no stroke"
  // baseline; any other scN found in the stylesheet is treated as emphasis.
  const boldSc = new Set();
  const scRe = /\.sc(\d+)\{/g;
  while ((m = scRe.exec(styleText))) {
    if (m[1] !== '0') boldSc.add('sc' + m[1]);
  }

  const pageHeight = getNumericPx('h0', ['height']) || null;

  function resolveLineMetrics(classAttr) {
    const classes = (classAttr || '').split(/\s+/).filter(Boolean);
    let x = null, y = null, h = null, fs = null, ff = null, mCls = null, scCls = null;
    for (const c of classes) {
      if (x === null && /^x[0-9a-f]+$/.test(c)) x = getNumericPx(c, ['left']);
      if (y === null && /^y[0-9a-f]+$/.test(c)) y = getNumericPx(c, ['bottom']);
      if (h === null && /^h[0-9a-f]+$/.test(c)) h = getNumericPx(c, ['height']);
      if (fs === null && /^fs\d+$/.test(c)) fs = getNumericPx(c, ['font-size']);
      if (/^ff\d+$/.test(c)) ff = c;
      if (/^m\d+$/.test(c)) mCls = c;
      if (/^sc\d+$/.test(c)) scCls = c;
    }
    return {
      x, y, h, fs, ff,
      italic: mCls ? italicM.has(mCls) : false,
      bold: scCls ? boldSc.has(scCls) : false,
    };
  }

  return { classMap, getNumericPx, italicM, boldSc, pageHeight, resolveLineMetrics };
}

module.exports = { buildCssIndex };
