import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMemoryBlock, createMemoryStore, MAX_MEMORY_LENGTH } from "../src/memory.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-memory-"));
  const filePath = path.join(root, "memory.json");
  try {
    await run({ filePath, store: await createMemoryStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("memory is empty until it is saved, and reading never creates a record", async () => {
  await withStore(async ({ store }) => {
    assert.deepEqual(await store.get("project-1"), {
      projectId: "project-1",
      soul: "",
      memory: "",
      updatedAt: null,
    });
    await assert.rejects(store.get(""), TypeError);
    await assert.rejects(store.save("", { soul: "x" }), TypeError);
  });
});

test("saving updates only the documents that were sent", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save("project-1", { soul: "你是内容策划", memory: "主推折叠琴" });
    assert.equal(first.soul, "你是内容策划");
    assert.equal(first.memory, "主推折叠琴");
    assert.equal(typeof first.updatedAt, "string");

    const second = await store.save("project-1", { memory: "改为主推课程" });
    assert.equal(second.soul, "你是内容策划");
    assert.equal(second.memory, "改为主推课程");

    // Projects keep their own documents.
    await store.save("project-2", { soul: "你是客服" });
    assert.equal((await store.get("project-1")).soul, "你是内容策划");
    assert.equal((await store.get("project-2")).soul, "你是客服");
    assert.equal((await store.get("project-2")).memory, "");
  });
});

test("memory values are validated and bounded", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.save("project-1", { soul: 42 }), /必须是字符串/u);
    await assert.rejects(store.save("project-1", { memory: null }), /必须是字符串/u);
    await assert.rejects(
      store.save("project-1", { soul: "x".repeat(MAX_MEMORY_LENGTH + 1) }),
      /不能超过/u,
    );
    // A rejected save must not have written anything.
    assert.equal((await store.get("project-1")).updatedAt, null);
  });
});

test("memory survives a restart and damaged documents fail closed", async () => {
  await withStore(async ({ filePath, store }) => {
    await store.save("project-1", { soul: "人格", memory: "记忆" });
    const reopened = await createMemoryStore(filePath);
    assert.equal((await reopened.get("project-1")).memory, "记忆");

    await writeFile(filePath, JSON.stringify({ version: 1, projects: [{ projectId: "p" }] }), "utf8");
    await assert.rejects(reopened.get("project-1"), /invalid record/u);
    await writeFile(filePath, "{}", "utf8");
    await assert.rejects(reopened.get("project-1"), /unsupported or damaged/u);
  });
});

test("the injected block only contains what the project actually stored", () => {
  assert.equal(buildMemoryBlock({ soul: "", memory: "" }), "");
  assert.equal(buildMemoryBlock({ soul: "   ", memory: "\n" }), "");
  assert.equal(buildMemoryBlock(), "");

  const block = buildMemoryBlock({ soul: "你是内容策划", memory: "主推折叠琴" });
  assert.match(block, /^\[Agent 记忆 · 系统自动注入\]/u);
  assert.match(block, /## 人格（SOUL\.md）\n你是内容策划/u);
  assert.match(block, /## 长期记忆（MEMORY\.md）\n主推折叠琴/u);

  // Only the document that has content is included.
  const soulOnly = buildMemoryBlock({ soul: "你是内容策划", memory: "  " });
  assert.match(soulOnly, /## 人格（SOUL\.md）/u);
  assert.doesNotMatch(soulOnly, /MEMORY\.md/u);
});
