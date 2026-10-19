import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

test("the knowledge endpoint manages and runs regression questions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-regression-api-"));
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
      body: JSON.stringify({ user: "regression@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const endpoint = `${runtime.url}/api/knowledge`;

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "regressionAdd", question: "主推产品是什么？" }),
    })).status, 401);

    const initial = await (await fetch(endpoint, { headers: { cookie } })).json();
    assert.deepEqual(initial.regression, { questions: [], runs: [] });

    // Running with no questions is a client error, not an empty run.
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "regressionRun" }),
    })).status, 400);

    const added = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "regressionAdd", question: "主推产品是什么？" }),
    });
    assert.equal(added.status, 200);
    const withQuestion = await added.json();
    assert.equal(withQuestion.regression.questions.length, 1);
    assert.equal(withQuestion.stats.regressionQuestions, 1);

    const card = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "card", kind: "fact", title: "主推产品", body: "主推产品是折叠彩虹琴。" }),
    });
    const cardId = (await card.json()).cards[0].id;
    await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "cardStatus", id: cardId, status: "confirmed" }),
    });

    const run = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "regressionRun", reason: "手动运行" }),
    });
    assert.equal(run.status, 200);
    const afterRun = await run.json();
    assert.equal(afterRun.regression.runs.length, 1);
    assert.equal(afterRun.regression.runs[0].passed, 1);
    assert.deepEqual(afterRun.regression.runs[0].items[0].hits, [cardId]);
    assert.equal(afterRun.stats.regressionPassed, 1);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "regressionRemove", id: "missing" }),
    })).status, 404);

    const removed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "regressionRemove", id: afterRun.regression.questions[0].id }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).regression.questions.length, 0);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
