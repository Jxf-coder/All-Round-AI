import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

function parseEvents(text) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

test("a reply records the knowledge cards that fed it", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-citations-"));
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
      body: JSON.stringify({ user: "citations@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    const cardResponse = await fetch(`${runtime.url}/api/knowledge`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "card",
        kind: "fact",
        title: "主推产品",
        body: "主推产品是折叠彩虹琴。",
      }),
    });
    const card = (await cardResponse.json()).cards[0];
    await fetch(`${runtime.url}/api/knowledge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "cardStatus", id: card.id, status: "confirmed" }),
    });

    const created = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const conversationId = (await created.json()).conversation.id;
    const stream = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId, content: "主推产品是什么？" }),
    });
    assert.equal(stream.status, 200);
    const events = parseEvents(await stream.text());
    const meta = events.find((event) => event.meta)?.meta;
    assert.deepEqual(meta.citations, [{ id: card.id, title: "主推产品", kind: "fact" }]);
    assert.equal(events.at(-1).done, true);

    const detail = await (await fetch(`${runtime.url}/api/conversations/${conversationId}`,
      { headers: { cookie } })).json();
    const answer = detail.conversation.messages.at(-1);
    assert.equal(answer.role, "assistant");
    assert.deepEqual(answer.citations, meta.citations);

    // A question that matches nothing keeps the old message shape.
    const other = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const otherId = (await other.json()).conversation.id;
    const unmatched = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: otherId, content: "今天天气怎么样" }),
    });
    const unmatchedEvents = parseEvents(await unmatched.text());
    assert.deepEqual(unmatchedEvents.find((event) => event.meta)?.meta.citations, []);
    const otherDetail = await (await fetch(`${runtime.url}/api/conversations/${otherId}`,
      { headers: { cookie } })).json();
    assert.equal("citations" in otherDetail.conversation.messages.at(-1), false);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
