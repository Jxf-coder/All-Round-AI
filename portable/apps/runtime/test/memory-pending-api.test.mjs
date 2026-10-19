import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

test("the pending-memory endpoint adds, confirms and discards entries", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-memory-api-"));
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
      body: JSON.stringify({ user: "memory@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const endpoint = `${runtime.url}/api/memory/pending`;

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", items: [{ text: "未登录也可以写" }] }),
    })).status, 401);

    const added = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "add",
        items: [
          { text: "主推折叠琴", kind: "事实" },
          { text: "短视频统一 9:16", kind: "决策" },
        ],
      }),
    });
    assert.equal(added.status, 200);
    const queued = await added.json();
    assert.equal(queued.pending.length, 2);

    const listed = await (await fetch(`${runtime.url}/api/memory`, { headers: { cookie } })).json();
    assert.equal(listed.pending.length, 2);

    const confirmed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "confirm",
        id: queued.pending[0].id,
        kind: "事实",
        text: "主推产品是折叠彩虹琴",
      }),
    });
    assert.equal(confirmed.status, 200);
    const afterConfirm = await confirmed.json();
    assert.equal(afterConfirm.pending.length, 1);
    assert.match(afterConfirm.memory, /## 事实\n\n- 主推产品是折叠彩虹琴/u);

    const discarded = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "discard", id: afterConfirm.pending[0].id }),
    });
    assert.equal(discarded.status, 200);
    assert.equal((await discarded.json()).pending.length, 0);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "confirm", id: "missing" }),
    })).status, 404);
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "promote", id: "missing" }),
    })).status, 400);
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "add", items: [] }),
    })).status, 400);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
