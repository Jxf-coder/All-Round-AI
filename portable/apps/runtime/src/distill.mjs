// ---------------------------------------------------------------------------
// 巡读提炼. The scout pass decides which files are worth reading; this module
// asks the configured provider to extract facts and FAQs from one plain-text
// file and keeps only drafts whose quote really appears in that file. A draft
// without a matching quote is dropped instead of being shown to a person as if
// the model had read something it did not.
// ---------------------------------------------------------------------------

export const DISTILL_MAX_FILES = 10;
export const DISTILL_MAX_CHARS = 4_000;
export const DISTILL_MAX_FACTS = 6;
export const DISTILL_MAX_FAQS = 4;

export function normalizeForMatch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/gu, '"')
    .replace(/[—–‐‑‒−]/gu, "-")
    .replace(/：/gu, ":")
    .replace(/[，、]/gu, ",")
    .replace(/。/gu, ".")
    .replace(/；/gu, ";")
    .replace(/！/gu, "!")
    .replace(/？/gu, "?")
    .replace(/（/gu, "(")
    .replace(/）/gu, ")")
    .replace(/\s+/gu, "");
}

export function quoteIsGrounded(quote, text) {
  const needle = normalizeForMatch(quote);
  if (!needle) return false;
  // A four-character-or-shorter quote with no number is not evidence: it is
  // likely to appear in any document and proves nothing.
  if (needle.length < 4 && !/\d/u.test(needle)) return false;
  return normalizeForMatch(text).includes(needle);
}

export function buildDistillPrompt({
  fileName,
  text,
  goal = "",
  product = "",
  categories = [],
  standard = "",
  redLines = "",
  forbidden = [],
}) {
  const lines = [
    "你是企业知识库的提炼员。只从下面这段原文里抽取，不补充、不推断、不改写数字。",
    `文件：${fileName}${product ? `；主推产品：${product}` : ""}${goal ? `；本次目标：${goal}` : ""}`,
    categories.length ? `分类只能用这几类：${categories.join("、")}` : "",
    standard ? `沉淀标准：\n${String(standard).slice(0, 1800)}` : "",
    redLines ? `行业红线（不要写成对外主张）：${String(redLines).slice(0, 600)}` : "",
    forbidden.length ? `禁入词（出现这些内容的句子不要抽取）：${forbidden.slice(0, 30).join("、")}` : "",
    "",
    "只输出一个紧凑的 JSON，不要缩进换行、不要 Markdown 围栏、不要任何说明文字：",
    '{"facts":[{"title":"...","body":"...","quote":"..."}],"faqs":[{"question":"...","answer":"...","quote":"..."}]}',
    "",
    "规则：",
    "1. quote 必须从原文里原样复制，可以只截一部分，但不能是你概括的话。",
    "2. title / body / answer 里的每个数字、型号、认证、年份，都要能在原文里找到。",
    "3. 拿不准就不写，宁少勿错。",
    "4. 不写客户名称、联系人、手机号；不生成效果承诺和认证结论。",
    `5. 最多 facts ${DISTILL_MAX_FACTS} 条、faqs ${DISTILL_MAX_FAQS} 条。`,
    "",
    `原文（《${fileName}》）：`,
    "<<<",
    String(text ?? "").slice(0, DISTILL_MAX_CHARS),
    ">>>",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function textOf(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Parses the compact JSON the prompt asks for. Fences and leading prose are
// tolerated because models add them even when told not to, but a reply without
// an object is an error rather than an empty success.
export function parseDistillReply(value) {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw.replace(/```(?:json)?/giu, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("模型没有返回 JSON");
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的 JSON 无法解析");
  }
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const faqs = Array.isArray(parsed?.faqs) ? parsed.faqs : [];
  const drafts = [];
  for (const fact of facts.slice(0, DISTILL_MAX_FACTS)) {
    const title = textOf(fact?.title, 120);
    const body = textOf(fact?.body, 4_000);
    if (!title || !body) continue;
    drafts.push({ kind: "fact", title, body, quote: textOf(fact?.quote, 600) });
  }
  for (const faq of faqs.slice(0, DISTILL_MAX_FAQS)) {
    const title = textOf(faq?.question, 120);
    const body = textOf(faq?.answer, 4_000);
    if (!title || !body) continue;
    drafts.push({ kind: "faq", title, body, quote: textOf(faq?.quote, 600) });
  }
  return drafts;
}

export function filterGroundedDrafts(drafts, text) {
  const accepted = [];
  let dropped = 0;
  for (const draft of drafts) {
    if (quoteIsGrounded(draft.quote, text)) accepted.push(draft);
    else dropped += 1;
  }
  return { accepted, dropped };
}
