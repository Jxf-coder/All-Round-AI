import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { conversationTitle, createConversationStore } from "../src/conversations.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-conversations-"));
  const filePath = path.join(root, "conversations.json");
  try {
    await run({ filePath, store: await createConversationStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("conversations are created empty and listed newest first", async () => {
  await withStore(async ({ store }) => {
    assert.deepEqual(await store.list("user-1"), []);
    const first = await store.create("user-1");
    assert.equal(first.title, "新对话");
    assert.equal(first.messageCount, 0);
    await store.create("user-1", { title: "第二条" });
    const listed = await store.list("user-1");
    assert.equal(listed.length, 2);
    assert.equal(listed.some((item) => item.id === first.id), true);
    // The most recently updated conversation sorts first.
    assert.equal(listed[0].title, "第二条");
  });
});

test("the first user message names the conversation", async () => {
  await withStore(async ({ store }) => {
    const { id } = await store.create("user-1");
    await store.appendMessage("user-1", id, { role: "user", content: "帮我梳理今天的计划" });
    const conversation = await store.get("user-1", id);
    assert.equal(conversation.title, "帮我梳理今天的计划");
    assert.equal(conversation.messageCount, 1);
    assert.equal(conversation.messages[0].role, "user");
    // Later turns must not rename an already titled conversation.
    await store.appendMessage("user-1", id, { role: "assistant", content: "好的" });
    await store.appendMessage("user-1", id, { role: "user", content: "再改个名字" });
    assert.equal((await store.get("user-1", id)).title, "帮我梳理今天的计划");
  });
});

test("long titles are truncated instead of growing unbounded", () => {
  const title = conversationTitle("一".repeat(400));
  assert.equal(title.length <= 120, true);
  assert.match(title, /…$/);
  assert.equal(conversationTitle("   "), "新对话");
  assert.equal(conversationTitle("多  空格\n换行"), "多 空格 换行");
});

test("conversations are scoped to their owner", async () => {
  await withStore(async ({ store }) => {
    const { id } = await store.create("user-1");
    assert.deepEqual(await store.list("user-2"), []);
    assert.equal(await store.get("user-2", id), null);
    assert.equal(await store.appendMessage("user-2", id, { role: "user", content: "越权" }), null);
    assert.equal(await store.remove("user-2", id), false);
    assert.equal((await store.get("user-1", id)).messageCount, 0);
  });
});

test("message payloads are validated", async () => {
  await withStore(async ({ store }) => {
    const { id } = await store.create("user-1");
    await assert.rejects(store.appendMessage("user-1", id, { role: "system", content: "x" }), /role/);
    await assert.rejects(store.appendMessage("user-1", id, { role: "user", content: "   " }), /content/);
    await assert.rejects(
      store.appendMessage("user-1", id, { role: "user", content: "x".repeat(8001) }),
      /消息长度/,
    );
    await assert.rejects(store.create(""), TypeError);
    await assert.rejects(store.list(""), TypeError);
  });
});

test("conversations survive a restart and removal only affects the target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-conversations-restart-"));
  const filePath = path.join(root, "conversations.json");
  try {
    const store = await createConversationStore(filePath);
    const kept = await store.create("user-1", { title: "保留" });
    const dropped = await store.create("user-1", { title: "删除" });
    await store.appendMessage("user-1", kept.id, { role: "user", content: "hello" });

    const reopened = await createConversationStore(filePath);
    assert.equal((await reopened.get("user-1", kept.id)).messages[0].content, "hello");
    assert.equal(await reopened.remove("user-1", dropped.id), true);
    assert.equal((await reopened.list("user-1")).length, 1);
    assert.equal(await reopened.remove("user-1", dropped.id), false);

    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /保留/);
    assert.doesNotMatch(raw, /删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
