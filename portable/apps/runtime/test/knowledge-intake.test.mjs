import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { INTAKE_CARD_IDS } from "../src/intake.mjs";
import { MAX_REGRESSION_QUESTIONS, createKnowledgeStore } from "../src/knowledge.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-intake-"));
  const filePath = path.join(root, "knowledge.json");
  try {
    await run({ filePath, store: await createKnowledgeStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sampleFields(overrides = {}) {
  return {
    product: "折叠彩虹琴",
    customer: "中高端琴行",
    platform: "抖音",
    positioning: "给琴行一台能带走的彩虹琴",
    sellingPoints: "折叠后 12cm：实测视频",
    contentThemes: "门店演出",
    knowledgeNeeds: "产品参数\n认证检测",
    materialsWhere: "NAS / 产品资料",
    nas: "DS220+",
    devOs: "Windows",
    forbidden: "合同、成本价",
    externalOk: "官网文案",
    redLines: "不能说第一",
    questions: "1. 主推产品是什么？\n2. 交期多久？",
    versioning: "文件名带日期",
    hours: "每周 4 小时",
    bossConfirmed: false,
    ...overrides,
  };
}

test("saving the intake writes one record, four cards and intake questions", async () => {
  await withStore(async ({ store }) => {
    await store.setIntake("project-1", sampleFields(), "老板");
    const state = await store.list("project-1");
    assert.equal(state.intake.fields.product, "折叠彩虹琴");
    assert.equal(state.intake.by, "老板");
    assert.ok(!Number.isNaN(Date.parse(state.intake.at)));

    assert.deepEqual(state.cards.map((card) => card.id).sort(), [
      INTAKE_CARD_IDS.boundary,
      INTAKE_CARD_IDS.redlines,
      INTAKE_CARD_IDS.scope,
      INTAKE_CARD_IDS.standard,
    ].sort());
    assert.ok(state.cards.every((card) => card.status === "pending"));
    assert.ok(state.cards.every((card) => card.source === "开工前问答"));
    assert.equal(state.stats.cards, 4);

    assert.deepEqual(state.regression.questions.map((question) => question.q), [
      "主推产品是什么？",
      "交期多久？",
    ]);
    assert.ok(state.regression.questions.every((question) => question.from === "intake"));
    assert.equal(state.stats.regressionQuestions, 2);
  });
});

test("resubmitting updates the same cards instead of adding duplicates", async () => {
  await withStore(async ({ store }) => {
    await store.setIntake("project-1", sampleFields(), "老板");
    const first = await store.list("project-1");
    const firstIds = first.cards.map((card) => card.id).sort();
    const firstQuestions = first.regression.questions.map((question) => question.id);

    await store.setIntake("project-1", sampleFields({
      product: "折叠彩虹琴 Pro",
      bossConfirmed: true,
    }), "运营");
    const second = await store.list("project-1");
    assert.equal(second.stats.cards, 4);
    assert.deepEqual(second.cards.map((card) => card.id).sort(), firstIds);
    assert.ok(second.cards.every((card) => card.status === "confirmed"));
    assert.equal(second.cards.find((card) => card.id === INTAKE_CARD_IDS.scope).title,
      "产品范围：折叠彩虹琴 Pro");
    assert.equal(second.intake.by, "运营");
    // Unchanged questions keep their id, so a recorded baseline is not lost.
    assert.deepEqual(second.regression.questions.map((question) => question.id), firstQuestions);
  });
});

test("manual regression questions survive intake submissions", async () => {
  await withStore(async ({ store }) => {
    const manual = await store.addRegressionQuestion("project-1", "手工问题内容够长吗？");
    await store.setIntake("project-1", sampleFields(), "老板");
    let state = await store.list("project-1");
    assert.ok(state.regression.questions.some((question) => question.id === manual.id
      && question.from === "manual"));
    assert.equal(state.regression.questions.filter((question) => question.from === "intake").length, 2);

    await store.setIntake("project-1", sampleFields({ questions: "3. 只有新问题够长吗？" }), "老板");
    state = await store.list("project-1");
    const manualRows = state.regression.questions.filter((question) => question.from === "manual");
    assert.equal(manualRows.length, 1);
    assert.equal(manualRows[0].id, manual.id);
    assert.deepEqual(
      state.regression.questions.filter((question) => question.from === "intake").map((question) => question.q),
      ["只有新问题够长吗？"],
    );
    assert.ok(state.regression.questions.length <= MAX_REGRESSION_QUESTIONS);
  });
});

test("intake questions yield the total question cap to manual ones", async () => {
  await withStore(async ({ store }) => {
    for (let index = 0; index < MAX_REGRESSION_QUESTIONS; index += 1) {
      await store.addRegressionQuestion("project-1", `手工问题第 ${index + 1} 条够长吗？`);
    }
    await store.setIntake("project-1", sampleFields(), "老板");
    const state = await store.list("project-1");
    assert.equal(state.regression.questions.length, MAX_REGRESSION_QUESTIONS);
    assert.ok(state.regression.questions.every((question) => question.from === "manual"));
  });
});

test("intake rejects malformed input and damaged records fail closed", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.setIntake("project-1", [], "老板"), /格式错误/u);
    // An empty submission is valid: the record exists, all cards are pending.
    const saved = await store.setIntake("project-1", {}, "老板");
    assert.equal(saved.questions, 0);
    assert.equal((await store.list("project-1")).intake.fields.product, "");
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "allround-intake-broken-"));
  try {
    const filePath = path.join(root, "knowledge.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{
        projectId: "broken",
        cards: [],
        gaps: [],
        intake: {
          at: "2026-01-01T00:00:00.000Z",
          by: "老板",
          fields: { product: "只写了一半" },
        },
      }],
    }));
    const broken = await createKnowledgeStore(filePath);
    await assert.rejects(broken.list("broken"), /invalid intake/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents written before intake existed stay readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-intake-old-"));
  try {
    const filePath = path.join(root, "knowledge.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{ projectId: "old", cards: [], gaps: [] }],
    }));
    const store = await createKnowledgeStore(filePath);
    const state = await store.list("old");
    assert.equal(state.intake, null);
    assert.deepEqual(state.regression, { questions: [], runs: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
