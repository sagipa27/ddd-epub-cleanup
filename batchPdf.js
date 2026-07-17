#!/usr/bin/env node
'use strict';

// Batch entry point: drop any number of PDFs into one folder and run every
// one of them through the exact same generic pipeline as `cleanup.js
// --pdf=...` (see lib/pdfPipeline.js), each into its own output folder, with
// an optional EPUB build at the end of each. One bad/unusual PDF never
// aborts the rest of the batch - it's recorded as a failure and skipped.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { runPdfPipeline } = require('./lib/pdfPipeline');
const { renderBlocks, wrapXhtml } = require('./lib/render');
const { newReport } = require('./lib/report');

function parseArgs(argv) {
  const args = {
    dir: 'pdfs',
    output: 'cleaned-html',
    reportDir: 'reports',
    epub: true,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'no-epub') args.epub = false;
    else if (k === 'epub') args.epub = v === undefined ? true : v !== 'false';
    else args[k] = v;
  }
  return args;
}

// Capped well under Windows' ~260-char MAX_PATH: the slug gets used *twice*
// in the full output path (once as the book's own folder name, once again
// as its .epub filename inside that folder), so a long book title can
// blow past the limit even though no individual segment looks unreasonable
// on its own - which is exactly what happened with a title-length slug for
// "The Pragmatic Programmer Your Journey to Mastery, 20th Anniversary
// Edition..." (ebook-convert failed with a plain, if truncated-looking,
// "No such file or directory").
const MAX_SLUG_LEN = 50;
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.slice(0, MAX_SLUG_LEN).replace(/-+$/, '')) || 'book';
}

function findCalibre() {
  try {
    execFileSync('ebook-convert', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function processOne(pdfFile, args, calibreAvailable) {
  const baseName = path.basename(pdfFile, path.extname(pdfFile));
  const slug = slugify(baseName);
  const bookOutput = path.join(args.output, slug);
  const bookReportDir = path.join(args.reportDir, slug);
  const report = newReport();

  const result = await runPdfPipeline({ pdf: pdfFile, output: bookOutput, scope: 'all' }, report);
  const title = result.title || result.metadata.title || baseName;
  const bodyHtml = result.bodyHtml;
  const textLengthAfter = bodyHtml.replace(/<[^>]+>/g, '').length;
  report.textLengthAfter = textLengthAfter;

  fs.mkdirSync(bookOutput, { recursive: true });
  fs.mkdirSync(path.join(bookOutput, 'styles'), { recursive: true });
  fs.copyFileSync('styles/epub.css', path.join(bookOutput, 'styles', 'epub.css'));
  const xhtmlPath = path.join(bookOutput, 'all.xhtml');
  fs.writeFileSync(xhtmlPath, wrapXhtml(title, bodyHtml, 'styles/epub.css'), 'utf8');

  fs.mkdirSync(bookReportDir, { recursive: true });
  fs.writeFileSync(path.join(bookReportDir, 'cleanup-report.json'), JSON.stringify(report, null, 2), 'utf8');

  let epubPath = null;
  let epubError = null;
  if (args.epub) {
    if (!calibreAvailable) {
      epubError = 'ebook-convert not found on PATH (Calibre not installed?) - skipped';
    } else {
      epubPath = path.join(bookOutput, `${slug}.epub`);
      const convertArgs = [xhtmlPath, epubPath, '--title', title];
      if (result.metadata.author) convertArgs.push('--authors', result.metadata.author);
      // ebook-convert has occasionally failed once and then succeeded
      // immediately on an unmodified retry (seen on long, deeply-nested
      // Windows paths - possibly a transient temp-file/lock hiccup on
      // calibre's side rather than anything wrong with our XHTML), so one
      // retry is worth it before giving up and reporting a real failure.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          execFileSync('ebook-convert', convertArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
          epubError = null;
          break;
        } catch (e) {
          const stderrTail = (e && e.stderr ? e.stderr.toString('utf8') : String((e && e.message) || e)).slice(-300);
          epubError = `ebook-convert failed (attempt ${attempt}/2): ${stderrTail}`;
        }
      }
      if (epubError) epubPath = null;
    }
  }

  return {
    file: pdfFile,
    slug,
    title,
    pages: report.pagesProcessed.length,
    chapters: result.chapterStarts.length,
    warnings: report.warnings.length,
    hyphenRepairs: report.hyphenRepairs.length,
    imagesExtracted: report.imagesExtracted.length,
    xhtml: xhtmlPath,
    epub: epubPath,
    epubError,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.dir)) {
    console.error(`[batch] input folder not found: ${args.dir}`);
    console.error(`[batch] create it and drop your PDFs in there, e.g.: mkdir -p ${args.dir}`);
    process.exit(1);
  }
  const pdfFiles = fs.readdirSync(args.dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort()
    .map((f) => path.join(args.dir, f));

  if (!pdfFiles.length) {
    console.log(`[batch] no .pdf files found in ${args.dir}`);
    return;
  }

  const calibreAvailable = args.epub ? findCalibre() : false;
  if (args.epub && !calibreAvailable) {
    console.warn('[batch] warning: ebook-convert not found on PATH - EPUBs will be skipped (XHTML/images still produced)');
  }

  console.log(`[batch] found ${pdfFiles.length} PDF(s) in ${args.dir}:`);
  pdfFiles.forEach((f) => console.log(`  - ${f}`));

  const results = [];
  for (const pdfFile of pdfFiles) {
    console.log(`\n[batch] === ${pdfFile} ===`);
    try {
      const r = await processOne(pdfFile, args, calibreAvailable);
      results.push(r);
      console.log(`[batch] OK: ${r.pages} pages, ${r.chapters} chapters, ${r.warnings} warnings, ${r.imagesExtracted} images${r.epub ? `, epub -> ${r.epub}` : ''}`);
      if (r.epubError) console.warn(`[batch] ${r.epubError}`);
    } catch (e) {
      console.error(`[batch] FAILED: ${e && e.message || e}`);
      results.push({ file: pdfFile, error: String(e && e.message || e) });
    }
  }

  fs.mkdirSync(args.reportDir, { recursive: true });
  const summaryPath = path.join(args.reportDir, 'batch-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');

  console.log(`\n[batch] === summary (${results.length} file(s)) ===`);
  for (const r of results) {
    if (r.error) {
      console.log(`  FAILED  ${r.file}: ${r.error}`);
    } else {
      console.log(`  OK      ${r.file} -> ${r.xhtml}${r.epub ? ' + ' + r.epub : ''} (${r.pages}pg, ${r.chapters}ch, ${r.warnings} warnings)`);
    }
  }
  console.log(`[batch] summary written to ${summaryPath}`);
}

main().catch((err) => {
  console.error('[batch] fatal error:', err);
  process.exit(1);
});
