import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

function parseSse(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

// Records what the runtime actually asked the provider to run, so "effort is
// forwarded" is verified rather than assumed.
function createRecordingProvider() {
  const seen = [];
  return {
    seen,
    id: "recording",
    label: "Recording",
    async listModels() { return [{ id: "recording-1", name: "Recording Pro" }]; },
    async chat({ model }) { return { id: "r", content: "ok", model, finishReason: "stop" }; },
    async *streamChat({ model, effort, fast }) {
      seen.push({ model, effort, fast });
      yield { delta: "收到" };
      yield { finishReason: "stop" };
    },
  };
}

async function withRuntime(run) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-effort-"));
  const provider = createRecordingProvider();
  let runtime;
  try {
    runtime = await startLocalRuntime({
      aiProvider: provider,
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
      body: JSON.stringify({ user: "effort@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const ask = async (body) => {
      const response = await fetch(`${runtime.url}/api/ai/chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return parseSse(await response.text());
    };
    const createConversation = async () => {
      const response = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 201);
      return (await response.json()).conversation.id;
    };
    await run({ runtime, cookie, headers, ask, createConversation, provider });
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("the model list carries the effort levels so the composer renders one source of truth", async () => {
  await withRuntime(async ({ runtime, cookie }) => {
    const response = await fetch(`${runtime.url}/api/ai/models`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.provider, "recording");
    assert.deepEqual(payload.efforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(payload.efforts.every((effort) => typeof effort.zh === "string" && typeof effort.hint === "string"), true);
  });
});

test("an explicit effort and Fast mode reach the provider and are echoed in meta", async () => {
  await withRuntime(async ({ ask, createConversation, provider }) => {
    const conversationId = await createConversation();
    const events = await ask({ conversationId, content: "随便问问", effort: "xhigh", fast: true });
    const meta = events.find((event) => event.meta)?.meta;
    assert.equal(meta.effort, "xhigh");
    assert.equal(meta.fast, true);
    assert.equal(meta.model, "recording-1");
    // The provider really receives the chosen level, not just the client's copy.
    assert.deepEqual(provider.seen[0], { model: "recording-1", effort: "xhigh", fast: true });
    // A stage event drives the composer's live hint and is not part of the reply.
    assert.equal(events.some((event) => event.stage === true && typeof event.status === "string"), true);
    assert.equal(events.at(-1).done, true);
  });
});

test("an omitted effort is chosen by the runtime and reported back", async () => {
  await withRuntime(async ({ ask, createConversation, provider }) => {
    const complex = await ask({
      conversationId: await createConversation(),
      content: "帮我分析一下整个架构设计方案并给出对比评估",
    });
    assert.equal(complex.find((event) => event.meta).meta.effort, "high");
    assert.equal(provider.seen.at(-1).effort, "high");

    const greeting = await ask({ conversationId: await createConversation(), content: "你好" });
    assert.equal(greeting.find((event) => event.meta).meta.effort, "low");
    assert.equal(provider.seen.at(-1).effort, "low");
  });
});

test("an unrecognised effort is normalised rather than passed through", async () => {
  await withRuntime(async ({ ask, createConversation, provider }) => {
    const events = await ask({
      conversationId: await createConversation(),
      content: "随便问问",
      effort: "ultra",
    });
    assert.equal(events.find((event) => event.meta).meta.effort, "medium");
    assert.equal(provider.seen.at(-1).effort, "medium");
  });
});

test("the turn record keeps the effort and Fast mode it ran with", async () => {
  await withRuntime(async ({ runtime, cookie, ask, createConversation }) => {
    const conversationId = await createConversation();
    await ask({ conversationId, content: "看一下", effort: "high", fast: true });
    const live = await (await fetch(`${runtime.url}/api/ai/chat/live?conversationId=${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(live.turn.effort, "high");
    assert.equal(live.turn.fast, true);
  });
});
