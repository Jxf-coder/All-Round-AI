import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

test("the knowledge endpoint saves intake answers and regenerates standard cards", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-intake-api-"));
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
      body: JSON.stringify({ user: "intake@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const endpoint = `${runtime.url}/api/knowledge`;

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "intake", fields: { product: "折叠彩虹琴" } }),
    })).status, 401);

    const initial = await (await fetch(endpoint, { headers: { cookie } })).json();
    assert.equal(initial.intake, null);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "intake", projectId: "missing-project", fields: {} }),
    })).status, 404);

    const saved = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "intake",
        fields: {
          product: "折叠彩虹琴",
          customer: "中高端琴行",
          forbidden: "合同、成本价",
          questions: "1. 主推产品是什么？\n2. 交期多久？",
          bossConfirmed: false,
        },
      }),
    });
    assert.equal(saved.status, 200);
    const state = await saved.json();
    assert.equal(state.intake.fields.product, "折叠彩虹琴");
    assert.equal(state.intake.by, "intake@example.test");
    assert.equal(state.cards.length, 4);
    assert.ok(state.cards.every((card) => card.status === "pending"));
    assert.deepEqual(state.regression.questions.map((question) => question.q), [
      "主推产品是什么？",
      "交期多久？",
    ]);
    assert.ok(state.regression.questions.every((question) => question.from === "intake"));

    const confirmed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "intake",
        fields: { product: "折叠彩虹琴 Pro", bossConfirmed: true },
      }),
    });
    const next = await confirmed.json();
    assert.equal(next.cards.length, 4);
    assert.ok(next.cards.every((card) => card.status === "confirmed"));
    assert.equal(next.intake.fields.product, "折叠彩虹琴 Pro");
    // Emptying the question box removes the intake questions but keeps the cards.
    assert.equal(next.regression.questions.length, 0);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "intake", fields: [] }),
    })).status, 400);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
