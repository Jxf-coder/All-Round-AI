import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildHandoverBundle,
  createHandover,
  findSecretShapes,
  latestHandover,
  readHandover,
  safeProjectSlug,
} from "../src/handover.mjs";

const fixedNow = () => new Date("2026-10-19T04:05:06.000Z");

function sampleProject() {
  return { id: "Demo Project", name: "演示项目", type: "client" };
}

function sampleKnowledge() {
  return {
    cards: [
      { id: "c1", kind: "fact", title: "主推产品", body: "折叠彩虹琴", status: "confirmed" },
      { id: "c2", kind: "faq", title: "旧说法", body: "已废弃", status: "dropped" },
    ],
    gaps: [{ id: "g1", question: "售后政策？", status: "open" }],
    regression: { questions: [{ id: "q1", q: "主推产品是什么？" }], runs: [] },
    stats: { cards: 2, pending: 0, confirmed: 1, gapsOpen: 1 },
  };
}

function sampleMemory() {
  return { soul: "人格", memory: "记忆", pending: [{ id: "p1", text: "候选" }] };
}

test("the bundle keeps live cards and the project's memory", () => {
  const bundle = buildHandoverBundle({
    project: sampleProject(),
    memory: sampleMemory(),
    knowledge: sampleKnowledge(),
    generatedBy: "测试账号",
    now: fixedNow,
  });
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.generatedAt, "2026-10-19T04:05:06.000Z");
  assert.equal(bundle.generatedBy, "测试账号");
  assert.deepEqual(bundle.project, { id: "Demo Project", name: "演示项目", type: "client" });
  assert.deepEqual(bundle.knowledge.cards.map((card) => card.id), ["c1"]);
  assert.equal(bundle.knowledge.gaps.length, 1);
  assert.deepEqual(bundle.memory.pending, [{ id: "p1", text: "候选" }]);
  assert.equal(bundle.regression.questions.length, 1);
  assert.equal(bundle.stats.cards, 2);
});

test("the bundle requires a project", () => {
  assert.throws(() => buildHandoverBundle({ project: null }), TypeError);
});

test("project ids become safe file names", () => {
  assert.equal(safeProjectSlug("Demo Project"), "demo-project");
  assert.equal(safeProjectSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(safeProjectSlug("项目"), "project");
});

test("common credential shapes are detected", () => {
  assert.deepEqual(findSecretShapes("普通文本"), []);
  assert.equal(findSecretShapes(`sk-${"a".repeat(24)}`).length, 1);
  assert.equal(findSecretShapes(`AKID${"b".repeat(20)}`).length, 1);
});

test("an export writes the bundle and the latest pointer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "allround-handover-"));
  try {
    const info = await createHandover({
      directory,
      project: sampleProject(),
      memory: sampleMemory(),
      knowledge: sampleKnowledge(),
      generatedBy: "测试账号",
      now: fixedNow,
    });
    assert.equal(info.file, "handover-demo-project-20261019040506.json");
    assert.equal(info.projectId, "Demo Project");
    assert.equal(info.by, "测试账号");
    assert.equal(info.counts.cards, 1);
    assert.equal(info.counts.regressionQuestions, 1);
    assert.match(info.sha256, /^[0-9a-f]{64}$/u);

    const stored = JSON.parse(await readFile(path.join(directory, info.file), "utf8"));
    assert.equal(stored.project.id, "Demo Project");
    assert.equal(stored.knowledge.cards.length, 1);

    assert.deepEqual(await latestHandover(directory), info);
    const downloaded = await readHandover(directory, info.file);
    assert.equal(downloaded.at(0), 0x7b);
    assert.equal(await readHandover(directory, "../config/memory.json"), null);
    assert.equal(await readHandover(directory, "latest.json"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an export refuses to write when a credential shape is present", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "allround-handover-secret-"));
  try {
    const knowledge = sampleKnowledge();
    knowledge.cards[0].body = `api key: sk-${"x".repeat(24)}`;
    await assert.rejects(
      createHandover({
        directory,
        project: sampleProject(),
        memory: sampleMemory(),
        knowledge,
        generatedBy: "测试账号",
        now: fixedNow,
      }),
      (error) => error.code === "SECRET_DETECTED" && error.message.includes("形似密钥"),
    );
    assert.equal(await latestHandover(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale latest pointer is ignored", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "allround-handover-stale-"));
  try {
    await writeFile(
      path.join(directory, "latest.json"),
      JSON.stringify({ file: "handover-demo-20261019040506.json" }),
    );
    assert.equal(await latestHandover(directory), null);
    await writeFile(path.join(directory, "latest.json"), JSON.stringify({ file: "../escape.json" }));
    assert.equal(await latestHandover(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
