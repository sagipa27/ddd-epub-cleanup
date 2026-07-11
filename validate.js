#!/usr/bin/env node
'use strict';

// Phase 13 validation: checks the cleaned XHTML for structural well-
// formedness and the specific classes of leftover PDF-conversion junk the
// workflow calls out, then compares total body text length against the
// original source pages it was built from.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

function parseArgs(argv) {
  const args = { file: 'cleaned-html/chapter-5.xhtml', sourceTextLength: null };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    args[k] = v;
  }
  return args;
}

function checkWellFormed(xml) {
  const issues = [];
  try {
    cheerio.load(xml, { xmlMode: true, recognizeSelfClosing: true });
  } catch (e) {
    issues.push(`XML parse error: ${e.message}`);
  }
  return issues;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const xml = fs.readFileSync(args.file, 'utf8');
  const $ = cheerio.load(xml, { xmlMode: false });
  const issues = { errors: [], warnings: [] };

  issues.errors.push(...checkWellFormed(xml).map((m) => ({ type: 'malformed-xml', detail: m })));

  const ids = new Map();
  $('[id]').each((i, el) => {
    const id = $(el).attr('id');
    ids.set(id, (ids.get(id) || 0) + 1);
  });
  for (const [id, count] of ids) {
    if (count > 1) issues.errors.push({ type: 'duplicate-id', id, count });
  }

  $('a[href^="#"]').each((i, el) => {
    const href = $(el).attr('href').slice(1);
    if (!$(`#${href}`).length) issues.errors.push({ type: 'broken-anchor', href });
  });

  const baseDir = path.dirname(args.file);
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (!src) { issues.errors.push({ type: 'missing-img-src' }); return; }
    const abs = path.join(baseDir, src);
    if (!fs.existsSync(abs)) issues.errors.push({ type: 'broken-image-path', src });
  });

  $('[style*="position:absolute"], [style*="position: absolute"]').each((i, el) => {
    issues.errors.push({ type: 'residual-absolute-positioning', html: $.html(el).slice(0, 120) });
  });
  $('[class*="pf"], [class*="pc"]').each((i, el) => {
    issues.warnings.push({ type: 'residual-pdf2htmlex-class', class: $(el).attr('class') });
  });

  $('p').each((i, el) => {
    const t = $(el).text().trim();
    if (!t) { issues.warnings.push({ type: 'empty-paragraph', index: i }); return; }
    if (/^\S+$/.test(t) && t.split(' ').length === 1 && t.length > 1 && !/[.!?]$/.test(t)) {
      issues.warnings.push({ type: 'suspicious-one-word-paragraph', text: t });
    }
    if (t.length === 1) issues.warnings.push({ type: 'suspicious-one-char-paragraph', text: t });
    if (/[a-z]-\s*$/.test(t)) issues.warnings.push({ type: 'trailing-hyphen-paragraph', text: t.slice(-40) });
  });

  $('h1, h2, h3').each((i, el) => {
    if (!$(el).text().trim()) issues.warnings.push({ type: 'empty-heading', tag: el.tagName });
  });

  $('figcaption').each((i, el) => {
    if (!$(el).closest('figure').length) issues.warnings.push({ type: 'orphan-caption', text: $(el).text().slice(0, 60) });
  });

  let deepestNesting = 0;
  $('span').each((i, el) => {
    let depth = 0, cur = el;
    while (cur) { if (cur.tagName === 'span') depth++; cur = cur.parent; }
    deepestNesting = Math.max(deepestNesting, depth);
  });
  if (deepestNesting > 3) issues.warnings.push({ type: 'excessive-nested-spans', depth: deepestNesting });

  const bodyText = $('body').text();
  const result = {
    file: args.file,
    generatedAt: new Date().toISOString(),
    bodyTextLength: bodyText.length,
    errors: issues.errors,
    warnings: issues.warnings,
    errorCount: issues.errors.length,
    warningCount: issues.warnings.length,
  };

  if (args.sourceTextLength) {
    const before = parseInt(args.sourceTextLength, 10);
    const after = bodyText.length;
    const pctChange = ((after - before) / before) * 100;
    result.textLengthBefore = before;
    result.textLengthAfter = after;
    result.textLengthPctChange = Number(pctChange.toFixed(2));
    if (Math.abs(pctChange) > 5) {
      result.errors.push({ type: 'significant-text-length-change', pctChange: result.textLengthPctChange });
    }
  }

  fs.mkdirSync(args.reportDir || 'reports', { recursive: true });
  fs.writeFileSync(
    path.join(args.reportDir || 'reports', 'validation-report.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
  console.log(`[validate] ${args.file}: ${result.errorCount} error(s), ${result.warningCount} warning(s)`);
  console.log(JSON.stringify(result, null, 2));
}

main();
