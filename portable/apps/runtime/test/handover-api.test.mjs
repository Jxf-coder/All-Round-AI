import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

test("the handover endpoint exports, lists and serves a local bundle", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-handover-api-"));
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
      body: JSON.stringify({ user: "handover@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", origin: runtime.url, cookie };
    const endpoint = `${runtime.url}/api/handover`;

    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.deepEqual(
      await (await fetch(`${endpoint}/latest`, { headers: { cookie } })).json(),
      { info: null },
    );

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "missing-project" }),
    })).status, 404);

    const knowledge = await fetch(`${runtime.url}/api/knowledge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "card", kind: "fact", title: "主推产品", body: "折叠彩虹琴" }),
    });
    assert.equal(knowledge.status, 200);

    const exportResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(exportResponse.status, 200);
    const { info } = await exportResponse.json();
    assert.match(info.file, /^handover-[a-z0-9_-]+-\d{14}\.json$/u);
    assert.equal(info.counts.cards, 1);
    assert.equal(info.by, "handover@example.test");

    const latest = await (await fetch(`${endpoint}/latest`, { headers: { cookie } })).json();
    assert.equal(latest.info.file, info.file);

    const download = await fetch(`${endpoint}/${encodeURIComponent(info.file)}`, {
      headers: { cookie },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-disposition"), `attachment; filename="${info.file}"`);
    const bundle = JSON.parse(await download.text());
    assert.equal(bundle.project.id, latest.info.projectId);
    assert.equal(bundle.knowledge.cards[0].title, "主推产品");

    // Only names the exporter would produce are served; encoded traversal is
    // decoded by the router but still refused by the file-name pattern.
    assert.equal((await fetch(`${endpoint}/..%2Fconfig%2Fmemory.json`, {
      headers: { cookie },
    })).status, 404);

    const secretCard = await fetch(`${runtime.url}/api/knowledge`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "card",
        kind: "fact",
        title: "错误示例",
        body: `token sk-${"x".repeat(24)}`,
      }),
    });
    assert.equal(secretCard.status, 200);
    const refused = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /形似密钥/u);
    // The refused export leaves the previous bundle untouched.
    assert.equal(
      (await (await fetch(`${endpoint}/latest`, { headers: { cookie } })).json()).info.file,
      info.file,
    );
    const stored = JSON.parse(
      await readFile(path.join(temporaryRoot, "data", "handover", info.file), "utf8"),
    );
    assert.equal(stored.knowledge.cards.length, 1);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
