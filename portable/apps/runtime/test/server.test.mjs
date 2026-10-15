import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalRuntime } from "../src/server.mjs";
import { startManagedProcess, stopManagedProcess } from "../../../packages/platform/src/processes.mjs";

test("local runtime serves health only on loopback and logs its lifecycle", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-"));
  const dataDirectory = path.join(temporaryRoot, "data files");
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async () => ({
        ok: true,
        user: { id: "test-user", name: "Test User", role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: dataDirectory },
      home: temporaryRoot,
      port: 0,
    });
    assert.equal(runtime.address.address, "127.0.0.1");
    assert.equal(runtime.address.port > 0, true);

    const health = await fetch(`${runtime.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { service: "all-round-ai", status: "ok" });

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "test@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const sessionCookie = login.headers.get("set-cookie").split(";")[0];
    const page = await fetch(`${runtime.url}/`, { headers: { cookie: sessionCookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /All Round AI 工作台/);
    assert.match(pageHtml, /ALL ROUND AI · AI WORKSPACE/);
    assert.match(pageHtml, /href="workbench\.css"/);
    assert.match(pageHtml, /src="workbench\.js"/);
    assert.equal(new URL("workbench.css", `${runtime.url}/`).pathname, "/workbench.css");

    const style = await fetch(`${runtime.url}/workbench.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get("content-type"), /text\/css/);
    assert.match(await style.text(), /\.topbar/);

    const script = await fetch(`${runtime.url}/workbench.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.match(await script.text(), /submitMessage/);

    const loginPage = await fetch(`${runtime.url}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.headers.get("content-type"), /text\/html/);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /All Round AI 工作台/);
    assert.match(loginHtml, /href="login\.css"/);
    assert.match(loginHtml, /src="login\.js"/);
    assert.equal(new URL("login.css", `${runtime.url}/login`).pathname, "/login.css");
    const trailingSlash = await fetch(`${runtime.url}/login/?next=%2Fworkbench`, { redirect: "manual" });
    assert.equal(trailingSlash.status, 308);
    assert.equal(trailingSlash.headers.get("location"), "/login?next=%2Fworkbench");
    const loginStyle = await fetch(`${runtime.url}/login.css`);
    assert.equal(loginStyle.status, 200);
    assert.match(loginStyle.headers.get("content-type"), /text\/css/);
    assert.match(await loginStyle.text(), /\.login-form/);
    const loginScript = await fetch(`${runtime.url}/login.js`);
    assert.equal(loginScript.status, 200);
    assert.match(loginScript.headers.get("content-type"), /javascript/);
    assert.match(await loginScript.text(), /api\/auth\/login/);

    const head = await fetch(`${runtime.url}/`, { method: "HEAD", headers: { cookie: sessionCookie } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const unknown = await fetch(`${runtime.url}/not-a-workbench-file`);
    assert.equal(unknown.status, 404);

    await runtime.close();
    await runtime.close();
    const log = await readFile(path.join(dataDirectory, "logs", "runtime.jsonl"), "utf8");
    assert.match(log, /Local runtime started/);
    assert.match(log, /Local runtime stopped/);
    await assert.rejects(fetch(`${runtime.url}/health`));
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime rejects invalid ports before opening a listener", async () => {
  await assert.rejects(startLocalRuntime({ port: 65536 }), /Port must be an integer/);
  await assert.rejects(startLocalRuntime({ port: "not-a-port" }), /Port must be an integer/);
});

