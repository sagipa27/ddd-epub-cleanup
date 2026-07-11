'use strict';

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'h1': out.push(`<h1>${b.html}</h1>`); break;
      case 'h2': out.push(`<h2>${b.html}</h2>`); break;
      case 'h3': out.push(`<h3>${b.html}</h3>`); break;
      case 'p': out.push(`<p>${b.html}</p>`); break;
      case 'dialogue': out.push(`<p class="dialogue">${b.html}</p>`); break;
      case 'attribution': out.push(`<p class="attribution"><em>${b.html}</em></p>`); break;
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
      case 'code':
        out.push(`<pre><code>${b.lines.join('\n')}</code></pre>`);
        break;
      case 'table-like':
        out.push(`<pre class="table-like">${b.lines.join('\n')}</pre>`);
        break;
      case 'figure':
        out.push(`<figure><img src="${b.src}" alt="${b.alt || ''}"/></figure>`);
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
  return resolved.join('\n');
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
