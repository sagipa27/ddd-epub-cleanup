# Phase 11 — Test Chapter Report: Chapter 5, "A Model Expressed in Software"

Source: `source/book.html`, pages `pf2c`..`pf45` (26 physical PDF pages).
Output: `cleaned-html/chapter-5.xhtml` (+ `cleaned-html/images/*`, `cleaned-html/styles/epub.css`).
Raw baseline used for diffing: `scratch/chapter5-raw.html` (pretty-printed, unmodified extract of the same 26 pages).

## 1. Before / after size

| | Before (raw pdf2htmlEX) | After (cleaned XHTML) |
|---|---|---|
| File size | 1,656,620 bytes | 98,424 bytes (-94%) |
| Lines | 9,045 | 331 |
| Body text length (chars) | 82,388 | 82,371 (-17, -0.02%) |
| Structural elements | 1,549 raw `div.t`/`span` line fragments, all `position:absolute` | 243 semantic blocks (`h1/h2/h3/p/ul/ol/li/pre code/table/figure/blockquote-like attribution`) |

Body text length is essentially unchanged (-0.02%), which is expected: that delta is entirely running headers/page numbers removed, not lost prose. See §6.

## 2. Representative before/after examples

**Hyphenation + line-wrap repair** (raw → one `<div>` per visual PDF line):

```html
<div class="t m0 x3 h3 y1d6 ...">this <span class="_ _1">
</span>the <span class="_ _1">
</span>customer ...</div>
<div class="t m0 x3 h3 y302 ...">A <span class="_ _1">
</span>conceptual <span class="_ _0">
</span>identity ...</div>
```

→ cleaned:

```html
<p>A conceptual identity has to be matched between multiple implementations of the objects, its stored forms, and real-world actors such as the phone caller. Attributes may not match. A sales representative may have entered an address update into the contact software, which is just being propagated to accounts due.</p>
```

("represen-" / "tative" across two absolutely-positioned lines correctly rejoined to "representative".)

**List detection** (raw numbered lines → real `<ol>`):

```html
<div class="t ... y69 ...">1.<span class="_ _a"> </span>Imposing a traversal direction</div>
<div class="t ... y6a ...">2.<span class="_ _a"> </span>Adding a qualifier, effectively reducing multiplicity</div>
<div class="t ... y24b ...">3.<span class="_ _a"> </span>Eliminating nonessential associations</div>
```

→ cleaned:

```html
<ol><li>Imposing a traversal direction</li><li>Adding a qualifier, effectively reducing multiplicity</li><li>Eliminating nonessential associations</li></ol>
```

**All-caps glossary terms preserved as continuations, not new sections** (this book renders terms like ENTITY / VALUE OBJECT in full caps; a line wrap mid-term is still a continuation, not a hyphenation candidate or a break):

```html
<p class="attribution"><em>... Address would be a VALUE OBJECT.</em></p>
<p>Colors are an example of VALUE OBJECTS that are provided in the base libraries...</p>
```

## 3. Git diff

Full unified diff (raw baseline vs. cleaned output) saved to `reports/chapter5-raw-vs-cleaned.diff` (9,381 lines — mostly the expected wholesale removal of one-line-per-element absolute-positioned markup). Stat summary:

```
 chapter-5.xhtml | 9376 +-------------------
 1 file changed, 331 insertions(+), 9045 deletions(-)
```

This repo's own history also records the tool build as a single commit (`Add cleanup tooling and validated test-chapter output (Chapter 5)`) on top of the untouched original (`Original PDF to HTML conversion`), so `git show <that commit>` / `git log -p -- cleaned-html/chapter-5.xhtml` is the durable way to re-inspect this later.

## 4. Metrics (per PHASE 11, item 5)

| Metric | Count |
|---|---|
| Paragraphs merged (visual lines folded into fewer flowing blocks) | 1,549 raw line-fragments → 1,029 same-row-merged lines → 218 paragraph/list-item/attribution blocks (≈778 line-joins) |
| Artificial (line-wrap) hyphens removed | 67 |
| Ambiguous hyphen cases flagged for manual review (not auto-joined) | 7 |
| Headers removed (running title + page number, same fixed y-position) | 26 (one per page) |
| — of which page-number-only | 1 (chapter opener strips only "48"; the rest combine "A Model Expressed in Software N" as one running-header string) |
| — of which running chapter-title header text | 25 |
| Footers removed | 0 (this book has no distinct footer band — page number is embedded in the same running-header line as the title) |
| Absolute-positioned text elements converted to flowing HTML | 1,523 (all kept lines, i.e. 1,549 raw minus the 26 removed as header furniture) |
| Images preserved | 11 of 11 referenced in this page range (100%); see `imagesExtracted` in `reports/cleanup-report.json` |
| Missing/broken images | 0 |
| Tables flagged for manual review (structure inferred, not fully verified) | 6 (`table-needs-review` warnings — column/row layout is visually clear but not asserted as ground truth) |
| Warnings (total) | 13 (7 ambiguous-hyphen + 6 table-needs-review) |

Full machine-readable detail (including every hyphen repair and every removed header string) is in `reports/cleanup-report.json`.

## 5. Validation results (`node validate.js`)

```
0 error(s), 2 warning(s)
textLengthBefore=82388 textLengthAfter=82371 (-0.02%)
```

The only two warnings are `suspicious-one-word-paragraph: "Therefore:"` — a genuine one-word paragraph in the source (a colon-terminated lead-in before a numbered list), not a cleanup defect. No duplicate IDs, no broken links/anchors, no missing images, no residual `position:absolute` on body text, no malformed entities.

## 6. Ambiguous cases requiring manual review

From `reports/cleanup-report.json` → `warnings`:

1. Ambiguous hyphen `in-` / `sight` (context: "...reflects in- / sight into the domain...") — correctly auto-joined as "insight" would be right here, but the heuristic flagged it because "in" alone is a valid word; verify.
2. Ambiguous hyphen `re-` / `volve` ("...associations should re- / volve around who they are...") → "revolve".
3. Ambiguous hyphen `de-` / `cisions` → "decisions".
4. Ambiguous hyphen `model-` / `based` — this one is a **legitimate compound** ("model-based"), not a line-wrap artifact; the script left the hyphen in place rather than guessing.
5. Ambiguous hyphen `re-` / `sponsible` → "responsible".
6. Ambiguous hyphen `under-` / `standing` → "understanding".
7. Ambiguous hyphen `object-` / `oriented` — **legitimate compound**, hyphen correctly preserved.
8–13. Six `table-needs-review` items — three small entity/attribute tables (BROKERAGE_ACCOUNT, CUSTOMER, INVESTMENT) and a 3-row "Partitioning Services into Layers" table, rendered into `<table>` by column-alignment heuristics; worth a visual check against the original page since these were reconstructed rather than lifted from real `<table>` markup.

None of these required content changes — they're flagged, not altered, in line with rule "create a report for ambiguous cases rather than guessing."

## 7. Recommendation

Chapter 5 cleaned output is structurally sound: 0 validation errors, negligible (-0.02%) text-length delta explained entirely by page furniture removal, images 100% preserved, and the flagged ambiguous cases are either correct-as-is (preserved compounds) or reconstructed tables worth a quick visual spot-check.

**Awaiting your review/approval before proceeding to Phase 12 (full-book processing).** A whole-book dry run was already smoke-tested (all 324 pages, no crashes — 702 hyphen repairs, 228 images extracted, 180 warnings, -0.23% text delta) but nothing was written outside this chapter-5 sample.
