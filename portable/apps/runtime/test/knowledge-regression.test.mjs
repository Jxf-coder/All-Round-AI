import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_REGRESSION_QUESTIONS,
  MAX_REGRESSION_RUNS,
  createKnowledgeStore,
} from "../src/knowledge.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-regression-"));
  const filePath = path.join(root, "knowledge.json");
  try {
    await run({ filePath, store: await createKnowledgeStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function confirmedCard(store, title, body) {
  const card = await store.addCard("project-1", { kind: "fact", title, body });
  await store.setCardStatus("project-1", card.id, "confirmed");
  return card;
}

test("regression questions are validated, deduplicated and removable", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.addRegressionQuestion("project-1", "短"), /太短/u);
    await assert.rejects(store.addRegressionQuestion("project-1", ""), /不能为空/u);

    const first = await store.addRegressionQuestion("project-1", "主推产品是什么？");
    const duplicate = await store.addRegressionQuestion("project-1", "主推产品是什么？");
    assert.equal(duplicate.id, first.id);
    assert.equal((await store.list("project-1")).regression.questions.length, 1);

    assert.equal(await store.removeRegressionQuestion("project-1", "missing"), false);
    assert.equal(await store.removeRegressionQuestion("project-1", first.id), true);
    assert.equal((await store.list("project-1")).regression.questions.length, 0);
  });
});

test("a run records a baseline from confirmed cards and reports retention later", async () => {
  await withStore(async ({ store }) => {
    const card = await confirmedCard(store, "主推产品", "主推产品是折叠彩虹琴，适合送礼。");
    await store.addCard("project-1", { kind: "fact", title: "主推产品草稿", body: "主推产品是折叠彩虹琴。" });
    await store.addRegressionQuestion("project-1", "主推产品是什么？");

    const first = await store.runRegression("project-1", "升级到 v2");
    assert.equal(first.total, 1);
    assert.equal(first.passed, 1);
    assert.equal(first.retained, null);
    assert.deepEqual(first.items[0].hits, [card.id]);
    assert.equal(first.reason, "升级到 v2");

    const stored = await store.list("project-1");
    assert.equal(stored.regression.questions[0].baseline.length, 1);
    assert.equal(stored.regression.runs.length, 1);
    assert.equal(stored.stats.regressionPassed, 1);
    assert.equal(stored.stats.regressionTotal, 1);

    const second = await store.runRegression("project-1");
    assert.equal(second.retained, 1);
    assert.equal(second.items[0].retained, 1);

    // Removing the only confirmed card breaks the baseline.
    await store.removeCard("project-1", card.id);
    const third = await store.runRegression("project-1");
    assert.equal(third.passed, 0);
    assert.equal(third.retained, 0);
    assert.equal(third.items[0].pass, false);
  });
});

test("running with no questions returns null and keeps the question cap", async () => {
  await withStore(async ({ store }) => {
    assert.equal(await store.runRegression("project-1"), null);

    for (let index = 0; index < MAX_REGRESSION_QUESTIONS; index += 1) {
      await store.addRegressionQuestion("project-1", `客户常问的问题 ${index + 1} 号`);
    }
    await assert.rejects(
      store.addRegressionQuestion("project-1", "再增加一道题"),
      /最多 60 道/u,
    );
  });
});

test("run history is bounded and survives a restart", async () => {
  await withStore(async ({ filePath, store }) => {
    await confirmedCard(store, "主推产品", "主推产品是折叠彩虹琴。");
    await store.addRegressionQuestion("project-1", "主推产品是什么？");
    for (let index = 0; index < MAX_REGRESSION_RUNS + 2; index += 1) {
      await store.runRegression("project-1");
    }
    const reopened = await createKnowledgeStore(filePath);
    const state = await reopened.list("project-1");
    // The summary exposes only the latest five runs; the file keeps the cap.
    assert.equal(state.regression.runs.length, 5);
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(saved.projects[0].regression.runs.length, MAX_REGRESSION_RUNS);
  });
});

test("documents written before regression existed stay readable", async () => {
  await withStore(async ({ filePath }) => {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{
        projectId: "legacy",
        cards: [],
        gaps: [],
      }],
    }), "utf8");
    const store = await createKnowledgeStore(filePath);
    const state = await store.list("legacy");
    assert.deepEqual(state.regression, { questions: [], runs: [] });
    await store.addRegressionQuestion("legacy", "旧项目还能加题吗？");
    assert.equal((await store.list("legacy")).regression.questions.length, 1);
  });
});
