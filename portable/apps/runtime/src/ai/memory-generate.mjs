// Prompts and reply parsing for memory work that needs a model: distilling a
// conversation into candidate memories and drafting a SOUL.md. They live here
// so the HTTP layer stays about routing and the rules can be unit tested.

export const DISTILL_MIN_ITEMS = 1;
export const DISTILL_MAX_ITEMS = 8;
const MAX_TRANSCRIPT = 6_000;
const MIN_SOUL_LENGTH = 40;

const DISTILL_INSTRUCTION = [
  "你是记忆提炼器。请从下面的对话里提炼值得长期记住的内容。",
  "只输出一个 JSON 数组，不要解释、不要代码块。",
  '每项形如 {"kind":"事实|决策|偏好","text":"一句话"}。',
  `最多 ${DISTILL_MAX_ITEMS} 条；一次性问答、寒暄和没有信息量的内容不要写。`,
  "text 必须是完整陈述，不超过 200 字。",
].join("\n");

function messageText(message) {
  const role = message?.role === "assistant" ? "助手" : "用户";
  return `${role}：${String(message?.content ?? "").trim()}`;
}

export function buildDistillPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError("提炼记忆需要对话内容");
  }
  let transcript = messages.map(messageText).filter((line) => line.length > 3).join("\n");
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT);
  return `${DISTILL_INSTRUCTION}\n\n=== 对话 ===\n${transcript}`;
}

function parseJsonItems(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Providers occasionally wrap JSON in prose or a fenced block; the parser
// accepts that, and falls back to bullet lines so a plain-text answer is not
// thrown away. Anything unparseable means "nothing to queue", never an error
// that invents entries.
export function parseDistillReply(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const json = parseJsonItems(text);
  const raw = json ?? text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* ") || /^\[(事实|决策|偏好)\]/u.test(line))
    .map((line) => line.replace(/^[-*]\s*/u, ""));
  const items = [];
  for (const entry of raw) {
    const value = typeof entry === "string" ? { text: entry } : entry;
    const rawText = typeof value?.text === "string" ? value.text.trim() : "";
    if (!rawText) continue;
    items.push({ text: rawText, kind: value?.kind });
    if (items.length >= DISTILL_MAX_ITEMS) break;
  }
  return items;
}

export function buildSoulPrompt({ projectName, existingSoul, memory, cards } = {}) {
  const keepFilled = typeof existingSoul === "string"
    && existingSoul.trim().length > 0
    && !/（一句话说明|（它负责什么）|（不能做什么）/u.test(existingSoul);
  return [
    "你是角色人格撰写器。根据知识卡片和已有记忆，为这个 Agent 写 SOUL.md 初稿。",
    "只输出 markdown 正文，不要解释、不要代码块。",
    "必须包含：# 标题、## 身份（一段话）、## 职责（3-6 条）、## 风格（2-4 条）、## 禁忌（2-5 条）。",
    "身份要写清：为谁服务、主战场是什么。禁忌要写已拍板的红线，不要空话。",
    keepFilled
      ? "下面已有人格不是空模板：保留已写实的句子，只补空段或占位行，不要整篇推翻。"
      : "现有人格是空模板，按资料重写。",
    "",
    `角色名：${projectName || "未命名项目"}`,
    "",
    "=== 已有人格 ===",
    existingSoul?.trim() || "（空）",
    "",
    "=== 已有长期记忆 ===",
    memory?.trim() || "（空）",
    "",
    "=== 知识卡片 ===",
    cards?.trim() || "（空）",
  ].join("\n");
}

export function cleanSoulDraft(text) {
  if (typeof text !== "string") throw new TypeError("人格初稿必须是文本");
  const draft = text
    .replace(/^```(?:markdown|md)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  if (draft.length < MIN_SOUL_LENGTH) {
    throw new Error("模型没有产出可用的人格初稿");
  }
  return draft;
}

export function formatCardsForSoul(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  return cards
    .slice(0, 8)
    .map((card) => {
      const body = typeof card.body === "string" ? card.body.trim().slice(0, 300) : "";
      return body ? `- ${card.title}：${body}` : `- ${card.title}`;
    })
    .join("\n");
}
