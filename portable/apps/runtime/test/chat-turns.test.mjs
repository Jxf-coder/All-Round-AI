import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

// A provider whose reply arrives one character at a time. That makes "the reply
// is still going after the browser left" observable instead of a race.
function createSlowProvider(reply, delayMs) {
  return {
    id: "slow-stream",
    label: "Slow Stream",
    async listModels() { return [{ id: "slow-1", name: "Slow" }]; },
    async chat({ model = "slow-1" }) {
      return { id: "slow-1", content: reply, model, finishReason: "stop" };
    },
    async *streamChat({ signal }) {
      for (const character of reply) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) {
          const error = new Error("AI request was cancelled");
          error.name = "AbortError";
          throw error;
        }
        yield { delta: character };
      }
      yield { finishReason: "stop" };
    },
  };
}

function parseSse(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

async function login(base) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ user: "turns@example.test", password: "synthetic-test-password" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

async function createConversation(base, cookie) {
  const response = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: "{}",
  });
  assert.equal(response.status, 201);
  return (await response.json()).conversation.id;
}

// The runtime is the source of truth for "a reply is in flight", so tests ask it
// rather than assuming how far the stream has got.
async function waitForRunning(base, cookie, conversationId, minimumLength = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(
      `${base}/api/ai/chat/live?conversationId=${encodeURIComponent(conversationId)}`,
      { headers: { cookie } },
    );
    if (response.ok) {
      const { turn } = await response.json();
      if (turn && turn.status === "running" && turn.text.length >= minimumLength) return turn;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the turn never became observable as running");
}

async function startRuntime(temporaryRoot, reply, delayMs = 25) {
  return startLocalRuntime({
    aiProvider: createSlowProvider(reply, delayMs),
    authProvider: async ({ user }) => ({
      ok: true,
      user: { id: user, name: user, role: "admin", source: "all-round-ai" },
      landing: "/",
    }),
    env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
    home: temporaryRoot,
    port: 0,
  });
}

const REPLY = "这是一段用于验证断线重连与取消行为的较长回答内容。";

test("a reply keeps running after the client disconnects and can be replayed", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-turns-live-"));
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, REPLY);
    const cookie = await login(runtime.url);
    const conversationId = await createConversation(runtime.url, cookie);

    // Start a reply, then walk away exactly like a page refresh does.
    const controller = new AbortController();
    const started = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "开始一段长回答", clientTurnId: "refresh-1" }),
      signal: controller.signal,
    });
    assert.equal(started.status, 200);
    const reader = started.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    // Disconnecting must not have stopped the turn.
    const snapshot = await waitForRunning(runtime.url, cookie, conversationId);
    assert.equal(snapshot.clientTurnId, "refresh-1");
    assert.equal(snapshot.text.length > 0, true);

    // Reattach from the snapshot's sequence number and follow to the end.
    const tail = await fetch(
      `${runtime.url}/api/ai/chat/live?conversationId=${conversationId}&stream=1&after=${snapshot.seq}`,
      { headers: { cookie } },
    );
    assert.equal(tail.status, 200);
    assert.match(tail.headers.get("content-type"), /text\/event-stream/);
    const events = parseSse(await tail.text());
    assert.equal(events.at(-1).done, true);
    assert.equal(events.at(-1).status, "done");
    const replayed = snapshot.text + events.filter((event) => event.delta).map((event) => event.delta).join("");
    assert.equal(replayed, REPLY);

    // The complete answer, not a truncated one, is what got stored.
    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(detail.conversation.messages.length, 2);
    assert.equal(detail.conversation.messages[1].content, REPLY);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("cancelling stops the turn and keeps the partial answer", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-turns-cancel-"));
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, REPLY);
    const cookie = await login(runtime.url);
    const conversationId = await createConversation(runtime.url, cookie);

    const started = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "长回答", clientTurnId: "cancel-1" }),
    });
    assert.equal(started.status, 200);
    const reader = started.body.getReader();
    const decoder = new TextDecoder();
    await waitForRunning(runtime.url, cookie, conversationId, 4);

    const cancelled = await fetch(`${runtime.url}/api/ai/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { ok: true, cancelled: true });

    // The attached stream observes the terminal state instead of hanging.
    let body = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    assert.match(body, /"status":"cancelled"/);

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(detail.conversation.messages.length, 2);
    const partial = detail.conversation.messages[1].content;
    assert.equal(partial.length > 0, true);
    assert.equal(REPLY.startsWith(partial), true);
    assert.equal(partial.length < REPLY.length, true);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("resending the same clientTurnId attaches to the turn it already started", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-turns-resend-"));
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, REPLY, 30);
    const cookie = await login(runtime.url);
    const conversationId = await createConversation(runtime.url, cookie);

    const controller = new AbortController();
    const first = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "同一次发送", clientTurnId: "resend-1" }),
      signal: controller.signal,
    });
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const snapshot = await waitForRunning(runtime.url, cookie, conversationId);

    // A resend must be answered from the same turn: no second question, no
    // second reply.
    const resent = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url, cookie },
      body: JSON.stringify({ conversationId, content: "同一次发送", clientTurnId: "resend-1" }),
    });
    assert.equal(resent.status, 200);
    const events = parseSse(await resent.text());
    const meta = events.find((event) => event.meta);
    assert.equal(meta.meta.turnId, snapshot.id);
    assert.equal(events.at(-1).done, true);

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(detail.conversation.messages.length, 2, "the question must not be duplicated");
    assert.equal(detail.conversation.messages[0].content, "同一次发送");
    assert.equal(detail.conversation.messages[1].content, REPLY);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the live and cancel endpoints require a session and scope to the conversation", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-turns-guard-"));
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, REPLY);
    assert.equal((await fetch(`${runtime.url}/api/ai/chat/live?conversationId=x`)).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/ai/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "x" }),
    })).status, 401);

    const cookie = await login(runtime.url);
    assert.equal((await fetch(`${runtime.url}/api/ai/chat/live?conversationId=missing`,
      { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${runtime.url}/api/ai/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ conversationId: "missing" }),
    })).status, 404);

    // A conversation with nothing in flight reports an empty snapshot, and its
    // tail ends immediately rather than staying open.
    const conversationId = await createConversation(runtime.url, cookie);
    const snapshot = await (await fetch(`${runtime.url}/api/ai/chat/live?conversationId=${conversationId}`,
      { headers: { cookie } })).json();
    assert.equal(snapshot.turn, null);
    const tail = await fetch(`${runtime.url}/api/ai/chat/live?conversationId=${conversationId}&stream=1`,
      { headers: { cookie } });
    assert.equal(tail.status, 200);
    assert.deepEqual(parseSse(await tail.text()), [{ done: true, status: "idle" }]);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
