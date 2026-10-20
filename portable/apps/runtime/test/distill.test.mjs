import assert from "node:assert/strict";
import test from "node:test";

import {
  DISTILL_MAX_FACTS,
  DISTILL_MAX_FAQS,
  buildDistillPrompt,
  filterGroundedDrafts,
  normalizeForMatch,
  parseDistillReply,
  quoteIsGrounded,
} from "../src/distill.mjs";

const sourceText = [
  "主推产品：折叠彩虹琴",
  "交期：7 天",
  "适用场景：中高端琴行门店演出。",
].join("\n");

test("the prompt carries the boundaries and the document text", () => {
  const prompt = buildDistillPrompt({
    fileName: "产品参数.md",
    text: sourceText,
    goal: "沉淀产品参数",
    product: "折叠彩虹琴",
    categories: ["产品与参数", "客户问答"],
    standard: "六条沉淀标准",
    redLines: "不能说第一",
    forbidden: ["合同", "成本价"],
  });
  assert.match(prompt, /只从下面这段原文里抽取/u);
  assert.match(prompt, /文件：产品参数\.md/u);
  assert.match(prompt, /主推产品：折叠彩虹琴/u);
  assert.match(prompt, /本次目标：沉淀产品参数/u);
  assert.match(prompt, /分类只能用这几类：产品与参数、客户问答/u);
  assert.match(prompt, /沉淀标准：/u);
  assert.match(prompt, /禁入词.*合同、成本价/u);
  assert.match(prompt, /"facts":\[\{"title"/u);
  assert.match(prompt, /<<</u);
  assert.ok(prompt.includes(sourceText));
});

test("replies are parsed from plain or fenced JSON and capped", () => {
  const reply = `说明\n\`\`\`json\n${JSON.stringify({
    facts: Array.from({ length: 10 }, (_, index) => ({
      title: `事实 ${index}`,
      body: `内容 ${index}`,
      quote: sourceText,
    })),
    faqs: Array.from({ length: 8 }, (_, index) => ({
      question: `问题 ${index}？`,
      answer: `回答 ${index}`,
      quote: sourceText,
    })),
  })}\n\`\`\``;
  const drafts = parseDistillReply(reply);
  assert.equal(drafts.filter((draft) => draft.kind === "fact").length, DISTILL_MAX_FACTS);
  assert.equal(drafts.filter((draft) => draft.kind === "faq").length, DISTILL_MAX_FAQS);
  assert.equal(drafts[0].kind, "fact");

  const partial = parseDistillReply(JSON.stringify({
    facts: [{ title: "", body: "x", quote: "x" }, { title: "保留", body: "正文", quote: "正文" }],
    faqs: [{ question: "问", answer: "", quote: "正文" }],
  }));
  assert.deepEqual(partial.map((draft) => draft.title), ["保留"]);

  assert.throws(() => parseDistillReply("没有 JSON"), /没有返回 JSON/u);
  assert.throws(() => parseDistillReply("{坏的}"), /无法解析/u);
});

test("only quotes that really appear in the document survive", () => {
  assert.equal(normalizeForMatch(" 交期：７ 天\n"), normalizeForMatch("交期:7天"));
  assert.equal(quoteIsGrounded("主推产品：折叠彩虹琴", sourceText), true);
  assert.equal(quoteIsGrounded("主推产品:折叠  彩虹琴", sourceText), true);
  assert.equal(quoteIsGrounded("价格：9999 元", sourceText), false);
  assert.equal(quoteIsGrounded("好", sourceText), false);
  assert.equal(quoteIsGrounded("7 天", sourceText), true);

  const result = filterGroundedDrafts([
    { kind: "fact", title: "A", body: "a", quote: "交期：7 天" },
    { kind: "fact", title: "B", body: "b", quote: "价格：9999 元" },
    { kind: "fact", title: "C", body: "c", quote: "" },
  ], sourceText);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.dropped, 2);
});
