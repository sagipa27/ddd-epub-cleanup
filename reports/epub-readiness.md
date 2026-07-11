# Phase 14 — EPUB Readiness Report

## Verdict: **Ready for EPUB conversion**, with 180 flagged items suggested for a human spot-check (none blocking).

## Checklist

| # | Item | Result |
|---|---|---|
| 1 | Source files inspected | 1 (`source/book.html`, 36 MB, 324 pages) |
| 2 | Files/pages processed | 324 / 324 |
| 3 | Files/pages skipped | 0 |
| 4 | Files/pages with warnings | pages contributing to 180 warnings across the book (see `reports/cleanup-report.json`) |
| 5 | Paragraphs reconstructed | 1,996 `<p>` + 142 `<p class="dialogue">` + 33 `<p class="attribution">` blocks assembled from thousands of raw one-line PDF `<div>`s |
| 6 | Hyphenated line-breaks repaired | 703 |
| 7 | Headers/footers removed | 323 running-header lines removed; 0 separate footers (none exist in this book's layout) |
| 8 | Page numbers removed | included in the 323 above (embedded in the same header line as the running title) |
| 9 | Images preserved | 228 / 228 (100%) |
| 10 | Missing images | 0 |
| 11 | Broken links/anchors | 0 |
| 12 | Remaining absolute positioning on body text | 0 |
| 13 | Remaining suspicious fragments | 49 one-word/one-char paragraphs — all verified genuine short labels (`Therefore:`, `Advantages`, `Disadvantages`, `Schedules`, `Validation`, `Subsumption`, `Finishing:`), not truncation |
| 14 | Manual-review items | 96 ambiguous-hyphen decisions (7 of which are correctly-preserved compounds like `model-based`, `object-oriented` — the rest were safely auto-joined) + 84 reconstructed tables worth a visual spot-check |
| 15 | Recommended EPUB conversion command | see below |

## Recommended conversion command

Calibre's `ebook-convert` is installed (`C:\Program Files\Calibre2\ebook-convert.exe`). Recommended invocation, run from the project root:

```bash
ebook-convert cleaned-html/all.xhtml cleaned-html/domain-driven-design.epub \
  --title "Domain-Driven Design: Tackling Complexity in the Heart of Software" \
  --authors "Eric Evans" \
  --language en \
  --cover cleaned-html/images/pf1-fig1.png \
  --chapter "//*[name()='h1']" \
  --level1-toc "//*[name()='h1']" \
  --level2-toc "//*[name()='h2']" \
  --page-breaks-before "//*[name()='h1']" \
  --embed-all-fonts \
  --extra-css styles/epub.css
```

Notes:
- `--cover` points at the extracted front-cover image (`images/pf1-fig1.png`, the only content on physical page 1).
- `--chapter`/`--level1-toc`/`--level2-toc` split at the 22 `<h1>`s (17 numbered chapters + Conclusion + The Use of Patterns in This Book + Glossary + References + Photo Credits) and nest `<h2>`s underneath in the TOC.
- Title/author are supplied explicitly since the source HTML's own `<title>` is empty and it carries no author metadata — taken from the original filename (`Domain Driven Design Tackling Complexity in the Heart of Software - Eric Evans.html`); confirm these before finalizing.
- Not run yet, per instructions — only provided here for your review/approval.
