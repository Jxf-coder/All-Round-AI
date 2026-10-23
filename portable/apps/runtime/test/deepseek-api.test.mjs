import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function stubConfigStore(secret = "") {
  const values = new Map();
  const secrets = new Map(secret ? [["ai.apiKey", secret]] : []);
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async getSecret(key) { return secrets.get(key) ?? null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
  };
}

async function bootRuntime(env, options = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-deepseek-api-"));
  const runtime = await startLocalRuntime({
    ...options,
    authProvider: async ({ user }) => ({
      ok: true,
      user: { id: user, name: user, role: "admin", source: "all-round-ai" },
      landing: "/",
    }),
    env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data"), ...env },
    home: temporaryRoot,
    port: 0,
  });
  const login = await fetch(`${runtime.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: runtime.url },
    body: JSON.stringify({ user: "deepseek@example.test", password: "synthetic-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return {
    runtime,
    cookie,
    async close() {
      await runtime.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("DeepSeek is registered when a key is configured and can answer chat", async () => {
  const seen = [];
  const stub = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    seen.push({ auth: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "DeepSeek 回复" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const deepseekUrl = `http://127.0.0.1:${stub.address().port}`;
  const app = await bootRuntime({
    ALLROUND_AI_DEEPSEEK_KEY: "sk-test",
    ALLROUND_AI_DEEPSEEK_URL: deepseekUrl,
    ALLROUND_AI_ENGINE: "deepseek",
  });
  try {
    const models = await (await fetch(`${app.runtime.url}/api/ai/models`, {
      headers: { cookie: app.cookie },
    })).json();
    assert.deepEqual(models.engines.map((engine) => engine.id), ["mock", "deepseek"]);
    assert.equal(models.provider, "deepseek");
    assert.deepEqual(models.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);

    const reply = await fetch(`${app.runtime.url}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.runtime.url, cookie: app.cookie },
      body: JSON.stringify({
        engine: "deepseek",
        model: "deepseek-chat",
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).content, "DeepSeek 回复");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer sk-test");
    assert.equal(seen[0].body.model, "deepseek-chat");
  } finally {
    await app.close();
    await new Promise((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a key stored in settings registers DeepSeek on the next start", async () => {
  const seen = [];
  const stub = createServer(async (request, response) => {
    seen.push(request.headers.authorization);
    await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "存储密钥回复" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const deepseekUrl = `http://127.0.0.1:${stub.address().port}`;
  const app = await bootRuntime(
    { ALLROUND_AI_DEEPSEEK_URL: deepseekUrl, ALLROUND_AI_ENGINE: "deepseek" },
    { configStore: stubConfigStore("sk-stored") },
  );
  try {
    const models = await (await fetch(`${app.runtime.url}/api/ai/models`, {
      headers: { cookie: app.cookie },
    })).json();
    assert.deepEqual(models.engines.map((engine) => engine.id), ["mock", "deepseek"]);
    assert.equal(models.provider, "deepseek");

    const reply = await fetch(`${app.runtime.url}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.runtime.url, cookie: app.cookie },
      body: JSON.stringify({
        engine: "deepseek",
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).content, "存储密钥回复");
    assert.equal(seen[0], "Bearer sk-stored");
  } finally {
    await app.close();
    await new Promise((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
  }
});

test("without a DeepSeek key only the mock engine is exposed", async () => {
  const app = await bootRuntime({});
  try {
    const models = await (await fetch(`${app.runtime.url}/api/ai/models`, {
      headers: { cookie: app.cookie },
    })).json();
    assert.deepEqual(models.engines.map((engine) => engine.id), ["mock"]);
    assert.equal(models.provider, "mock");
  } finally {
    await app.close();
  }
});
