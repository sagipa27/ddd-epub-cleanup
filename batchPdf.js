#!/usr/bin/env node
'use strict';

// Batch entry point: drop any number of PDFs into one folder and get one
// Kindle-ready EPUB per book in the output folder - nothing else. Each PDF
// runs through the same generic pipeline as `cleanup.js --pdf=...` (see
// lib/pdfPipeline.js); the intermediate XHTML, images, cover and cleanup
// report are built in a temporary working folder that's deleted once the
// EPUB exists. --debug keeps that folder (under <output>/_debug/<book>) for
// troubleshooting a bad conversion. One bad/unusual PDF never aborts the
// rest of the batch - it's reported as a failure and skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { runPdfPipeline } = require('./lib/pdfPipeline');
const { wrapXhtml } = require('./lib/render');
const { newReport } = require('./lib/report');

function parseArgs(argv) {
  const args = {
    dir: 'pdfs',
    output: 'epubs',
    // Where each PDF is moved once its EPUB has been built, so the input
    // folder only ever holds books still waiting (or that failed and can
    // just be retried). --processed=none leaves PDFs where they are.
    processed: 'processed-pdf',
    // Books converted at once, each in its own process. 4 keeps memory in
    // check on large scanned PDFs (a worker can use 1-2 GB); raise it with
    // --jobs=N on a machine with RAM to spare.
    jobs: 4,
    // Heap limit per worker, in MB (--memory=N).
    memoryMb: 4096,
    debug: false,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    // --color keeps images in color; by default they're saved grayscale
    // for e-ink Kindles.
    if (k === 'color') args.color = v !== 'false';
    else if (k === 'debug') args.debug = v !== 'false';
    else if (k === 'jobs') args.jobs = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'memory') args.memoryMb = Math.max(512, parseInt(v, 10) || 4096);
    else args[k] = v;
  }
  return args;
}

// Moves a converted PDF into the processed folder, never overwriting a
// same-named file already there ("Book.pdf" -> "Book (2).pdf"). rename()
// can't cross drives, so that case falls back to copy + delete.
function moveToProcessed(pdfFile, processedDir) {
  fs.mkdirSync(processedDir, { recursive: true });
  const ext = path.extname(pdfFile);
  const base = path.basename(pdfFile, ext);
  let target = path.join(processedDir, base + ext);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(processedDir, `${base} (${n})${ext}`);
  try {
    fs.renameSync(pdfFile, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(pdfFile, target);
    fs.unlinkSync(pdfFile);
  }
  return target;
}

// Working folders are normally deleted as each book finishes, but a run
// that's killed mid-book (closed terminal, crash) never gets to. Anything
// of ours in the temp dir older than a few hours is such a leftover - no
// book takes that long - so each run clears them out first.
const WORK_PREFIX = 'pdf2epub-';
function sweepStaleWorkDirs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // In use or already gone - leave it.
    }
  }
}

