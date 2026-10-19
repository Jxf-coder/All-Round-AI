import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

function createFakeProvider() {
  return {
    id: "fake",
    label: "Fake",
    async listModels() {
      return [{ id: "fake-1", name: "Fake One" }];
    },
    async chat({ messages }) {
      const prompt = messages.at(-1)?.content ?? "";
      if (prompt.includes("记忆提炼器")) {
        if (prompt.includes("不需要提炼")) {
          return { id: "r1", content: "这段对话没有可提炼的内容", model: "fake-1", finishReason: "stop" };
        }
        return {
          id: "r2",
          content: '[{"kind":"决策","text":"短视频统一 9:16"},{"kind":"事实","text":"主推产品是折叠彩虹琴"}]',
          model: "fake-1",
          finishReason: "stop",
        };
      }
      return {
        id: "r3",
        content: "```markdown\n# 内容策划\n\n## 身份\n为电商团队服务，主战场是短视频。\n\n## 职责\n- 选题\n- 脚本\n\n## 风格\n- 先结论\n\n## 禁忌\n- 不编数据\n```",
        model: "fake-1",
        finishReason: "stop",
      };
    },
    async *streamChat() {
      yield { delta: "x" };
      yield { finishReason: "stop" };
    },
  };
}

test("distillation queues candidates and a soul draft stays unsaved", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-memory-generate-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      aiProvider: createFakeProvider(),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "distill@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };

    assert.equal((await fetch(`${runtime.url}/api/memory/distill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "missing" }),
    })).status, 401);

    const created = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const conversationId = (await created.json()).conversation.id;
    const reply = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        conversationId,
        content: "以后短视频统一用 9:16，主推折叠彩虹琴。",
      }),
    });
    assert.equal(reply.status, 200);
    await reply.text();

    const distilled = await fetch(`${runtime.url}/api/memory/distill`, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId }),
    });
    assert.equal(distilled.status, 200);
    const queued = await distilled.json();
    assert.equal(queued.queued, true);
    assert.equal(queued.added, 2);
    assert.deepEqual(queued.pending.map((item) => item.kind), ["决策", "事实"]);

    const drafted = await fetch(`${runtime.url}/api/memory/soul-draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(drafted.status, 200);
    const draft = await drafted.json();
    assert.match(draft.draft, /^# 内容策划/u);
    assert.equal(draft.existing, "");

    // A draft is never persisted: memory still has an empty soul and only the
    // queued candidates from distillation.
    const memory = await (await fetch(`${runtime.url}/api/memory`, { headers: { cookie } })).json();
    assert.equal(memory.soul, "");
    assert.equal(memory.pending.length, 2);

    // An unusable provider reply is reported instead of inventing entries.
    const empty = await fetch(`${runtime.url}/api/conversations`, { method: "POST", headers, body: "{}" });
    const emptyId = (await empty.json()).conversation.id;
    const emptyReply = await fetch(`${runtime.url}/api/ai/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: emptyId, content: "不需要提炼" }),
    });
    await emptyReply.text();
    assert.equal((await fetch(`${runtime.url}/api/memory/distill`, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversationId: emptyId }),
    })).status, 422);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
