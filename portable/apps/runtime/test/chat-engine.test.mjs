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

function createProvider(id, label) {
  const calls = [];
  return {
    id,
    label,
    calls,
    async listModels() { return [{ id: `${id}-model`, name: `${label} Model` }]; },
    async chat({ model }) {
      calls.push({ model });
      return { id, content: `${id} reply`, model, finishReason: "stop" };
    },
    async *streamChat({ model, effort, fast }) {
      calls.push({ model, effort, fast });
      yield { delta: `${id} reply` };
      yield { finishReason: "stop" };
    },
  };
}

async function withRuntime(run) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-engine-"));
  const alpha = createProvider("alpha", "Alpha");
  const beta = createProvider("beta", "Beta");
  let runtime;
  try {
    runtime = await startLocalRuntime({
      aiProviders: [alpha, beta],
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
      body: JSON.stringify({ user: "engine@example.test", password: "synthetic-test-password" }),
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
    await run({ runtime, cookie, headers, ask, createConversation, alpha, beta });
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("the model list advertises every engine and switches models per engine", async () => {
  await withRuntime(async ({ runtime, cookie }) => {
    const payload = await (await fetch(`${runtime.url}/api/ai/models`, { headers: { cookie } })).json();
    assert.equal(payload.provider, "alpha");
    assert.deepEqual(payload.engines, [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
    ]);
    assert.deepEqual(payload.models.map((model) => model.id), ["alpha-model"]);

    const beta = await (await fetch(`${runtime.url}/api/ai/models?engine=beta`, { headers: { cookie } })).json();
    assert.equal(beta.provider, "beta");
    assert.deepEqual(beta.models.map((model) => model.id), ["beta-model"]);
  });
});

test("an explicit engine runs on that provider and is reported in meta", async () => {
  await withRuntime(async ({ ask, createConversation, alpha, beta }) => {
    const events = await ask({
      conversationId: await createConversation(),
      content: "用另一个引擎",
      engine: "beta",
    });
    const meta = events.find((event) => event.meta).meta;
    assert.equal(meta.engine, "beta");
    assert.equal(meta.model, "beta-model");
    assert.equal(beta.calls.length, 1);
    assert.equal(alpha.calls.length, 0);
    assert.equal(events.at(-1).done, true);
  });
});

test("a missing or unknown engine falls back to the default engine", async () => {
  await withRuntime(async ({ ask, createConversation, alpha }) => {
    const fallback = await ask({
      conversationId: await createConversation(),
      content: "默认引擎",
      engine: "retired-engine",
    });
    assert.equal(fallback.find((event) => event.meta).meta.engine, "alpha");
    assert.equal(alpha.calls.length, 1);

    const implicit = await ask({ conversationId: await createConversation(), content: "没写引擎" });
    assert.equal(implicit.find((event) => event.meta).meta.engine, "alpha");
    assert.equal(alpha.calls.length, 2);
  });
});

test("the turn record keeps the engine it ran with", async () => {
  await withRuntime(async ({ runtime, cookie, ask, createConversation }) => {
    const conversationId = await createConversation();
    await ask({ conversationId, content: "记住引擎", engine: "beta" });
    const live = await (await fetch(`${runtime.url}/api/ai/chat/live?conversationId=${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(live.turn.engine, "beta");
  });
});

test("the default engine still uses the installation model setting", async () => {
  await withRuntime(async ({ runtime, headers, ask, createConversation, alpha }) => {
    const saved = await fetch(`${runtime.url}/api/settings/ai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "alpha-model" }),
    });
    assert.equal(saved.status, 200);
    const events = await ask({ conversationId: await createConversation(), content: "默认" });
    assert.equal(events.find((event) => event.meta).meta.model, "alpha-model");
    assert.equal(alpha.calls.at(-1).model, "alpha-model");
  });
});