// The EPUB is named after the book's title (what you'll recognize in a file
// list), minus characters Windows doesn't allow in filenames.
function epubFileName(title, slug) {
  const safe = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${safe || slug}.epub`;
}

// Capped well under Windows' ~260-char MAX_PATH: the slug names the book's
// working folder, and a title-length one inside an already-deep temp path
// blows past the limit - which is exactly what happened with "The Pragmatic
// Programmer Your Journey to Mastery, 20th Anniversary Edition..."
// (ebook-convert failed with a plain, if truncated-looking, "No such file or
// directory").
const MAX_SLUG_LEN = 50;
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.slice(0, MAX_SLUG_LEN).replace(/-+$/, '')) || 'book';
}

// Many PDFs carry no Title/Author metadata at all, which left the EPUB (and
// so the Kindle library entry) named "Book" by "Unknown". The filename is
// usually the next best source: "Fundamentals-of-Data-Engineering-by-Joe-
// Reis-and-Matt-Housley_bibis.ir" -> "Fundamentals of Data Engineering" by
// "Joe Reis and Matt Housley". Download-site tags and bracketed publisher
// prefixes are dropped; a trailing "by X" / " - X" / "(X)" names the author.
function titleFromFilename(baseName) {
  let name = baseName
    .replace(/[_ ](bibis\.ir|z-lib(\.org)?|libgen(\.\w+)?|www\.[\w.]+|ebook|pdf)$/i, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/[_]+/g, ' ');
  // Hyphen-separated slugs ("the-managers-path"): hyphens are word breaks.
  if (!/\s/.test(name) && /-/.test(name)) name = name.replace(/-+/g, ' ');
  name = name.replace(/\s+/g, ' ').trim()
    // Trailing publisher/year: "...Systems Work-O'Reilly Media (2019)".
    .replace(/\s*\(\d{4}\)$/, '')
    .replace(/\s*[-–]\s*(O'?Reilly( Media)?|Manning|Packt|Apress|Addison[- ]Wesley|No Starch Press|Pragmatic Bookshelf|Wiley)\s*$/i, '');
  let author = null;
  let m;
  const parts = name.split(/\s+-\s+/);
  const wordCount = (s) => s.trim().split(/\s+/).length;
  // "by" must follow a space or a year, so "Derby"/"Abby" never split.
  if ((m = name.match(/^(.*?)\s*(?:\(?\d{4}\)?\s*|\s)by[\s-]+(.+)$/i))) {
    // "Title by Author", "Title 2009by-Author"
    name = m[1]; author = m[2];
  } else if (parts.length > 2 || (parts.length === 2 && wordCount(parts[1]) > 4)) {
    // "Author - Title - Subtitle", "Author - A Long Title..."
    author = parts[0]; name = parts.slice(1).join(': ');
  } else if (parts.length === 2) {
    // "Title - Author"
    name = parts[0]; author = parts[1];
  } else if ((m = name.match(/^(.+?)\s*\(([^)]+)\)$/))) {
    name = m[1]; author = m[2];
  }
  // Title-case slugs that came in all lowercase.
  if (name === name.toLowerCase()) name = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { title: name.trim() || baseName, author: author ? author.trim() : null };
}

// PDF metadata is often polluted by whoever distributed the file:
// "AI Engineering (for True Epub)", "... - PDFDrive.com", a personalized
// "(for Jane Doe)" watermark. Strip those, but nothing else - a real
// subtitle in parentheses stays.
function cleanTitle(title) {
  if (!title) return title;
  return title
    .replace(/\s*\((for|by)\s[^)]*\)\s*$/i, '')
    .replace(/\s*[-|–]\s*(pdfdrive|z-?lib|libgen|ebook3000|allitebooks|it-ebooks)(\.\w+)*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || title;
}

// Normalizes an author string for Calibre, which separates co-authors with
// "&": library-style "Reilly, Tanya;" / "Eryurek, Evren; Gilad, Uri" become
// "Tanya Reilly" / "Evren Eryurek & Uri Gilad"; a comma-separated list of
// full names ("Neal Ford, Mark Richards") becomes an "&" list. Distributor
// names and placeholders ("PDFDrive", "Unknown", "Administrator") are
// dropped entirely, so the filename fallback gets a chance instead.
const JUNK_AUTHOR_RE = /^(pdfdrive(\.com)?|unknown|administrator|admin|user|owner|author|calibre|adobe.*|microsoft.*|www\..*)$/i;
function cleanAuthors(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim().replace(/[;,]\s*$/, '');
  if (!s || JUNK_AUTHOR_RE.test(s)) return null;
  let names;
  if (s.includes(';')) {
    names = s.split(';').map((n) => n.trim()).filter(Boolean)
      .map((n) => { const m = n.match(/^([^,]+),\s*(.+)$/); return m ? `${m[2]} ${m[1]}` : n; });
  } else if (/^[^,\s]+,\s*[^,\s]+$/.test(s)) {
    const m = s.match(/^([^,]+),\s*(.+)$/); // a single "Last, First"
    names = [`${m[2]} ${m[1]}`];
  } else {
    // Split on commas / "and" only when every piece looks like a full name.
    const pieces = s.split(/\s*,\s*|\s+and\s+|\s*&\s*/).filter(Boolean);
    names = pieces.length > 1 && pieces.every((p) => p.split(' ').length >= 2) ? pieces : [s];
  }
  names = names.filter((n) => !JUNK_AUTHOR_RE.test(n));
  return names.length ? names.join(' & ') : null;
}

function findCalibre() {
  try {
    execFileSync('ebook-convert', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// pdftoppm (bundled with Calibre - it ships the poppler tools it uses
// internally for PDF rendering) is what lets us render one *specific* page
// as the cover, for the rare book where Calibre's own auto-detection (see
// extractCover below) picks the wrong page or finds nothing. It's usually
// not on PATH even when Calibre itself is, so check PATH first and then
// fall back to Calibre's own install dir on each OS.
const PDFTOPPM_FALLBACK_PATHS = [
  'C:/Program Files/Calibre2/app/bin/pdftoppm.exe',
  'C:/Program Files (x86)/Calibre2/app/bin/pdftoppm.exe',
  '/Applications/calibre.app/Contents/MacOS/pdftoppm',
  '/opt/calibre/pdftoppm',
];
function findPdftoppm() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return 'pdftoppm';
  } catch {
    for (const p of PDFTOPPM_FALLBACK_PATHS) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}

// ebook-convert builds the EPUB from our XHTML, not from the original PDF,
// so it never sees the PDF's actual cover and instead falls back to a
// generic "title text on a blank background" placeholder - which is the
// cover that was showing (or, on some Kindle firmwares, silently failing to
// show) instead of the real book cover. `ebook-meta --get-cover` reads
// Calibre's own PDF cover detection (embedded metadata cover, falling back
// to a render of page 1) independently of ebook-convert, so it recovers the
// real cover the same way Calibre's own "Convert books" GUI would. Returns
// null (rather than throwing) for the rare PDF with no extractable cover -
// that PDF just keeps the old placeholder-cover behavior, it doesn't fail
// the batch.
//
// `pageOverride` (1-indexed, from cover-pages.json - see loadCoverPageOverrides)
// bypasses that auto-detection entirely and renders the exact page the user
// asked for via pdftoppm, for PDFs where page 1 (or the embedded metadata
// cover) isn't the real cover - e.g. a scanned front matter/blank page, or a
// cover that's actually a few pages in.
function extractCover(pdfFile, coverPath, pageOverride, pdftoppmPath) {
  if (pageOverride != null) {
    if (!pdftoppmPath) return null;
    const outPrefix = coverPath.replace(/\.jpe?g$/i, '');
    try {
      execFileSync(pdftoppmPath, [
        '-f', String(pageOverride), '-l', String(pageOverride),
        '-jpeg', '-singlefile', '-r', '150',
        pdfFile, outPrefix,
      ], { stdio: 'ignore' });
      return fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0 ? coverPath : null;
    } catch {
      return null;
    }
  }
  try {
    execFileSync('ebook-meta', [pdfFile, `--get-cover=${coverPath}`], { stdio: 'ignore' });
    return fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0 ? coverPath : null;
  } catch {
    return null;
  }
}

// Optional per-file override for which PDF page is the real cover, read from
// <dir>/cover-pages.json, e.g.:
//   { "mythical-man-month.pdf": 3 }
// Keyed by the PDF's filename (not the slug), since that's what's visible
// to someone looking at the input folder deciding a page needs overriding.
// Silently returns {} if the file doesn't exist - this is an opt-in escape
// hatch, not a required config.
function loadCoverPageOverrides(dir) {
  const file = path.join(dir, 'cover-pages.json');
  if (!fs.existsSync(file)) return {};
  try {
    // Strip a UTF-8 BOM - Windows editors/PowerShell's `Set-Content -Encoding
    // utf8` write one by default, and JSON.parse rejects it outright.
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[batch] warning: couldn't parse ${file}: ${e.message} - ignoring`);
    return {};
  }
}

