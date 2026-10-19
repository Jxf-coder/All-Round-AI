import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_PENDING_ITEMS,
  MAX_PENDING_TEXT,
  buildMemoryBlock,
  createMemoryStore,
} from "../src/memory.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-memory-pending-"));
  const filePath = path.join(root, "memory.json");
  try {
    await run({ filePath, store: await createMemoryStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("candidates wait for confirmation and are not injected into the prompt", async () => {
  await withStore(async ({ store }) => {
    await store.save("project-1", { memory: "## 事实\n\n- 主推折叠琴" });
    const state = await store.addPending("project-1", [
      { text: "主推折叠琴" },
      { text: "[决策] 短视频统一 9:16" },
      { text: "短视频统一9:16" },
      { text: "客服回复不超过三句话", kind: "偏好" },
    ]);

    assert.equal(state.pending.length, 2);
    assert.deepEqual(
      state.pending.map((item) => [item.kind, item.text]),
      [["决策", "短视频统一 9:16"], ["偏好", "客服回复不超过三句话"]],
    );
    assert.match(state.pending[0].id, /^[0-9a-f-]{36}$/u);
    assert.equal(new Date(state.pending[0].createdAt).toISOString(), state.pending[0].createdAt);

    const block = buildMemoryBlock(await store.get("project-1"));
    assert.match(block, /主推折叠琴/u);
    assert.doesNotMatch(block, /短视频统一 9:16/u);
    assert.doesNotMatch(block, /客服回复不超过三句话/u);
  });
});

test("confirming moves one entry into its kind section and clears it from the queue", async () => {
  await withStore(async ({ store }) => {
    await store.save("project-1", { memory: "## 事实\n\n- 主推折叠琴" });
    const queued = await store.addPending("project-1", [
      { text: "短视频统一 9:16", kind: "决策" },
      { text: "回答用中文", kind: "偏好" },
    ]);

    const confirmed = await store.confirmPending("project-1", queued.pending[0].id);
    assert.equal(confirmed.pending.length, 1);
    assert.match(confirmed.memory, /## 事实\n\n- 主推折叠琴\n\n## 决策\n\n- 短视频统一 9:16/u);
    assert.doesNotMatch(confirmed.memory, /回答用中文/u);

    // The edited text and kind win over the queued values.
    const edited = await store.confirmPending("project-1", confirmed.pending[0].id, {
      kind: "事实",
      text: "回答必须使用简体中文",
    });
    assert.equal(edited.pending.length, 0);
    assert.match(edited.memory, /## 事实\n\n- 主推折叠琴\n- 回答必须使用简体中文/u);
    assert.doesNotMatch(edited.memory, /回答用中文/u);

    const block = buildMemoryBlock(edited);
    assert.match(block, /短视频统一 9:16/u);
    assert.match(block, /回答必须使用简体中文/u);
  });
});

test("a candidate that repeats stored memory never enters the queue", async () => {
  await withStore(async ({ store }) => {
    await store.save("project-1", { memory: "## 事实\n\n- 主推折叠琴" });
    const queued = await store.addPending("project-1", [{ text: "主推折叠琴的配件" }]);
    assert.equal(queued.pending.length, 0);
    assert.equal((queued.memory.match(/^- /gmu) ?? []).length, 1);
  });
});

test("discarding removes a candidate and unknown ids change nothing", async () => {
  await withStore(async ({ store }) => {
    const queued = await store.addPending("project-1", [
      { text: "第一条候选记忆" },
      { text: "第二条候选记忆" },
    ]);
    const discarded = await store.discardPending("project-1", queued.pending[0].id);
    assert.deepEqual(discarded.pending.map((item) => item.text), ["第二条候选记忆"]);
    assert.equal(await store.discardPending("project-1", "missing-id"), null);
    assert.equal(await store.confirmPending("project-1", "missing-id"), null);
  });
});

test("the pending queue is bounded and keeps the newest entries", async () => {
  await withStore(async ({ store }) => {
    const items = Array.from({ length: MAX_PENDING_ITEMS + 5 }, (_, index) => ({
      text: `候选记忆条目 ${String(index + 1).padStart(2, "0")}`,
    }));
    const state = await store.addPending("project-1", items);
    assert.equal(state.pending.length, MAX_PENDING_ITEMS);
    assert.equal(state.pending[0].text, "候选记忆条目 06");
    assert.equal(state.pending.at(-1).text, "候选记忆条目 35");
  });
});

test("pending input is validated and old documents without a queue still work", async () => {
  await withStore(async ({ filePath, store }) => {
    await assert.rejects(store.addPending("project-1", []), /至少需要一条/u);
    await assert.rejects(store.addPending("project-1", [{ text: "短" }]), /太短/u);
    await assert.rejects(
      store.addPending("project-1", [{ text: "长".repeat(MAX_PENDING_TEXT + 1) }]),
      /不能超过/u,
    );
    await assert.rejects(store.confirmPending("project-1", 42), /id 无效/u);

    // A record written before the queue existed stays readable and writable.
    await writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{
        projectId: "legacy",
        soul: "你是客服",
        memory: "## 事实\n\n- 已有事实",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    }), "utf8");
    const legacy = await (await createMemoryStore(filePath)).get("legacy");
    assert.deepEqual(legacy.pending, []);
    const updated = await (await createMemoryStore(filePath)).addPending("legacy", [{ text: "新候选事实" }]);
    assert.equal(updated.pending.length, 1);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).projects[0].pending.length, 1);
  });
});
