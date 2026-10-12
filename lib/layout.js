'use strict';

// Page-geometry passes for the generic PDF path (lib/pdfPipeline.js). The
// text layer alone loses a lot of a book's structure - bullets, sidebars
// and table grids are usually *drawn* (vector shapes, see
// lib/pdfIngest.js#extractPageShapes), not typed - so these passes read the
// shapes back and annotate/replace the merged visual lines accordingly,
// before lib/blocks.js groups them into semantic blocks. All of it works in
// page space (bottom-left origin, y up), the same as every text line.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Some PDFs set captions in a column only one glyph wide, so "Table 8-1.
// OrderDetail" arrives as a vertical stack of one- or two-character lines,
// all at the same x and a constant pitch. Fold each such stack back into one
// line; a pitch gap well above the stack's own marks a word break.
function joinVerticalStacks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i];
    const isGlyph = (l) => !l.isFigure && l.text.trim().length > 0 && l.text.trim().length <= 2;
    let j = i;
    while (j + 1 < lines.length && isGlyph(lines[j]) && isGlyph(lines[j + 1]) &&
      Math.abs(lines[j + 1].x - start.x) < 0.5 && lines[j].y > lines[j + 1].y) j++;
    if (j - i + 1 < 4) { out.push(start); i++; continue; }
    const stack = lines.slice(i, j + 1);
    const pitches = stack.slice(1).map((l, k) => stack[k].y - l.y);
    const pitch = Math.min(...pitches);
    // A word break shows either as a wider pitch or as a space character
    // riding along on the previous glyph's line.
    let text = stack[0].text.trim();
    stack.slice(1).forEach((l, k) => {
      const brk = pitches[k] > pitch * 1.5 || /\s$/.test(stack[k].text) || /^\s/.test(l.text);
      text += (brk ? ' ' : '') + l.text.trim();
    });
    const italic = stack.filter((l) => l.italicShare > 0.5).length > stack.length / 2;
    const bold = stack.filter((l) => l.boldShare > 0.5).length > stack.length / 2;
    let html = escapeHtml(text);
    if (italic) html = `<em>${html}</em>`;
    if (bold) html = `<strong>${html}</strong>`;
    out.push({
      ...start, text, html, endX: null, parts: null,
      italicShare: italic ? 1 : 0, boldShare: bold ? 1 : 0, monoShare: 0,
      // Word breaks inside a stack are unreliable (see lib/blocks.js, which
      // repairs them once a caption split over a page turn is whole again).
      stacked: true,
    });
    i = j + 1;
  }
  return out;
}

// A drawn bullet sits just left of its item's first line, vertically
// within that line's glyph box.
function markBullets(lines, dots) {
  for (const d of dots) {
    const cy = (d.y0 + d.y1) / 2;
    let best = null;
    for (const l of lines) {
      if (l.isFigure || l.isTable) continue;
      const dx = l.x - d.x1;
      if (dx < 0.5 || dx > 4 * l.fs) continue;
      if (cy < l.y - 0.3 * l.fs || cy > l.y + 0.9 * l.fs) continue;
      if (!best || dx < best.dx) best = { l, dx };
    }
    if (best) best.l.bulletMarker = true;
  }
}

const inRect = (r, x, y, pad = 2) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;

// Tags every line (and figure) that sits inside a shaded/outlined box with
// that box, so lib/blocks.js can render it as a sidebar. Boxes that only
// hold a code listing (a shaded code background) or a table are ignored -
// those already have their own rendering.
function assignBoxes(lines, figures, boxes, rules, pageIdx) {
  // A box is often drawn twice (fill + outline stroke) at the same spot.
  const unique = [];
  for (const b of boxes) {
    if (!unique.some((u) => Math.abs(u.x0 - b.x0) < 3 && Math.abs(u.x1 - b.x1) < 3 && Math.abs(u.y0 - b.y0) < 3 && Math.abs(u.y1 - b.y1) < 3)) unique.push(b);
  }
  unique.forEach((box, idx) => {
    const inside = lines.filter((l) => !l.isFigure && inRect(box, l.x, l.y) && (l.endX == null || l.endX <= box.x1 + 2));
    if (!inside.length) return;
    if (inside.every((l) => l.monoShare >= 0.9 || !l.text.trim())) return;
    if (rules.some((r) => inRect(box, r.x0, r.y, 0) && inRect(box, r.x1, r.y, 0))) return;
    const key = `${pageIdx}:${idx}`;
    for (const l of inside) {
      // Innermost box wins when boxes nest.
      if (!l.box || (l.box.x1 - l.box.x0) * (l.box.y1 - l.box.y0) > (box.x1 - box.x0) * (box.y1 - box.y0)) {
        l.box = box; l.boxKey = key;
      }
    }
    for (const f of figures) {
      if (inRect(box, f.x, f.topEdgeBottomAnchored) && inRect(box, f.x, f.bottomEdgeBottomAnchored)) {
        f.box = box; f.boxKey = key;
      }
    }
  });
}

