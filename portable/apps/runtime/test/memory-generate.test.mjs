import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTILL_MAX_ITEMS,
  buildDistillPrompt,
  buildSoulPrompt,
  cleanSoulDraft,
  formatCardsForSoul,
  parseDistillReply,
} from "../src/ai/memory-generate.mjs";

test("distillation replies are parsed from JSON, fences and bullet lines", () => {
  assert.deepEqual(
    parseDistillReply('结果如下：\n[{"kind":"决策","text":"短视频统一 9:16"}]'),
    [{ text: "短视频统一 9:16", kind: "决策" }],
  );
  assert.deepEqual(
    parseDistillReply('```json\n[{"text":"主推折叠琴","kind":"事实"}]\n```'),
    [{ text: "主推折叠琴", kind: "事实" }],
  );
  assert.deepEqual(
    parseDistillReply("- [偏好] 回答用中文\n- 每周五整理素材"),
    [{ text: "[偏好] 回答用中文", kind: undefined }, { text: "每周五整理素材", kind: undefined }],
  );
  assert.deepEqual(parseDistillReply("模型不知道该怎么回答"), []);
  assert.deepEqual(parseDistillReply(""), []);
});

test("distillation never returns more entries than the cap", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ text: `记忆条目 ${index + 1}` }));
  assert.equal(parseDistillReply(JSON.stringify(items)).length, DISTILL_MAX_ITEMS);
});

test("the transcript keeps the newest content within its budget", () => {
  const messages = [
    { role: "user", content: `旧内容 ${"甲".repeat(4000)}` },
    { role: "assistant", content: "中间回复" },
    { role: "user", content: "最新问题" },
    { role: "assistant", content: "最新回复" },
  ];
  const prompt = buildDistillPrompt(messages);
  assert.match(prompt, /记忆提炼器/u);
  assert.match(prompt, /最新问题/u);
  assert.match(prompt, /最新回复/u);
  assert.ok(prompt.length < 6600);
});

test("soul drafts are cleaned and must look like real content", () => {
  const body = "# 内容策划\n\n## 身份\n为电商团队服务，主战场是短视频与直播。\n\n## 职责\n- 负责选题与脚本。\n";
  assert.equal(cleanSoulDraft(`\`\`\`markdown\n${body}\`\`\``), body.trim());
  assert.throws(() => cleanSoulDraft("太短"), /没有产出可用/u);
  assert.throws(() => cleanSoulDraft(null), TypeError);
});

test("the soul prompt marks placeholders and limits the card digest", () => {
  const placeholder = buildSoulPrompt({
    projectName: "内容组",
    existingSoul: "# 人格\n（一句话说明它负责什么）",
    memory: "",
    cards: "",
  });
  assert.match(placeholder, /空模板/u);

  const filled = buildSoulPrompt({
    projectName: "内容组",
    existingSoul: "# 内容策划\n\n## 身份\n已有身份。",
    memory: "主推折叠琴",
    cards: "- 口径：统一 9:16",
  });
  assert.match(filled, /保留已写实的句子/u);

  const cards = Array.from({ length: 10 }, (_, index) => ({
    title: `卡片 ${index + 1}`,
    body: "内容".repeat(300),
  }));
  const digest = formatCardsForSoul(cards);
  assert.equal(digest.split("\n").length, 8);
  assert.ok(digest.split("\n")[0].length <= 310);
  assert.equal(formatCardsForSoul([]), "");
});
