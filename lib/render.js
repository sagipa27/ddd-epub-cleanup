'use strict';

// Headings are bold by stylesheet already; a <strong> wrapped around (parts
// of) a heading's text is just the PDF's font weight leaking through, and
// makes some Kindle fonts render it double-heavy.
const headingHtml = (html) => html.replace(/<\/?strong>/g, '');

function renderTable(b) {
  // A row with fewer cells than the table (typically a table footnote
  // under the grid) spans the rest, rather than squeezing into column one
  // and stretching it for every other row.
  const width = Math.max(...b.rows.map((r) => r.cells.length));
  const rows = b.rows.map((r) => {
    const tag = r.header ? 'th' : 'td';
    return `<tr>${r.cells.map((c, k) => {
      const span = k === r.cells.length - 1 && r.cells.length < width ? ` colspan="${width - k}"` : '';
      return `<${tag}${span}>${c}</${tag}>`;
    }).join('')}</tr>`;
  });
  const caption = b.caption ? `<caption>${b.caption}</caption>` : '';
  return `<table>${caption}${rows.join('')}</table>`;
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'h1': out.push(`<h1>${headingHtml(b.html)}</h1>`); break;
      case 'h2': out.push(`<h2>${headingHtml(b.html)}</h2>`); break;
      case 'h3': out.push(`<h3>${headingHtml(b.html)}</h3>`); break;
      case 'h4': out.push(`<h4>${headingHtml(b.html)}</h4>`); break;
      case 'h5': out.push(`<h5>${headingHtml(b.html)}</h5>`); break;
      case 'p': out.push(`<p>${b.html}</p>`); break;
      case 'dialogue': out.push(`<p class="dialogue">${b.html}</p>`); break;
      case 'attribution': out.push(`<p class="attribution"><em>${b.html}</em></p>`); break;
      case 'caption': out.push(`<p class="caption">${b.html}</p>`); break;
      case 'figure-caption':
        // Attach to the immediately preceding <figure> if there is one and
        // it doesn't have a caption yet; otherwise render as its own note.
        out.push({ pendingCaption: b.html });
        break;
      case 'ul':
        out.push(`<ul>${b.items.map((it) => `<li>${it}</li>`).join('')}</ul>`);
        break;
      case 'ol':
        out.push(`<ol>${b.items.map((it) => `<li>${it}</li>`).join('')}</ol>`);
        break;
      case 'dl':
        out.push(`<dl>${b.items.map((it) => `<dt>${it.term}</dt>${it.bodies.map((d) => `<dd>${d}</dd>`).join('')}`).join('')}</dl>`);
        break;
      case 'code':
        out.push(`<pre><code>${b.lines.join('\n')}</code></pre>`);
        break;
      case 'table-like':
        out.push(`<pre class="table-like">${b.lines.join('\n')}</pre>`);
        break;
      case 'table':
        out.push(renderTable(b));
        break;
      case 'aside-start':
        // A <div>, not <aside>: older Kindle renderers drop unknown HTML5
        // sectioning elements' styling.
        out.push(`<div class="${b.kind || 'sidebar'}">${b.title ? `<p class="box-title">${headingHtml(b.title)}</p>` : ''}`);
        break;
      case 'aside-end':
        out.push('</div>');
        break;
      case 'figure':
        out.push(`<figure><img src="${b.src}" alt="${b.alt || ''}"/>${b.caption ? `<figcaption>${b.caption}</figcaption>` : ''}</figure>`);
        break;
      default:
        if (b.html) out.push(`<p>${b.html}</p>`);
    }
  }

  // Resolve pending captions onto the closest preceding <figure>.
  const resolved = [];
  for (const item of out) {
    if (typeof item === 'object' && item.pendingCaption) {
      const lastFigureIdx = resolved.map((s) => /<figure>/.test(s)).lastIndexOf(true);
      if (lastFigureIdx !== -1 && !/<figcaption>/.test(resolved[lastFigureIdx])) {
        resolved[lastFigureIdx] = resolved[lastFigureIdx].replace(
          '</figure>', `<figcaption>${item.pendingCaption}</figcaption></figure>`
        );
      } else {
        resolved.push(`<p class="caption">${item.pendingCaption}</p>`);
      }
      continue;
    }
    resolved.push(item);
  }
  // Adjacent runs of the same inline style ("<code>SELECT</code>
  // <code>*</code>", one per PDF text run) read as one run.
  return resolved.join('\n').replace(/<\/(strong|em|code)>(\s*)<\1>/g, '$2');
}

function wrapXhtml(title, bodyHtml, cssPath) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<link rel="stylesheet" type="text/css" href="${cssPath}"/>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

module.exports = { renderBlocks, wrapXhtml };