// Tables are drawn as a grid of thin filled rules, one per cell edge. Each
// horizontal band between two distinct rule heights is one row (or several,
// when the table only rules its header), and the rule segments bounding a
// band give that band's own column boundaries - header and body rows can
// be divided differently, so each band uses the rules directly below it.
// Replaces every text line inside a table's region with one synthetic
// { isTable, rows } line, placed where the table's first line was.
function buildTables(lines, rules) {
  if (rules.length < 4) return lines;
  const sorted = [...rules].sort((a, b) => b.y - a.y);
  // Cell edges only touch end to end, so "overlapping" allows a little slack;
  // groups that grow into each other afterwards are merged.
  const touches = (a, b) => a.x0 <= b.x1 + 2 && a.x1 >= b.x0 - 2;
  let groups = [];
  for (const r of sorted) {
    const g = groups.find((gr) => touches(r, gr) && gr.yMin - r.y < 250);
    if (g) {
      g.rules.push(r);
      g.x0 = Math.min(g.x0, r.x0); g.x1 = Math.max(g.x1, r.x1); g.yMin = Math.min(g.yMin, r.y);
    } else {
      groups.push({ rules: [r], x0: r.x0, x1: r.x1, yMax: r.y, yMin: r.y });
    }
  }
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const A = groups[a], B = groups[b];
        if (touches(A, B) && A.yMin - B.yMax < 250 && B.yMin - A.yMax < 250) {
          A.rules.push(...B.rules);
          A.x0 = Math.min(A.x0, B.x0); A.x1 = Math.max(A.x1, B.x1);
          A.yMin = Math.min(A.yMin, B.yMin); A.yMax = Math.max(A.yMax, B.yMax);
          groups.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  groups = groups.filter((g) => g.rules.length >= 4);
  let out = lines;
  for (const g of groups) {
    const ys = [];
    for (const r of g.rules.map((q) => q.y).sort((a, b) => b - a)) {
      if (!ys.length || ys[ys.length - 1] - r > 1) ys.push(r);
    }
    if (ys.length < 2 || g.x1 - g.x0 < 40) continue;
    const inTable = (l) => !l.isFigure && !l.isTable && l.parts &&
      l.y <= g.yMax + 1 && l.y >= g.yMin - 1 && l.x >= g.x0 - 3 && l.x <= g.x1;
    const tableLines = out.filter(inTable);
    if (!tableLines.length) continue;

    const rows = [];
    for (let b = 0; b < ys.length - 1; b++) {
      const top = ys[b], bottom = ys[b + 1];
      const bandLines = tableLines.filter((l) => l.y < top && l.y >= bottom);
      if (!bandLines.length) continue;
      // Segments are often drawn twice; one per column edge.
      const bounding = (y) => g.rules.filter((r) => Math.abs(r.y - y) <= 1).sort((a, c) => a.x0 - c.x0)
        .filter((r, k, arr) => k === 0 || r.x0 - arr[k - 1].x0 > 1);
      let segs = bounding(bottom);
      if (!segs.length) segs = bounding(top);
      if (!segs.length) continue;
      const cols = segs.map((s) => s.x0);
      const colOf = (x) => {
        let c = 0;
        for (let k = 0; k < cols.length; k++) if (x >= cols[k] - 1) c = k;
        return c;
      };
      const parts = [];
      for (const l of bandLines) {
        for (const p of l.parts) if (p.text.trim()) parts.push({ ...p, y: l.y, col: colOf(p.x), mono: l.monoShare >= 0.9 });
      }
      // Several rows inside one band: every first-column line that other
      // columns also have text beside starts a new row.
      const col0Ys = [...new Set(parts.filter((p) => p.col === 0).map((p) => p.y.toFixed(1)))].map(Number).sort((a, c) => c - a);
      const rowStarts = col0Ys.filter((y) => parts.some((p) => p.col > 0 && Math.abs(p.y - y) < 1));
      const starts = rowStarts.length > 1 ? rowStarts : [top];
      const header = parts.length > 0 && parts.every((p) => /<strong>/.test(p.html));
      starts.forEach((startY, k) => {
        const endY = k + 1 < starts.length ? starts[k + 1] : -Infinity;
        const rowParts = parts.filter((p) => (k === 0 || p.y <= startY + 1) && p.y > endY + 1);
        const cells = cols.map((_, c) => {
          // Parts within a few points vertically share a text line - that
          // tolerance keeps a raised footnote marker ("latency^a") on its
          // own line, in left-to-right order, instead of a line above.
          const cp = rowParts.filter((p) => p.col === c).sort((a, d) => d.y - a.y || a.x - d.x);
          const lineGroups = [];
          for (const p of cp) {
            const g = lineGroups[lineGroups.length - 1];
            if (g && Math.abs(g[0].y - p.y) < 5.5) g.push(p); else lineGroups.push([p]);
          }
          const byLine = lineGroups.map((g) => {
            g.sort((a, d) => a.x - d.x);
            const base = Math.min(...g.map((p) => p.y));
            const ln = { y: base, html: '', endX: null, mono: g.every((p) => p.mono) };
            for (const p of g) {
              const raised = p.y > base + 1 && p.text.trim().length <= 2 && ln.html;
              const piece = raised ? `<sup>${p.text.trim()}</sup>` : p.html;
              ln.html += (ln.endX != null && p.x - ln.endX > 1 && !raised ? ' ' : '') + piece;
              ln.endX = p.endX;
            }
            return ln;
          });
          const multiLineCode = byLine.length > 1 && byLine.every((ln) => ln.mono || /^<code>/.test(ln.html));
          return byLine.map((ln) => ln.html).join(multiLineCode ? '<br/>' : ' ');
        });
        while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
        if (cells.some((c) => c)) rows.push({ header, cells });
      });
    }
    if (!rows.length) continue;
    const firstIdx = out.findIndex(inTable);
    const tableLine = {
      isTable: true, rows, x: g.x0, y: g.yMax, fs: tableLines[0].fs, text: '', html: '',
      domIndex: tableLines[0].domIndex,
    };
    out = out.filter((l) => !inTable(l));
    out.splice(Math.min(firstIdx, out.length), 0, tableLine);
  }
  return out;
}

// Some books set whole chapters at a different scale (e.g. 10pt body text
// in a 15pt book - typically a chapter produced separately and merged in),
// which makes every font-size threshold misfire there: section headings
// read as captions, the chapter title as a sub-heading, and the tighter
// leading defeats the paragraph-break test. Such pages are recognizable as
// a run of consecutive pages with no body-size text whose dominant size
// never occurs on ordinary pages (unlike endnote pages, whose small size
// also appears as footnotes elsewhere). Font sizes and vertical distances
// on those pages are rescaled to the body size, about each page's top.
function normalizeScaledPages(keptPerPage, pages, bodySize, eps) {
  const bucket = (fs) => Math.round(fs * 4) / 4;
  const pageStats = keptPerPage.map((lines) => {
    const vol = new Map();
    let total = 0;
    for (const l of lines) {
      if (l.isFigure || l.isTable || !l.text) continue;
      const n = l.text.replace(/\s/g, '').length;
      vol.set(bucket(l.fs), (vol.get(bucket(l.fs)) || 0) + n);
      total += n;
    }
    const bodyChars = [...vol.entries()].filter(([s]) => Math.abs(s - bodySize) <= eps).reduce((n, [, c]) => n + c, 0);
    const dominant = [...vol.entries()].sort((a, b) => b[1] - a[1])[0];
    return { vol, total, bodyShare: total ? bodyChars / total : 0, dominant: dominant ? dominant[0] : null };
  });
  const normalVol = new Map();
  let normalTotal = 0;
  pageStats.filter((s) => s.bodyShare >= 0.2).forEach((s) => {
    for (const [size, c] of s.vol) { normalVol.set(size, (normalVol.get(size) || 0) + c); normalTotal += c; }
  });
  const isNormalSize = (size) => (normalVol.get(size) || 0) >= normalTotal * 0.005;
  const candidate = pageStats.map((s) => s.total >= 30 && s.bodyShare < 0.03 && s.dominant != null && !isNormalSize(s.dominant));
  // Nearly-empty pages (a full-page figure, a table in a size used nowhere
  // else) say nothing either way; they don't break a run of scaled pages.
  const neutral = pageStats.map((s) => s.bodyShare < 0.03 && (s.total < 30 || !isNormalSize(s.dominant)));

  const regions = [];
  for (let i = 0; i < candidate.length; i++) {
    if (!candidate[i]) continue;
    let j = i;
    while (j + 1 < candidate.length && (candidate[j + 1] || neutral[j + 1])) j++;
    while (j > i && !candidate[j]) j--;
    if (j - i + 1 >= 3) regions.push([i, j]);
    i = j;
  }
  const applied = [];
  for (const [a, b] of regions) {
    const vol = new Map();
    for (let p = a; p <= b; p++) for (const [s, c] of pageStats[p].vol) vol.set(s, (vol.get(s) || 0) + c);
    const regionBody = [...vol.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const scale = bodySize / regionBody;
    if (scale < 1.15 && scale > 0.87) continue;
    // The signature of a genuinely rescaled chapter: its own headings, scaled
    // back, land on the book's normal heading sizes (20pt x1.5 = the 30pt
    // chapter-title size). Small-print back matter (index, glossary) and
    // cover pages have no such echo, so they're left alone.
    const normalHeadingSizes = [...normalVol.entries()]
      .filter(([s, c]) => s > bodySize + eps && c >= normalTotal * 0.0005).map(([s]) => s);
    const echoes = [...vol.keys()].filter((s) => s > regionBody + eps &&
      normalHeadingSizes.some((h) => Math.abs(s * scale - h) <= Math.max(eps, h * 0.03)));
    // Two echoes, not one: a single size lining up after scaling happens by
    // chance on index pages; a rescaled chapter echoes its whole hierarchy.
    if (echoes.length < 2) continue;
    for (let p = a; p <= b; p++) {
      const lines = keptPerPage[p];
      const figs = pages[p].figures;
      const top = Math.max(...lines.map((l) => l.y), ...figs.map((f) => f.topEdgeBottomAnchored), 0);
      const sy = (y) => top - (top - y) * scale;
      for (const l of lines) {
        l.y = sy(l.y);
        if (l.fs) l.fs *= scale;
        if (l.h) l.h *= scale;
      }
      for (const f of figs) {
        f.topEdgeBottomAnchored = sy(f.topEdgeBottomAnchored);
        f.bottomEdgeBottomAnchored = sy(f.bottomEdgeBottomAnchored);
      }
    }
    applied.push({ pages: [pages[a].pageNo, pages[b].pageNo], scale: Math.round(scale * 1000) / 1000 });
  }
  return applied;
}

// Consecutive boxed lines belong to one sidebar while they stay in the same
// box, or when a box simply carries over the page turn (the last line of
// one page and the first line of the next are both boxed).
function assignBoxGroups(lines) {
  let group = 0;
  let prev = null;
  for (const l of lines) {
    if (!l.boxKey) { prev = l; continue; }
    const continues = prev && prev.boxKey && (prev.boxKey === l.boxKey || prev.pageIdx === l.pageIdx - 1);
    if (!continues) group++;
    l.boxGroup = group;
    prev = l;
  }
}

module.exports = { joinVerticalStacks, markBullets, assignBoxes, buildTables, normalizeScaledPages, assignBoxGroups };
