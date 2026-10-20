import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKnowledgeStore } from "../src/knowledge.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-extracted-"));
  try {
    await run(await createKnowledgeStore(path.join(root, "knowledge.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("extracted cards start pending and carry their source", async () => {
  await withStore(async (store) => {
    const result = await store.addExtractedCards("project-1", [
      { kind: "fact", title: "主推产品", body: "折叠彩虹琴" },
      { kind: "faq", title: "交期多久？", body: "7 天" },
      { kind: "bogus", title: "无效类型", body: "x" },
      { kind: "fact", title: "", body: "没有标题" },
    ], { source: "产品参数.md" });

    assert.equal(result.added.length, 2);
    assert.equal(result.merged, 0);
    const state = await store.list("project-1");
    assert.equal(state.stats.pending, 2);
    assert.equal(state.stats.confirmed, 0);
    assert.ok(state.cards.every((card) => card.source === "产品参数.md"));
    assert.deepEqual(
      state.cards.map((card) => card.kind).sort(),
      ["fact", "faq"],
    );

    // Pending cards are not retrieval material yet.
    assert.deepEqual(await store.retrieve("project-1", "主推产品"), []);
    await store.setCardStatus("project-1", result.added[0].id, "confirmed");
    assert.equal((await store.retrieve("project-1", "主推产品")).length, 1);
  });
});

test("the same title and kind are merged instead of added twice", async () => {
  await withStore(async (store) => {
    const first = await store.addExtractedCards("project-1", [
      { kind: "fact", title: "主推产品", body: "折叠彩虹琴" },
    ], { source: "a.md" });
    assert.equal(first.added.length, 1);

    const second = await store.addExtractedCards("project-1", [
      { kind: "fact", title: " 主推产品！", body: "换个说法" },
      { kind: "faq", title: "主推产品", body: "同标题不同 kind 不算重复" },
    ], { source: "b.md" });
    assert.equal(second.merged, 1);
    assert.equal(second.added.length, 1);

    // Dropping the card lets the next run add it again.
    await store.setCardStatus("project-1", first.added[0].id, "dropped");
    const third = await store.addExtractedCards("project-1", [
      { kind: "fact", title: "主推产品", body: "重新提炼" },
    ], { source: "c.md" });
    assert.equal(third.added.length, 1);
  });
});
