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

test("Ollama is registered only when a URL is configured and can become the default engine", async () => {
  const stub = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const body = JSON.parse(await readBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: body.model,
        message: { role: "assistant", content: "本地模型回复" },
        done: true,
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const ollamaUrl = `http://127.0.0.1:${stub.address().port}`;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-ollama-api-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: {
        ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data"),
        ALLROUND_AI_OLLAMA_URL: ollamaUrl,
        ALLROUND_AI_ENGINE: "ollama",
        OLLAMA_HOST: ollamaUrl,
      },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "ollama@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    const models = await (await fetch(`${runtime.url}/api/ai/models`, { headers: { cookie } })).json();
    assert.deepEqual(models.engines.map((engine) => engine.id), ["mock", "ollama"]);
    assert.equal(models.provider, "ollama");
    assert.deepEqual(models.models, [{ id: "llama3.2:latest", name: "llama3.2" }]);

    const reply = await fetch(`${runtime.url}/api/ai/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        engine: "ollama",
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).content, "本地模型回复");
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await new Promise((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("without an Ollama URL the runtime exposes only the mock engine", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-ollama-off-"));
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
      body: JSON.stringify({ user: "no-ollama@example.test", password: "synthetic-test-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const models = await (await fetch(`${runtime.url}/api/ai/models`, { headers: { cookie } })).json();
    assert.deepEqual(models.engines.map((engine) => engine.id), ["mock"]);
    assert.equal(models.provider, "mock");
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
