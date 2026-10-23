import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderMarkdownHtml } from "../src/markdown.mjs";

test("plain paragraphs keep line breaks and escape raw HTML", () => {
  assert.equal(renderMarkdownHtml("第一行\n第二行\n\n新段落"), "<p>第一行\n第二行</p><p>新段落</p>");
  assert.equal(
    renderMarkdownHtml("<script>alert(1)</script>"),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  assert.equal(renderMarkdownHtml(""), "");
  assert.equal(renderMarkdownHtml(null), "");
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("inline code, bold and safe links are rendered", () => {
  const html = renderMarkdownHtml("用 `npm test` 跑 **全部** 测试，链接 [文档](https://example.com/a?b=1&c=2)。");
  assert.match(html, /<code>npm test<\/code>/u);
  assert.match(html, /<strong>全部<\/strong>/u);
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">文档<\/a>/u,
  );
  // Only http(s) links become anchors; anything else stays literal text.
  assert.equal(
    renderMarkdownHtml("[点我](javascript:alert(1))"),
    "<p>[点我](javascript:alert(1))</p>",
  );
});

test("headings, rules and quotes become blocks", () => {
  assert.equal(renderMarkdownHtml("# 标题\n\n---\n\n> 引用\n> 第二行"), "<h1>标题</h1><hr><blockquote><p>引用\n第二行</p></blockquote>");
  assert.equal(renderMarkdownHtml("### 三级 ###"), "<h3>三级</h3>");
});

test("fenced code keeps its language and escapes the body", () => {
  const html = renderMarkdownHtml("```js\nconst a = 1 < 2;\n```");
  assert.equal(html, '<pre class="mdx-code-block"><code data-language="js">const a = 1 &lt; 2;</code></pre>');
  // An unfinished fence is still shown as code while streaming.
  assert.match(renderMarkdownHtml("```\n未闭合"), /^<pre class="mdx-code-block"><code>未闭合<\/code><\/pre>$/u);
  assert.equal(renderMarkdownHtml("```\n```"), '<pre class="mdx-code-block"><code></code></pre>');
});

test("ordered, unordered and nested lists keep their structure", () => {
  assert.equal(
    renderMarkdownHtml("- 一\n- 二"),
    "<ul><li><p>一</p></li><li><p>二</p></li></ul>",
  );
  assert.equal(
    renderMarkdownHtml("3. 三\n4. 四"),
    '<ol start="3"><li><p>三</p></li><li><p>四</p></li></ol>',
  );
  assert.equal(
    renderMarkdownHtml("- 一\n  - 子项\n- 二"),
    "<ul><li><p>一</p><ul><li><p>子项</p></li></ul></li><li><p>二</p></li></ul>",
  );
});

test("tables honour separators, alignment and escaped pipes", () => {
  const html = renderMarkdownHtml("| 名称 | 数量 |\n| --- | ---: |\n| 甲 | 1 |\n| `a\\|b` | 2 |");
  assert.match(html, /class="mdx-table-scroll"/u);
  assert.match(html, /<th scope="col" data-align="left">名称<\/th>/u);
  assert.match(html, /<th scope="col" data-align="right">数量<\/th>/u);
  assert.match(html, /<td data-align="right">1<\/td>/u);
  assert.match(html, /<code>a\|b<\/code>/u);
  // Inline styles would be blocked by the runtime CSP, so alignment travels as
  // a data attribute instead.
  assert.equal(html.includes("style="), false);
  // A second row without a separator line is not a table.
  assert.equal(renderMarkdownHtml("| a | b |\n| 1 | 2 |"), "<p>| a | b |\n| 1 | 2 |</p>");
});

test("the renderer is published for the classic workbench script", () => {
  assert.equal(typeof globalThis.AllRoundMarkdown?.toHtml, "function");
  assert.match(globalThis.AllRoundMarkdown.toHtml("**粗**"), /<strong>粗<\/strong>/u);
});