async function processOne(pdfFile, args, pdftoppmPath, coverPageOverrides) {
  const baseName = path.basename(pdfFile, path.extname(pdfFile));
  const slug = slugify(baseName);
  // Everything except the EPUB itself is scratch: built in a temp folder
  // (or <output>/_debug/<slug> with --debug) and removed afterwards.
  const workDir = args.debug
    ? path.join(args.output, '_debug', slug)
    : fs.mkdtempSync(path.join(os.tmpdir(), WORK_PREFIX));
  if (args.debug) fs.mkdirSync(workDir, { recursive: true });
  const report = newReport();

  try {
    const result = await runPdfPipeline({ pdf: pdfFile, output: workDir, scope: 'all', color: !!args.color }, report);
    const fromName = titleFromFilename(baseName);
    const title = cleanTitle(result.title) || fromName.title;
    const author = cleanAuthors(result.metadata.author) || cleanAuthors(fromName.author);
    const bodyHtml = result.bodyHtml;
    report.textLengthAfter = bodyHtml.replace(/<[^>]+>/g, '').length;

    fs.mkdirSync(path.join(workDir, 'styles'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'styles', 'epub.css'), path.join(workDir, 'styles', 'epub.css'));
    const xhtmlPath = path.join(workDir, 'all.xhtml');
    fs.writeFileSync(xhtmlPath, wrapXhtml(title, bodyHtml, 'styles/epub.css'), 'utf8');
    if (args.debug) fs.writeFileSync(path.join(workDir, 'cleanup-report.json'), JSON.stringify(report, null, 2), 'utf8');

    fs.mkdirSync(args.output, { recursive: true });
    const epubPath = path.join(args.output, epubFileName(title, slug));
    const convertArgs = [
      xhtmlPath, epubPath, '--title', title,
      // Kindle Paperwhite (3rd gen and later: 1072x1448, 300 ppi) - sizes
      // images and font rescaling for that screen.
      '--output-profile', 'kindle_pw3',
      // Calibre's default also breaks before every <h2>, which turns each
      // section into a half-empty page; chapters (h1) are enough.
      '--chapter', '//h:h1',
      '--page-breaks-before', '//h:h1',
      // Explicit nested TOC (chapter > section > subsection) instead of
      // Calibre's guesswork, which flattens or skips levels.
      '--level1-toc', '//h:h1',
      '--level2-toc', '//h:h2',
      '--level3-toc', '//h:h3',
      '--preserve-cover-aspect-ratio',
    ];
    if (author) convertArgs.push('--authors', author);
    const pageOverride = coverPageOverrides[path.basename(pdfFile)];
    const coverPath = extractCover(pdfFile, path.join(workDir, 'cover.jpg'), pageOverride, pdftoppmPath);
    const coverSource = coverPath ? (pageOverride != null ? `page ${pageOverride} (override)` : 'from PDF') : 'Calibre placeholder';
    if (pageOverride != null && !coverPath) {
      console.warn(`[batch] cover-pages.json asked for page ${pageOverride} of ${path.basename(pdfFile)}, but rendering it failed - falling back to Calibre's placeholder cover`);
    }
    if (coverPath) convertArgs.push('--cover', coverPath);
    // ebook-convert has occasionally failed once and then succeeded
    // immediately on an unmodified retry (seen on long, deeply-nested
    // Windows paths - possibly a transient temp-file/lock hiccup on
    // calibre's side rather than anything wrong with our XHTML), so one
    // retry is worth it before giving up and reporting a real failure.
    let epubError = null;
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
    if (epubError) throw new Error(epubError);

    return {
      file: pdfFile,
      title,
      pages: report.pagesProcessed.length,
      chapters: result.chapterStarts.length,
      warnings: report.warnings.length,
      epub: epubPath,
      coverSource,
    };
  } finally {
    if (!args.debug) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// --- Worker side: one book per process -----------------------------------
// The batch runs each book in its own Node process. That's what makes books
// run truly in parallel (PDF parsing is CPU-bound, and a single process only
// ever uses one core), keeps the pipeline's per-book calibration state -
// module-level in lib/blocks.js - from leaking between books, and contains
// failures: a book that crashes or runs out of memory fails on its own
// instead of silently taking the whole batch down with it.
const WORKER_ENV = 'PDF2EPUB_WORKER';
const RESULT_MARKER = '@@PDF2EPUB_RESULT@@';

async function runWorker() {
  const { pdfFile, args } = JSON.parse(process.env[WORKER_ENV]);
  let result;
  try {
    const pdftoppmPath = findPdftoppm();
    const coverPageOverrides = loadCoverPageOverrides(args.dir);
    result = await processOne(pdfFile, args, pdftoppmPath, coverPageOverrides);
  } catch (e) {
    result = { file: pdfFile, error: String((e && e.message) || e) };
  }
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
  process.exitCode = result.error ? 1 : 0;
}

// Runs one book in a child process and resolves with its result. The
// child's own log is captured rather than streamed (several books at once
// would interleave unreadably); it's kept for a failure's report, and
// written to <output>/_debug/<book>/log.txt with --debug.
function runInWorker(pdfFile, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${args.memoryMb}`, __filename], {
      env: { ...process.env, [WORKER_ENV]: JSON.stringify({ pdfFile, args }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('close', (code, signal) => {
      const at = log.lastIndexOf(RESULT_MARKER);
      let result = null;
      if (at !== -1) {
        try { result = JSON.parse(log.slice(at + RESULT_MARKER.length).split('\n')[0]); } catch { result = null; }
      }
      if (!result) {
        const tail = log.trim().split('\n').slice(-3).join(' | ').slice(-300);
        result = { file: pdfFile, error: `worker exited unexpectedly (${signal || `code ${code}`})${tail ? `: ${tail}` : ''}` };
      }
      if (args.debug) {
        const dir = path.join(args.output, '_debug', slugify(path.basename(pdfFile, path.extname(pdfFile))));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'log.txt'), log, 'utf8');
      }
      resolve(result);
    });
  });
}

const formatDuration = (ms) => {
  const secs = Math.round(ms / 1000);
  return secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.dir)) {
    console.error(`[batch] input folder not found: ${args.dir}`);
    console.error(`[batch] create it and drop your PDFs in there, e.g.: mkdir -p ${args.dir}`);
    process.exit(1);
  }
  // Largest first: the big books take longest, so starting them early keeps
  // one huge PDF from running alone at the very end.
  const pdfFiles = fs.readdirSync(args.dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => path.join(args.dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  if (!pdfFiles.length) {
    console.log(`[batch] no .pdf files found in ${args.dir}`);
    return;
  }

  // The EPUB is the only output, so without Calibre there's nothing to do.
  if (!findCalibre()) {
    console.error('[batch] ebook-convert not found on PATH - install Calibre (https://calibre-ebook.com) and try again');
    process.exit(1);
  }
  const coverPageOverrides = loadCoverPageOverrides(args.dir);
  if (Object.keys(coverPageOverrides).length) {
    console.log(`[batch] cover page overrides loaded from ${path.join(args.dir, 'cover-pages.json')}:`);
    for (const [file, page] of Object.entries(coverPageOverrides)) console.log(`  - ${file} -> page ${page}`);
    if (!findPdftoppm()) console.warn('[batch] warning: pdftoppm not found - cover page overrides will be ignored, falling back to auto-detected covers');
  }

  sweepStaleWorkDirs();
  const moveProcessed = args.processed && args.processed !== 'none';
  const jobs = Math.max(1, Math.min(args.jobs, pdfFiles.length));
  console.log(`[batch] ${pdfFiles.length} PDF(s) in ${args.dir}, converting ${jobs} at a time -> ${args.output}`);

  const results = [];
  const startedAt = Date.now();
  let next = 0;
  let done = 0;
  const label = (f) => path.basename(f, path.extname(f));
  async function lane() {
    while (next < pdfFiles.length) {
      const pdfFile = pdfFiles[next++];
      const t0 = Date.now();
      console.log(`[batch] start  ${label(pdfFile)}`);
      const r = await runInWorker(pdfFile, args);
      done++;
      const tag = `[${String(done).padStart(String(pdfFiles.length).length)}/${pdfFiles.length}]`;
      if (r.error) {
        console.error(`[batch] ${tag} FAILED ${label(pdfFile)} (${formatDuration(Date.now() - t0)}): ${r.error}`);
      } else {
        console.log(`[batch] ${tag} OK     ${r.title} - ${r.pages} pages, ${r.chapters} chapters (${formatDuration(Date.now() - t0)}) -> ${r.epub}`);
        // Only once the EPUB exists: a failed book stays in the input folder
        // to be retried. A move failure (file open elsewhere, say) is only a
        // warning - the EPUB is already built.
        if (moveProcessed && !(fs.existsSync(r.epub) && fs.statSync(r.epub).size > 0)) {
          console.warn(`[batch] warning: ${r.epub} is missing or empty - leaving ${pdfFile} in ${args.dir}`);
        } else if (moveProcessed) {
          try {
            r.movedTo = moveToProcessed(pdfFile, args.processed);
          } catch (e) {
            console.warn(`[batch] warning: couldn't move ${pdfFile} to ${args.processed}: ${e.message}`);
          }
        }
      }
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: jobs }, lane));

  const failed = results.filter((r) => r.error);
  console.log(`\n[batch] === done in ${formatDuration(Date.now() - startedAt)}: ${results.length - failed.length} OK, ${failed.length} failed ===`);
  for (const r of failed) console.log(`  FAILED  ${r.file}: ${r.error} (left in ${args.dir} to retry)`);
}

if (process.env[WORKER_ENV]) {
  runWorker().catch((err) => {
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ error: String((err && err.message) || err) })}\n`);
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error('[batch] fatal error:', err);
    process.exit(1);
  });
}