test("runtime falls back to the workbench shell for client routes and serves the mock AI", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-ai-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async () => ({
        ok: true,
        user: { id: "test-user", name: "Test User", role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: dataDirectory },
      home: temporaryRoot,
      port: 0,
    });

    // Unauthenticated API calls are rejected instead of leaking data.
    assert.equal((await fetch(`${runtime.url}/api/ai/models`)).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/admin/accounts`, { method: "POST" })).status, 405);

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "test@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    // Deep client-side routes resolve to the same workbench shell.
    const deepRoute = await fetch(`${runtime.url}/workbench/chat/42`, { headers: { cookie } });
    assert.equal(deepRoute.status, 200);
    assert.match(deepRoute.headers.get("content-type"), /text\/html/);
    assert.match(await deepRoute.text(), /All Round AI 工作台/);

    const models = await fetch(`${runtime.url}/api/ai/models`, { headers: { cookie } });
    assert.equal(models.status, 200);
    const modelPayload = await models.json();
    assert.equal(modelPayload.provider, "mock");
    assert.equal(modelPayload.models.length >= 1, true);

    const chat = await fetch(`${runtime.url}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
    });
    assert.equal(chat.status, 200);
    const chatPayload = await chat.json();
    assert.equal(chatPayload.finishReason, "stop");
    assert.match(chatPayload.content, /你好/);

    const stream = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ messages: [{ role: "user", content: "流式测试" }] }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    const streamBody = await stream.text();
    assert.match(streamBody, /^data: /m);
    assert.match(streamBody, /"finishReason":"stop"/);
    // Deltas are split across SSE frames, so the reply is reassembled to check
    // that the full text (including the user's question) survives streaming.
    const streamed = streamBody
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((payload) => payload.delta)
      .map((payload) => payload.delta)
      .join("");
    assert.match(streamed, /流式测试/);

    // A JSON endpoint rejects non-JSON bodies with 415.
    const badBody = await fetch(`${runtime.url}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: runtime.url, cookie },
      body: "plain text",
    });
    assert.equal(badBody.status, 415);

    assert.match(deepRoute.headers.get("x-request-id"), /^[0-9a-f]{32}$/);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("conversation history is persisted per account through the API", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-history-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "member", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: dataDirectory },
      home: temporaryRoot,
      port: 0,
    });
    const jsonHeaders = (sessionCookie) => ({
      "content-type": "application/json",
      origin: runtime.url,
      cookie: sessionCookie,
    });
    async function login(username) {
      const response = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: runtime.url },
        body: JSON.stringify({ user: username, password: "synthetic-test-password" }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }

    assert.equal((await fetch(`${runtime.url}/api/conversations`)).status, 401);

    const owner = await login("owner@example.test");
    assert.deepEqual(await (await fetch(`${runtime.url}/api/conversations`, { headers: { cookie: owner } })).json(),
      { conversations: [] });

    const created = await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: jsonHeaders(owner), body: "{}",
    });
    assert.equal(created.status, 201);
    const { conversation } = await created.json();
    assert.equal(conversation.title, "新对话");

    const appended = await fetch(`${runtime.url}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ role: "user", content: "把季度目标拆成周计划" }),
    });
    assert.equal(appended.status, 201);

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversation.id}`,
      { headers: { cookie: owner } })).json();
    assert.equal(detail.conversation.title, "把季度目标拆成周计划");
    assert.equal(detail.conversation.messages.length, 1);

    // The stored history is scoped to the signed-in account.
    const stranger = await login("stranger@example.test");
    const strangerList = await (await fetch(`${runtime.url}/api/conversations`, { headers: { cookie: stranger } })).json();
    assert.deepEqual(strangerList.conversations, []);
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversation.id}`, { headers: { cookie: stranger } })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversation.id}`, {
      method: "DELETE", headers: { cookie: stranger },
    })).status, 404);

    const rejected = await fetch(`${runtime.url}/api/conversations/${conversation.id}/messages`, {
      method: "POST", headers: jsonHeaders(owner), body: JSON.stringify({ role: "system", content: "x" }),
    });
    assert.equal(rejected.status, 400);

    const removed = await fetch(`${runtime.url}/api/conversations/${conversation.id}`, {
      method: "DELETE", headers: { cookie: owner },
    });
    assert.equal(removed.status, 200);
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversation.id}`, { headers: { cookie: owner } })).status, 404);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime command starts, answers health checks, logs, and shuts down cleanly", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-cli-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const mainPath = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  let child;
  let output = "";
  let errors = "";
  try {
    child = await startManagedProcess(process.execPath, [mainPath], {
      env: {
        ...process.env,
        ALLROUND_AI_DATA_DIR: dataDirectory,
        ALLROUND_AI_PORT: "0",
        LOCALAPPDATA: temporaryRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shutdownMessage: "shutdown",
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (errors += chunk));

    const runtimeUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime did not start: ${errors}`)), 5000);
      const checkReady = () => {
        const match = output.match(/All-Round-AI local runtime: (http:\/\/127\.0\.0\.1:\d+)\/login/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", checkReady);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`runtime exited before ready (${code}): ${errors}`));
      });
      checkReady();
    });

    const response = await fetch(`${runtimeUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "all-round-ai", status: "ok" });
    assert.deepEqual(await stopManagedProcess(child), { code: 0, signal: null });
    const log = await readFile(path.join(dataDirectory, "logs", "runtime.jsonl"), "utf8");
    assert.match(log, /Local runtime started/);
    assert.match(log, /Local runtime stopped/);
  } finally {
    if (child) await stopManagedProcess(child).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
