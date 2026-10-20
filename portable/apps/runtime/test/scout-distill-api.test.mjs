import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

const SOURCE_TEXT = "主推产品：折叠彩虹琴\n交期：7 天\n适合中高端琴行。";

function createFakeProvider() {
  return {
    id: "fake",
    label: "Fake（测试）",
    async listModels() {
      return [{ id: "fake-model", name: "Fake Model" }];
    },
    async chat() {
      return {
        id: "fake-reply",
        model: "fake-model",
        finishReason: "stop",
        content: JSON.stringify({
          facts: [
            { title: "主推产品", body: "折叠彩虹琴", quote: "主推产品：折叠彩虹琴" },
            { title: "交期", body: "7 天", quote: "交期：7 天" },
            { title: "适用客户", body: "中高端琴行", quote: "适合中高端琴行" },
            { title: "价格", body: "9999 元", quote: "价格：9999 元" },
          ],
          faqs: [
            { question: "主推产品是什么？", answer: "折叠彩虹琴", quote: "主推产品：折叠彩虹琴" },
          ],
        }),
      };
    },
    async *streamChat() {
      yield { finishReason: "stop" };
    },
  };
}

test("a scout run can distil kept text into pending cards", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-distill-api-"));
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
    const endpoint = `${runtime.url}/api/knowledge`;

    const scanRoot = path.join(temporaryRoot, "资料");
    await mkdir(scanRoot);
    await writeFile(path.join(scanRoot, "产品参数.md"), SOURCE_TEXT);
    await writeFile(path.join(scanRoot, "密钥.md"), `token sk-${"x".repeat(24)}`);

    const configured = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "sourcesSave", roots: [scanRoot] }),
    });
    assert.equal(configured.status, 200);

    const scanned = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "scoutRun",
        root: scanRoot,
        goal: "沉淀产品参数",
        label: "产品资料",
      }),
    });
    assert.equal(scanned.status, 200);
    const { run } = await scanned.json();
    assert.equal(run.counts.keep, 2);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "scoutDistill", runId: "missing" }),
    })).status, 404);

    const distilled = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "scoutDistill", runId: run.id }),
    });
    assert.equal(distilled.status, 200);
    const result = await distilled.json();
    // Two candidates, one contains a credential and never reaches the model.
    assert.equal(result.summary.files, 2);
    assert.equal(result.summary.read, 1);
    assert.equal(result.summary.cards, 4);
    assert.equal(result.summary.dropped, 1);
    assert.equal(result.summary.skipped.length, 1);
    assert.match(result.summary.skipped[0].reason, /密钥/u);
    assert.deepEqual(result.summary.errors, []);
    assert.match(result.run.report, /## 提炼结果/u);

    const state = await (await fetch(endpoint, { headers: { cookie } })).json();
    assert.equal(state.stats.pending, 4);
    assert.equal(state.stats.confirmed, 0);
    assert.deepEqual(
      state.cards.map((card) => card.title).sort(),
      ["交期", "主推产品", "主推产品是什么？", "适用客户"].sort(),
    );
    assert.ok(state.cards.every((card) => card.status === "pending"));

    const again = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "scoutDistill", runId: run.id }),
    });
    const repeated = await again.json();
    assert.equal(repeated.summary.cards, 0);
    assert.equal(repeated.summary.merged, 4);

    const detail = await (await fetch(
      `${endpoint}?scout=${encodeURIComponent(run.id)}`,
      { headers: { cookie } },
    )).json();
    assert.equal(detail.run.distill.cards, 0);
    assert.equal(detail.run.distill.merged, 4);

    const emptyRoot = path.join(scanRoot, "空子目录");
    await mkdir(emptyRoot);
    const emptyScan = await (await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "scoutRun", root: emptyRoot, label: "空目录" }),
    })).json();
    assert.equal(emptyScan.run.counts.keep, 0);
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "scoutDistill", runId: emptyScan.run.id }),
    })).status, 400);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
