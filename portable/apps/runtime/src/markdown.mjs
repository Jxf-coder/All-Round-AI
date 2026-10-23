// ---------------------------------------------------------------------------
// Markdown rendering for assistant replies.
//
// This is a small, dependency-free subset that mirrors the reference renderer:
// headings, paragraphs, lists, quotes, rules, fenced code, tables, inline code,
// bold and safe links. Every piece of text is escaped before it is wrapped, so
// raw HTML in a reply is shown as text instead of being executed.
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]);
}

function listMatch(line) {
  const match = /^( *)([-+*]|\d+[.)])[ \t]+(.*)$/u.exec(line);
  return match
    ? { indent: match[1].length, ordered: /^\d/u.test(match[2]), marker: match[2], body: match[3] }
    : null;
}

function fenceMatch(line) {
  return /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
}

function headingMatch(line) {
  return /^ {0,3}(#{1,6})[ \t]+(.+)$/u.exec(line);
}

function isRule(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(line);
}

// Pipes escaped with a backslash or inside inline code do not split cells.
function tableCells(line) {
  const value = String(line).trim();
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char === "`") inCode = !inCode;
    if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  if (value.startsWith("|")) cells.shift();
  if (value.endsWith("|") && !value.endsWith("\\|")) cells.pop();
  return cells;
}

function tableHeader(lines, index) {
  if (!lines[index]?.includes("|") || !lines[index + 1]?.includes("|")) return null;
  const headers = tableCells(lines[index]);
  const separators = tableCells(lines[index + 1]);
  if (!headers.length || separators.length !== headers.length
    || !separators.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    return null;
  }
  return {
    headers,
    aligns: separators.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center"
      : cell.endsWith(":") ? "right" : "left")),
  };
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function renderInline(text, depth = 0) {
  if (depth > 5) return escapeHtml(text);
  let output = "";
  const pattern = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/giu;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) output += escapeHtml(text.slice(last, match.index));
    if (match[1]) {
      output += `<code>${escapeHtml(match[1].slice(1, -1))}</code>`;
    } else if (match[2]) {
      output += `<strong>${renderInline(match[2].slice(2, -2), depth + 1)}</strong>`;
    } else if (match[3] && match[4]) {
      const url = safeLink(match[4]);
      const label = match[3].slice(1, match[3].indexOf("]"));
      output += url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${renderInline(label, depth + 1)}</a>`
        : escapeHtml(match[0]);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) output += escapeHtml(text.slice(last));
  return output;
}

function startsBlock(lines, index) {
  const line = lines[index];
  return Boolean(fenceMatch(line) || headingMatch(line) || /^ {0,3}>/u.test(line)
    || listMatch(line) || isRule(line) || tableHeader(lines, index));
}

function renderBlocks(lines, depth = 0) {
  if (depth > 6) return `<p>${renderInline(lines.join("\n"))}</p>`;
  let output = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceMatch(line);
    if (fence) {
      const marker = fence[1];
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "u");
      const code = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const language = fence[2].trim().split(/\s+/u)[0];
      const languageAttribute = /^[\w+-]{1,30}$/u.test(language)
        ? ` data-language="${escapeHtml(language)}"` : "";
      output += `<pre class="mdx-code-block"><code${languageAttribute}>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      const level = heading[1].length;
      output += `<h${level}>${renderInline(heading[2].replace(/[ \t]+#+[ \t]*$/u, ""))}</h${level}>`;
      index += 1;
      continue;
    }

    if (isRule(line)) {
      output += "<hr>";
      index += 1;
      continue;
    }

    if (/^ {0,3}>/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/u.test(lines[index])) {
        quote.push(lines[index++].replace(/^ {0,3}>[ \t]?/u, ""));
      }
      output += `<blockquote>${renderBlocks(quote, depth + 1)}</blockquote>`;
      continue;
    }

    const table = tableHeader(lines, index);
    if (table) {
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim()
        && lines[index].includes("|") && !fenceMatch(lines[index])) {
        rows.push(tableCells(lines[index++]));
      }
      // Alignment travels as a data attribute: the runtime CSP forbids inline
      // styles, and the stylesheet maps the three values to text-align.
      const head = table.headers
        .map((header, column) => `<th scope="col" data-align="${table.aligns[column]}">${renderInline(header)}</th>`)
        .join("");
      const body = rows.map((row) => `<tr>${table.headers
        .map((_, column) => `<td data-align="${table.aligns[column]}">${renderInline(row[column] || "")}</td>`)
        .join("")}</tr>`).join("");
      output += `<div class="mdx-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0">`
        + `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }

    const list = listMatch(line);
    if (list) {
      const items = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || item.indent !== list.indent || item.ordered !== list.ordered) break;
        const itemLines = [item.body];
        index += 1;
        while (index < lines.length) {
          const next = lines[index];
          const nextItem = listMatch(next);
          if (nextItem && nextItem.indent <= list.indent) break;
          if (!next.trim()) {
            const following = lines[index + 1];
            const followingIndent = following ? /^ */u.exec(following)[0].length : 0;
            if (following && followingIndent > list.indent) {
              itemLines.push("");
              index += 1;
              continue;
            }
            break;
          }
          const indentation = /^ */u.exec(next)[0].length;
          if (indentation <= list.indent) break;
          itemLines.push(next.slice(Math.min(indentation, list.indent + item.marker.length + 1)));
          index += 1;
        }
        items.push(`<li>${renderBlocks(itemLines, depth + 1)}</li>`);
        if (!lines[index]?.trim()) {
          const nextItem = listMatch(lines[index + 1] || "");
          if (nextItem?.indent === list.indent && nextItem.ordered === list.ordered) index += 1;
          else break;
        }
      }
      const start = list.ordered ? Number.parseInt(list.marker, 10) : null;
      const attributes = start && start !== 1 ? ` start="${start}"` : "";
      output += list.ordered ? `<ol${attributes}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index++]);
    }
    output += `<p>${renderInline(paragraph.join("\n"))}</p>`;
  }
  return output;
}

export function renderMarkdownHtml(text) {
  if (!text) return "";
  return renderBlocks(String(text).replace(/\r\n?/gu, "\n").split("\n"));
}

// The workbench is a classic script, so the module publishes the renderer on
// the global object; the fallback there keeps plain text if it is missing.
if (typeof globalThis !== "undefined") {
  globalThis.AllRoundMarkdown = Object.freeze({ toHtml: renderMarkdownHtml });
}
