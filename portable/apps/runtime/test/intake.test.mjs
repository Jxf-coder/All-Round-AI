import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FORBIDDEN,
  INTAKE_CARD_IDS,
  MAX_INTAKE_QUESTIONS,
  buildIntakeCards,
  cleanIntake,
  forbiddenTerms,
  parseQuestions,
  standardCardBody,
} from "../src/intake.mjs";

test("intake fields are trimmed, bounded and always complete", () => {
  const fields = cleanIntake({
    product: "  折叠彩虹琴  ",
    customer: "琴行",
    sellingPoints: "x".repeat(4000),
    questions: "q".repeat(5000),
    bossConfirmed: "true",
  });
  assert.equal(fields.product, "折叠彩虹琴");
  assert.equal(fields.customer, "琴行");
  assert.equal(fields.sellingPoints.length, 3000);
  assert.equal(fields.questions.length, 4000);
  // Only a real boolean confirms the plan; the string "true" does not.
  assert.equal(fields.bossConfirmed, false);
  assert.equal(fields.forbidden, "");
  assert.equal(fields.nas, "");
  assert.equal(Object.keys(fields).length, 17);
  assert.equal(cleanIntake(null).bossConfirmed, false);
});

test("questions are split, cleaned, deduplicated and capped", () => {
  const questions = parseQuestions([
    "1. 主推产品是什么？",
    "2、交期多久",
    "- 售后怎么办",
    "（1）可以定制吗",
    "短",
    "主推产品是什么？",
  ].join("\n"));
  assert.deepEqual(questions, ["主推产品是什么？", "交期多久", "售后怎么办", "可以定制吗"]);

  const many = Array.from({ length: 40 }, (_, index) => `${index + 1}. 第${index + 1}个问题是什么？`);
  assert.equal(parseQuestions(many.join("\n")).length, MAX_INTAKE_QUESTIONS);
  assert.equal(parseQuestions(`${"长".repeat(201)}？`).length, 0);
});

test("forbidden terms merge the company's list with the defaults", () => {
  const terms = forbiddenTerms({ forbidden: "禁止合同（含附件）、成本价、工资、A" });
  assert.ok(terms.includes("合同"));
  assert.ok(terms.includes("成本价"));
  assert.ok(terms.includes("工资"));
  assert.ok(terms.includes("客户名单"));
  assert.ok(!terms.includes("A"));
  assert.equal(terms.length, new Set(terms).size);
  assert.ok(DEFAULT_FORBIDDEN.every((term) => terms.includes(term)));
});

test("the standard card carries all six retention criteria", () => {
  const body = standardCardBody(cleanIntake({
    product: "折叠彩虹琴",
    customer: "琴行",
    forbidden: "合同、成本价",
    externalOk: "官网文案",
    versioning: "文件名带日期",
  }));
  assert.match(body, /同时满足下面六条/u);
  assert.match(body, /和在推的产品有关（折叠彩虹琴/u);
  assert.match(body, /属于这几类之一：产品与参数/u);
  assert.match(body, /不是禁入资料：.*合同/u);
  assert.match(body, /可对外 \/ 可送外部模型：官网文案/u);
  assert.match(body, /版本与有效期习惯：文件名带日期/u);
  assert.doesNotMatch(body, /\n\n\n/u);
});

test("four standard cards use stable ids and follow the boss flag", () => {
  const fields = cleanIntake({ product: "折叠彩虹琴", questions: "主推产品是什么？" });
  const pending = buildIntakeCards(fields);
  assert.deepEqual(pending.map((card) => card.id), [
    INTAKE_CARD_IDS.scope,
    INTAKE_CARD_IDS.boundary,
    INTAKE_CARD_IDS.redlines,
    INTAKE_CARD_IDS.standard,
  ]);
  assert.ok(pending.every((card) => card.status === "pending"));
  assert.ok(pending.every((card) => card.source === "开工前问答"));
  assert.equal(pending[0].title, "产品范围：折叠彩虹琴");
  assert.match(pending[0].body, /主推产品：折叠彩虹琴/u);
  assert.equal(pending[2].body, "（未填）");

  const confirmed = buildIntakeCards(fields, { status: "confirmed" });
  assert.ok(confirmed.every((card) => card.status === "confirmed"));
  assert.throws(() => buildIntakeCards(fields, { status: "dropped" }), TypeError);

  const empty = buildIntakeCards(cleanIntake({}));
  assert.equal(empty[0].title, "产品范围：主推产品未填");
});
