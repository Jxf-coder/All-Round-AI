import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("the trailing answer can be dropped for a retry", async () => {
  await withStore(async ({ store }) => {
    const { id } = await store.create("user-1");
    assert.equal(await store.dropTrailingAssistant("user-1", id), false, "nothing to drop yet");

    await store.appendMessage("user-1", id, { role: "user", content: "问题" });
    assert.equal(await store.dropTrailingAssistant("user-1", id), false, "the trailing turn is the question");

    await store.appendMessage("user-1", id, { role: "assistant", content: "第一次回答" });
    assert.equal(await store.dropTrailingAssistant("user-1", id), true);
    const afterDrop = await store.get("user-1", id);
    assert.equal(afterDrop.messages.length, 1);
    assert.equal(afterDrop.messages[0].role, "user");
    // The question survives, so the retry does not duplicate it.
    assert.equal((await store.dropTrailingAssistant("user-1", id)), false);

    assert.equal(await store.dropTrailingAssistant("user-1", "missing"), null);
    assert.equal(await store.dropTrailingAssistant("user-2", id), null);
  });
});

test("conversations are scoped to the project they were started in", async () => {
  await withStore(async ({ filePath, store }) => {
    const inRoot = await store.create("user-1", { projectId: "project-root" });
    const inRole = await store.create("user-1", { projectId: "project-role" });
    assert.equal(inRoot.projectId, "project-root");
    // Without a project filter the whole history is listed (used by the tests
    // and any future "all conversations" view).
    assert.equal((await store.list("user-1")).length, 2);
    assert.deepEqual(
      (await store.list("user-1", { projectId: "project-root" })).map((item) => item.id),
      [inRoot.id],
    );
    assert.deepEqual(
      (await store.list("user-1", { projectId: "project-role" })).map((item) => item.id),
      [inRole.id],
    );
    assert.deepEqual(await store.list("user-1", { projectId: "project-empty" }), []);

    // A conversation written before project scoping existed has no projectId;
    // it is shown under the project named as the unassigned fallback instead of
    // disappearing, and the stored document is left untouched.
    const document = JSON.parse(await readFile(filePath, "utf8"));
    document.conversations.push({
      id: "legacy",
      ownerId: "user-1",
      title: "旧对话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    await writeFile(filePath, JSON.stringify(document), "utf8");
    const withLegacy = await store.list("user-1", {
      projectId: "project-root",
      unassignedProjectId: "project-root",
    });
    assert.deepEqual(withLegacy.map((item) => item.id).sort(), ["legacy", inRoot.id].sort());
    assert.equal((await store.list("user-1", {
      projectId: "project-role",
      unassignedProjectId: "project-root",
    })).length, 1);

    await assert.rejects(store.create("user-1", { projectId: "" }), TypeError);
    await assert.rejects(store.create("user-1", { projectId: 7 }), TypeError);
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
