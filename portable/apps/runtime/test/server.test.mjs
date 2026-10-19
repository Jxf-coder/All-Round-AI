import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalRuntime } from "../src/server.mjs";
import { createMockAiProvider } from "../src/ai/mock-provider.mjs";
import { DEFAULT_MAX_MESSAGES } from "../src/ai/context.mjs";
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
    assert.match(pageHtml, /id="panel-view"/);
    assert.match(pageHtml, /aria-label="人格与记忆"/);
    assert.equal(new URL("workbench.css", `${runtime.url}/`).pathname, "/workbench.css");

    const style = await fetch(`${runtime.url}/workbench.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get("content-type"), /text\/css/);
    assert.match(await style.text(), /\.topbar/);

    const script = await fetch(`${runtime.url}/workbench.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    const scriptSource = await script.text();
    assert.match(scriptSource, /submitMessage/);
    assert.match(scriptSource, /knowledgeAction/);
    assert.match(scriptSource, /openMemory/);
    assert.match(scriptSource, /openEffortMenu/);
    assert.match(scriptSource, /stopLiveHint/);
    assert.match(pageHtml, /id="effort-button"/);
    assert.match(pageHtml, /id="fast-toggle"/);
    assert.match(pageHtml, /id="live-hint"/);

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

    // Model settings: readable by any signed-in account, writable by admins.
    assert.equal((await fetch(`${runtime.url}/api/settings/ai`)).status, 401);
    const settings = await fetch(`${runtime.url}/api/settings/ai`, { headers: { cookie } });
    assert.equal(settings.status, 200);
    const settingsPayload = await settings.json();
    assert.equal(settingsPayload.provider, "mock");
    assert.equal(settingsPayload.apiKeyConfigured, false);
    assert.equal(typeof settingsPayload.providerLabel, "string");

    const targetModel = settingsPayload.models.at(-1).id;
    const saved = await fetch(`${runtime.url}/api/settings/ai`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ model: targetModel, apiKey: "sk-test-value" }),
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json();
    assert.equal(savedPayload.model, targetModel);
    assert.equal(savedPayload.apiKeyConfigured, true);
    assert.equal(JSON.stringify(savedPayload).includes("sk-test-value"), false);

    const rejectedModel = await fetch(`${runtime.url}/api/settings/ai`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ model: "no-such-model" }),
    });
    assert.equal(rejectedModel.status, 400);

    // The configured model becomes the default for chat requests.
    const chat = await fetch(`${runtime.url}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
    });
    assert.equal(chat.status, 200);
    const chatPayload = await chat.json();
    assert.equal(chatPayload.model, targetModel);
    assert.equal(chatPayload.finishReason, "stop");
    assert.match(chatPayload.content, /你好/);

    const created = await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url, cookie }, body: "{}",
    });
    assert.equal(created.status, 201);
    const conversationId = (await created.json()).conversation.id;

    // Streaming requires an explicit conversation so the server can own context
    // and persistence.
    const withoutConversation = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ content: "没有对话" }),
    });
    assert.equal(withoutConversation.status, 400);

    const stream = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "流式测试" }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    const streamBody = await stream.text();
    assert.match(streamBody, /^data: /m);
    assert.match(streamBody, /"finishReason":"stop"/);
    assert.match(streamBody, /"done":true/);
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

    // The server stored both turns and replays them as context next time.
    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(detail.conversation.messages.length, 2);
    assert.equal(detail.conversation.messages[0].role, "user");
    assert.equal(detail.conversation.messages[0].content, "流式测试");
    assert.equal(detail.conversation.messages[1].role, "assistant");
    assert.equal(detail.conversation.messages[1].content, streamed);
    assert.equal(detail.conversation.title, "流式测试");

    // Retry regenerates the last answer without duplicating the question.
    const retried = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, retry: true }),
    });
    assert.equal(retried.status, 200);
    await retried.text();
    const afterRetry = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(afterRetry.conversation.messages.length, 2);
    assert.equal(afterRetry.conversation.messages[1].role, "assistant");

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

test("the provider receives the stored conversation as context", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-context-"));
  const seen = [];
  let runtime;
  try {
    // Records what the provider is actually asked, so "context is replayed" is a
    // verified claim rather than an assumption.
    const recording = {
      id: "recording",
      label: "Recording",
      async listModels() { return [{ id: "recording-1", name: "Recording" }]; },
      async chat({ messages }) { seen.push(messages); return { content: "ok", finishReason: "stop" }; },
      async *streamChat({ messages }) {
        seen.push(messages);
        yield { delta: "收到" };
        yield { finishReason: "stop" };
      },
    };
    runtime = await startLocalRuntime({
      aiProvider: recording,
      authProvider: async () => ({
        ok: true,
        user: { id: "context-user", name: "Context User", role: "admin", source: "all-round-ai" },
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
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const created = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const conversationId = (await created.json()).conversation.id;

    const ask = async (content) => {
      const response = await fetch(`${runtime.url}/api/ai/chat/stream`, {
        method: "POST", headers, body: JSON.stringify({ conversationId, content }),
      });
      assert.equal(response.status, 200);
      await response.text();
    };

    await ask("第一个问题");
    assert.deepEqual(seen[0], [{ role: "user", content: "第一个问题" }]);

    // The second turn carries the earlier exchange, not just the new question.
    await ask("第二个问题");
    assert.deepEqual(seen[1], [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "第二个问题" },
    ]);

    // Retry replays the same history without adding a second question.
    const retried = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST", headers, body: JSON.stringify({ conversationId, retry: true }),
    });
    assert.equal(retried.status, 200);
    await retried.text();
    assert.deepEqual(seen[2], [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "第二个问题" },
    ]);

    // A long conversation is windowed instead of replayed in full: the opening
    // exchange is gone, the window stays within the limit, and it still reads as
    // a well-formed exchange that ends on the question being answered.
    for (let index = 0; index < DEFAULT_MAX_MESSAGES + 4; index += 1) {
      await ask(`追问 ${index}`);
    }
    const windowed = seen.at(-1);
    assert.equal(windowed.length <= DEFAULT_MAX_MESSAGES, true);
    assert.equal(windowed.some((message) => message.content === "第一个问题"), false);
    assert.deepEqual(windowed.at(-1), { role: "user", content: `追问 ${DEFAULT_MAX_MESSAGES + 3}` });
    assert.deepEqual(
      windowed.map((message) => message.role),
      windowed.map((_, index) => (index % 2 === 0 ? "user" : "assistant")),
    );
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stopping a reply keeps the partial answer and marks the turn cancelled", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-stop-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      // A slow stream is required to interrupt it mid-answer.
      aiProvider: createMockAiProvider({ chunkSize: 2, streamDelayMs: 25 }),
      authProvider: async () => ({
        ok: true,
        user: { id: "stop-user", name: "Stop User", role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "stop@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const created = await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url, cookie }, body: "{}",
    });
    const conversationId = (await created.json()).conversation.id;

    const stream = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "请给一个较长的回答" }),
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    // Wait for the first token so the cancelled answer is a real partial reply
    // rather than an empty turn cancelled before anything was produced.
    let body = "";
    while (!body.includes('"delta"')) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    assert.match(body, /"delta"/);
    // Stopping is now an explicit cancel of the turn: closing the socket alone
    // no longer stops it, so the cancel must be sent for the reply to end.
    const cancelled = await fetch(`${runtime.url}/api/ai/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { ok: true, cancelled: true });

    // The original stream observes the terminal state instead of being cut off.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    assert.match(body, /"status":"cancelled"/);

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(detail.conversation.messages.length, 2);
    assert.equal(detail.conversation.messages[0].content, "请给一个较长的回答");
    const partial = detail.conversation.messages[1];
    assert.equal(partial.role, "assistant");
    assert.equal(partial.content.length > 0, true);

    // A second, uninterrupted reply gives the full text, so "the partial answer
    // was kept" is checked against the real thing instead of a magic length.
    const second = await (await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url, cookie }, body: "{}",
    })).json();
    const fullStream = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId: second.conversation.id, content: "请给一个较长的回答" }),
    });
    await fullStream.text();
    const fullDetail = await (await fetch(`${runtime.url}/api/conversations/${second.conversation.id}`,
      { headers: { cookie } })).json();
    const full = fullDetail.conversation.messages[1].content;
    assert.equal(full.startsWith(partial.content), true, "the kept answer must be a prefix of the full reply");
    assert.equal(partial.content.length < full.length, true, "the interrupted answer must be shorter than the full reply");
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("model settings are read-only for members", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-settings-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async () => ({
        ok: true,
        user: { id: "member-1", name: "Member", role: "member", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "member@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const readable = await fetch(`${runtime.url}/api/settings/ai`, { headers: { cookie } });
    assert.equal(readable.status, 200);
    const current = await readable.json();

    const forbidden = await fetch(`${runtime.url}/api/settings/ai`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ model: current.models.at(-1).id }),
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "没有管理员权限" });
    // The refused write must not have changed anything.
    assert.equal((await (await fetch(`${runtime.url}/api/settings/ai`, { headers: { cookie } })).json()).model, current.model);
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
    const initial = await (await fetch(`${runtime.url}/api/conversations`, { headers: { cookie: owner } })).json();
    assert.deepEqual(initial.conversations, []);
    // Without a projectId the default company root is used.
    assert.equal(typeof initial.projectId, "string");

    const created = await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: jsonHeaders(owner), body: "{}",
    });
    assert.equal(created.status, 201);
    const { conversation } = await created.json();
    assert.equal(conversation.title, "新对话");
    assert.equal(conversation.projectId, initial.projectId);

    // History is scoped per project: a conversation started in a role is not
    // listed under the company root, and vice versa.
    const roleResponse = await fetch(`${runtime.url}/api/projects`, {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ name: "新媒体运营", type: "child", parentId: initial.projectId }),
    });
    assert.equal(roleResponse.status, 201);
    const { project: role } = await roleResponse.json();
    const scoped = await (await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: jsonHeaders(owner), body: JSON.stringify({ projectId: role.id }),
    })).json();
    assert.equal(scoped.conversation.projectId, role.id);
    const roleList = await (await fetch(`${runtime.url}/api/conversations?projectId=${role.id}`,
      { headers: { cookie: owner } })).json();
    assert.deepEqual(roleList.conversations.map((item) => item.id), [scoped.conversation.id]);
    const rootList = await (await fetch(`${runtime.url}/api/conversations`,
      { headers: { cookie: owner } })).json();
    assert.deepEqual(rootList.conversations.map((item) => item.id), [conversation.id]);
    assert.equal((await fetch(`${runtime.url}/api/conversations?projectId=missing`, { headers: { cookie: owner } })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers: jsonHeaders(owner), body: JSON.stringify({ projectId: "missing" }),
    })).status, 400);

    const replied = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ conversationId: conversation.id, content: "把季度目标拆成周计划" }),
    });
    assert.equal(replied.status, 200);
    await replied.text();

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversation.id}`,
      { headers: { cookie: owner } })).json();
    assert.equal(detail.conversation.title, "把季度目标拆成周计划");
    assert.equal(detail.conversation.messages.length, 2);

    // The stored history is scoped to the signed-in account.
    const stranger = await login("stranger@example.test");
    const strangerList = await (await fetch(`${runtime.url}/api/conversations`, { headers: { cookie: stranger } })).json();
    assert.deepEqual(strangerList.conversations, []);
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversation.id}`, { headers: { cookie: stranger } })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/conversations/${conversation.id}`, {
      method: "DELETE", headers: { cookie: stranger },
    })).status, 404);
    // A stranger cannot post into someone else's conversation either.
    assert.equal((await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: jsonHeaders(stranger),
      body: JSON.stringify({ conversationId: conversation.id, content: "越权提问" }),
    })).status, 404);

    const emptyContent = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ conversationId: conversation.id, content: "   " }),
    });
    assert.equal(emptyContent.status, 400);
    // The refused attempts must not have touched the conversation.
    assert.equal((await (await fetch(`${runtime.url}/api/conversations/${conversation.id}`,
      { headers: { cookie: owner } })).json()).conversation.messages.length, 2);

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

test("the project tree is seeded, listed and created over the API", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-projects-"));
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
    assert.equal((await fetch(`${runtime.url}/api/projects`)).status, 401);

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: "synthetic-test-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    const seeded = await (await fetch(`${runtime.url}/api/projects`, { headers: { cookie } })).json();
    assert.equal(seeded.projects.length, 1);
    assert.equal(seeded.tree.length, 1);
    assert.equal(seeded.defaultProjectId, seeded.projects[0].id);
    const rootId = seeded.defaultProjectId;

    const createdRole = await fetch(`${runtime.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "产品经理", type: "child", parentId: rootId }),
    });
    assert.equal(createdRole.status, 201);
    const { project: role } = await createdRole.json();
    const createdSeat = await fetch(`${runtime.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "内容策划", type: "seat", parentId: role.id }),
    });
    assert.equal(createdSeat.status, 201);

    const after = await (await fetch(`${runtime.url}/api/projects`, { headers: { cookie } })).json();
    assert.equal(after.projects.length, 3);
    assert.deepEqual(after.tree[0].children.map((child) => child.name), ["产品经理"]);
    assert.deepEqual(after.tree[0].children[0].seats.map((seat) => seat.name), ["内容策划"]);

    // Validation failures answer 400 with the reason and write nothing.
    const invalidName = await fetch(`${runtime.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "   " }),
    });
    assert.equal(invalidName.status, 400);
    assert.deepEqual(await invalidName.json(), { error: "名称不能为空" });
    const orphanSeat = await fetch(`${runtime.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "孤儿岗位", type: "seat", parentId: rootId }),
    });
    assert.equal(orphanSeat.status, 400);
    assert.deepEqual(await orphanSeat.json(), { error: "只能在岗位下创建子岗位" });
    assert.equal((await (await fetch(`${runtime.url}/api/projects`, { headers: { cookie } })).json()).projects.length, 3);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("agent memory is stored per project and injected into the chat turn", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-memory-"));
  const seen = [];
  let runtime;
  try {
    const recording = {
      id: "recording",
      label: "Recording",
      async listModels() { return [{ id: "recording-1", name: "Recording" }]; },
      async chat({ messages }) { seen.push(messages); return { content: "ok", finishReason: "stop" }; },
      async *streamChat({ messages }) {
        seen.push(messages);
        yield { delta: "收到" };
        yield { finishReason: "stop" };
      },
    };
    runtime = await startLocalRuntime({
      aiProvider: recording,
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    assert.equal((await fetch(`${runtime.url}/api/memory`)).status, 401);

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: "synthetic-test-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    const empty = await (await fetch(`${runtime.url}/api/memory`, { headers: { cookie } })).json();
    assert.equal(empty.soul, "");
    assert.equal(empty.memory, "");
    assert.equal(empty.updatedAt, null);

    const saved = await fetch(`${runtime.url}/api/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ soul: "你是内容策划", memory: "主推折叠彩虹琴" }),
    });
    assert.equal(saved.status, 200);
    const stored = await saved.json();
    assert.equal(stored.soul, "你是内容策划");
    assert.equal(stored.projectId, empty.projectId);
    assert.equal(
      (await (await fetch(`${runtime.url}/api/memory`, { headers: { cookie } })).json()).memory,
      "主推折叠彩虹琴",
    );

    // Memory belongs to a project: the company root is unaffected by the role's.
    const { project: role } = await (await fetch(`${runtime.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "产品经理", type: "child", parentId: empty.projectId }),
    })).json();
    await fetch(`${runtime.url}/api/memory`, {
      method: "POST", headers, body: JSON.stringify({ projectId: role.id, soul: "你是产品经理" }),
    });
    const roleMemory = await (await fetch(`${runtime.url}/api/memory?projectId=${role.id}`,
      { headers: { cookie } })).json();
    assert.equal(roleMemory.soul, "你是产品经理");
    assert.equal(roleMemory.memory, "");
    assert.equal((await (await fetch(`${runtime.url}/api/memory`, { headers: { cookie } })).json()).soul, "你是内容策划");

    // Unknown projects and oversized documents are refused.
    assert.equal((await fetch(`${runtime.url}/api/memory?projectId=missing`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/memory`, {
      method: "POST", headers, body: JSON.stringify({ projectId: "missing", soul: "x" }),
    })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/memory`, {
      method: "POST", headers, body: JSON.stringify({ soul: "x".repeat(16_001) }),
    })).status, 400);
    // A document at the allowed size is accepted (the shared 16 KiB body limit
    // would have refused it, so this endpoint raises it).
    const large = await fetch(`${runtime.url}/api/memory`, {
      method: "POST", headers, body: JSON.stringify({ soul: "中".repeat(16_000) }),
    });
    assert.equal(large.status, 200);
    assert.equal((await large.json()).soul.length, 16_000);
    // Saving the oversized document must not have replaced the good one.
    await fetch(`${runtime.url}/api/memory`, {
      method: "POST", headers, body: JSON.stringify({ soul: "你是内容策划", memory: "主推折叠彩虹琴" }),
    });

    // The saved memory is replayed as a system message ahead of the history.
    const { conversation } = await (await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers, body: "{}",
    })).json();
    const replied = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST", headers, body: JSON.stringify({ conversationId: conversation.id, content: "今天做什么" }),
    });
    assert.equal(replied.status, 200);
    await replied.text();
    assert.equal(seen[0][0].role, "system");
    assert.match(seen[0][0].content, /\[Agent 记忆 · 系统自动注入\]/u);
    assert.match(seen[0][0].content, /你是内容策划/u);
    assert.deepEqual(seen[0].slice(1), [{ role: "user", content: "今天做什么" }]);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("knowledge cards and gaps are managed per project and injected when relevant", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-knowledge-"));
  const seen = [];
  let runtime;
  try {
    const recording = {
      id: "recording",
      label: "Recording",
      async listModels() { return [{ id: "recording-1", name: "Recording" }]; },
      async chat({ messages }) { seen.push(messages); return { content: "ok", finishReason: "stop" }; },
      async *streamChat({ messages }) {
        seen.push(messages);
        yield { delta: "收到" };
        yield { finishReason: "stop" };
      },
    };
    runtime = await startLocalRuntime({
      aiProvider: recording,
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    assert.equal((await fetch(`${runtime.url}/api/knowledge`)).status, 401);

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: "synthetic-test-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const act = async (payload) => {
      const response = await fetch(`${runtime.url}/api/knowledge`, {
        method: "POST", headers, body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };

    const empty = await (await fetch(`${runtime.url}/api/knowledge`, { headers: { cookie } })).json();
    assert.deepEqual(empty.cards, []);
    assert.equal(empty.stats.cards, 0);

    const created = await act({ action: "card", kind: "fact", title: "主推产品", body: "主推产品是折叠彩虹琴。" });
    assert.equal(created.status, 200);
    assert.equal(created.body.cards.length, 1);
    assert.equal(created.body.cards[0].status, "pending");
    assert.equal(created.body.stats.pending, 1);
    const cardId = created.body.cards[0].id;

    const confirmed = await act({ action: "cardStatus", id: cardId, status: "confirmed" });
    assert.equal(confirmed.body.stats.confirmed, 1);

    const gap = await act({ action: "gapAdd", question: "优惠券和会员价能否叠加？" });
    assert.equal(gap.body.stats.gapsOpen, 1);
    const gapId = gap.body.gaps[0].id;
    assert.equal((await act({ action: "gapClose", id: gapId, note: "已写进政策" })).body.stats.gapsClosed, 1);
    assert.equal((await act({ action: "gapReopen", id: gapId })).body.stats.gapsOpen, 1);
    // The note field is optional, so an empty input box must be accepted.
    const noNote = await act({ action: "gapAdd", question: "没有备注的缺口", note: "" });
    assert.equal(noNote.status, 200);
    assert.equal(noNote.body.gaps.find((item) => item.question === "没有备注的缺口").note, "");

    // Refusals: unknown action, invalid payload, unknown id, unknown project.
    assert.deepEqual(await act({ action: "whatever" }), { status: 400, body: { error: "未知的 action" } });
    assert.equal((await act({ action: "card", kind: "rumour", title: "x", body: "y" })).status, 400);
    assert.equal((await act({ action: "cardStatus", id: "missing", status: "confirmed" })).status, 404);
    assert.equal((await act({ action: "card", projectId: "missing", kind: "fact", title: "x", body: "y" })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/knowledge?projectId=missing`, { headers: { cookie } })).status, 404);

    const { conversation } = await (await fetch(`${runtime.url}/api/conversations`, {
      method: "POST", headers, body: "{}",
    })).json();
    const ask = async (content) => {
      const response = await fetch(`${runtime.url}/api/ai/chat/stream`, {
        method: "POST", headers, body: JSON.stringify({ conversationId: conversation.id, content }),
      });
      assert.equal(response.status, 200);
      await response.text();
    };

    // A question that matches the card pulls it into the turn...
    await ask("我们主推产品是什么");
    assert.equal(seen[0][0].role, "system");
    assert.match(seen[0][0].content, /## 与本轮相关的知识卡片/u);
    assert.match(seen[0][0].content, /折叠彩虹琴/u);

    // ...and an unrelated question injects nothing at all.
    await ask("今天天气如何");
    assert.deepEqual(seen[1], [
      { role: "user", content: "我们主推产品是什么" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "今天天气如何" },
    ]);
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
        const match = output.match(/All-Round-AI runtime \((local|server)\): (http:\/\/[^\s]+)\/login/);
        if (match) {
          clearTimeout(timer);
          assert.equal(match[1], "local");
          resolve(match[2]);
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
