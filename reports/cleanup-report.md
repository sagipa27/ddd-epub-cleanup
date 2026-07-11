# Cleanup Report — Full Book (Phase 12)

Source: `source/book.html` (pdf2htmlEX export, 36 MB, 324 physical pages).
Output: `cleaned-html/all.xhtml` + `cleaned-html/images/*.png` (228 files) + `cleaned-html/styles/epub.css`.

This is the full-book run of the same pipeline validated on the Chapter 5 sample (see `reports/chapter5-summary.md` and `reports/chapter5-raw-vs-cleaned.diff`). Two real defects surfaced only at full-book scale and were fixed before finalizing this run (see §5).

## 1. Scale

| | Value |
|---|---|
| Pages processed | 324 / 324 (0 skipped) |
| Output file size | 975 KB (single XHTML body; source was 36 MB) |
| Body text length before / after | 813,373 / 811,499 chars (**-0.23%**, all page furniture — see §3) |
| Semantic blocks produced | `h1`: 22 · `h2`: 106 · `h3`: 159 · `p`: 1,996 · `dialogue`: 142 · `ul`: 36 · `ol`: 41 · `code`: 86 · `figure`: 228 · `figure-caption`: 128 · `attribution`: 33 · `table-like`: 84 |

## 2. Metrics (per PHASE 12/14 requirements)

| Metric | Count |
|---|---|
| Files/pages processed | 324 |
| Files/pages skipped | 0 |
| Paragraphs reconstructed (visual lines merged into `p`/`dialogue`/list-item/attribution blocks) | ~1,996 `p` + 142 `dialogue` + 33 `attribution` blocks assembled from several thousand raw one-line `<div>`s (≈16x line-fragment reduction, consistent with the Chapter 5 sample's 1,549→218 ratio) |
| Hyphenated line-breaks repaired | 703 |
| Headers/running-titles removed | 323 (one per page; page 1 is the bare cover with no header) |
| Footers removed | 0 (no separate footer band in this book — title+page number share the header line) |
| Page numbers removed | embedded in the 323 header removals above |
| Images preserved | 228 / 228 (100%) |
| Missing/broken images | 0 |
| Broken internal links/anchors | 0 |
| Remaining absolute positioning on body text | 0 |
| Manual-review items (ambiguous hyphens) | 96 |
| Manual-review items (reconstructed tables) | 84 |
| Total warnings | 180 |

Full per-item detail (every hyphen repair, every removed header string, every warning) is in `reports/cleanup-report.json`.

## 3. Text-length delta explained

-0.23% is entirely accounted for by removed page furniture (running headers + embedded page numbers) and folded-in footnote markers (digits absorbed as `<sup>` into their paragraph rather than counted twice) — not lost prose. No `significant-text-length-change` error was raised (validator threshold is ±5%).

## 4. Front matter note (not a tool defect)

`source/book.html`'s very first content page (`pf2`, right after the single-page cover `pf1`) already opens directly with "Chapter One. Crunching Knowledge" — there is no separate Foreword/Preface/Acknowledgments/Table-of-Contents page in this HTML export to preserve or lose. Verified directly against the raw source (not just the cleaned output), so this reflects what's actually inside the source file, not something the pipeline dropped.

## 5. Defects found and fixed during the full-book run

Testing at full-book scale surfaced two real bugs that hadn't shown up in the single-chapter sample (Chapter 5 has no multi-line chapter title and no mid-caption figure):

1. **Multi-line chapter/section titles were split into two separate headings.** A title that visually wraps onto a second line at heading size (e.g. "Chapter Two. Communication and the Use of" / "Language") produced two `<h1>` elements instead of one. Fixed in `lib/blocks.js` by merging consecutive same-level heading lines exactly like paragraph wraps (including hyphen repair), stopping only at a page boundary or a role change. Verified: all 17 chapter titles plus front/back-matter headings (Glossary, References, Conclusion, Photo Credits) now render as single, correctly-worded headings.
2. **A sidebar caption interrupted mid-sentence by an inline diagram left a dangling hyphen and an orphaned closing bracket.** One astrolabe sidebar splits its caption text around an embedded diagram ("...represented the views from different latitudes. Ro-" / *[image]* / "tating the rete..."); the caption-merge loop stopped at the image and left a literal trailing "-". Separately, a pattern-template sidebar splits a bracketed aside across an unusually large line gap, orphaning a lone "]" as its own one-character paragraph. Fixed in `lib/blocks.js`: (a) the caption loop now flushes hyphen-safe text before an inline figure, keeps the image exactly in place, and resumes a fresh caption block after it; (b) a lone closing-punctuation line is always merged onto the previous block instead of breaking on the vertical-gap heuristic, and text that opens with `[` without yet closing it is treated as still-open across an apparent paragraph gap. Verified against both instances directly.

Both fixes were re-verified against Chapter 5 (no regressions - identical validation result) before being applied to the full book.

## 6. Recommendation

0 validation errors book-wide; all 180 warnings are either flagged-but-correct (preserved legitimate hyphenated compounds), reconstructed tables worth a visual spot-check, or genuine one-word template labels (`Therefore:`, `Advantages`, `Disadvantages`, etc.) that are real short-paragraph content, not truncation. See `reports/cleanup-report.md` §2 and `reports/validation-report.json` for the full list.
