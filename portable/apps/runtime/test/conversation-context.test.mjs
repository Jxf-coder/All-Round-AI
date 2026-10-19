import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationStore } from "../src/conversations.mjs";
import { startLocalRuntime } from "../src/server.mjs";

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "allround-context-store-"));
  try {
    const store = await createConversationStore(path.join(directory, "conversations.json"));
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a conversation remembers the panel it was last viewed in without reordering history", async () => {
  await withStore(async (store) => {
    const conversation = await store.create("owner-1", { title: "知识库讨论" });
    assert.equal(conversation.pageContext, null);

    const saved = await store.setPageContext("owner-1", conversation.id, { panel: "database", label: "知识库" });
    assert.deepEqual(saved, { panel: "database", label: "知识库" });

    const loaded = await store.get("owner-1", conversation.id);
    assert.deepEqual(loaded.pageContext, { panel: "database", label: "知识库" });
    // Bookkeeping must not make the conversation look freshly active.
    assert.equal(loaded.updatedAt, conversation.updatedAt);

    const [summary] = await store.list("owner-1");
    assert.deepEqual(summary.pageContext, { panel: "database", label: "知识库" });
  });
});

test("page context is scoped to its owner and can be cleared", async () => {
  await withStore(async (store) => {
    const conversation = await store.create("owner-1");
    await store.setPageContext("owner-1", conversation.id, { panel: "skills", label: "Skill" });

    assert.equal(await store.setPageContext("owner-2", conversation.id, { panel: "agent", label: "Agent" }), null);
    assert.deepEqual((await store.get("owner-1", conversation.id)).pageContext, { panel: "skills", label: "Skill" });

    assert.equal(await store.setPageContext("owner-1", conversation.id, null), null);
    assert.equal((await store.get("owner-1", conversation.id)).pageContext, null);
  });
});

test("malformed page contexts are rejected instead of stored", async () => {
  await withStore(async (store) => {
    const conversation = await store.create("owner-1");
    await assert.rejects(() => store.setPageContext("owner-1", conversation.id, "database"), /must be an object/);
    await assert.rejects(() => store.setPageContext("owner-1", conversation.id, {}), /panel is required/);
    await assert.rejects(
      () => store.setPageContext("owner-1", conversation.id, { panel: "x".repeat(41) }),
      /panel is required/,
    );
  });
});

test("the page-context endpoint is authenticated and validated", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-context-api-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "context@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    const created = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const conversationId = (await created.json()).conversation.id;

    // Unauthenticated requests are rejected before validation.
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversationId}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ panel: "database", label: "知识库" }),
    })).status, 401);

    const saved = await fetch(`${runtime.url}/api/conversations/${conversationId}/context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ panel: "database", label: "知识库" }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ok: true, pageContext: { panel: "database", label: "知识库" } });

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.deepEqual(detail.conversation.pageContext, { panel: "database", label: "知识库" });

    // An unknown panel is a client error, and an unknown conversation is 404.
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversationId}/context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ panel: "not-a-panel", label: "x" }),
    })).status, 400);
    assert.equal((await fetch(`${runtime.url}/api/conversations/missing/context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ panel: "database", label: "知识库" }),
    })).status, 404);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
