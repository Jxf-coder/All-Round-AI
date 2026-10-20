import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

test("the knowledge endpoint configures sources and runs a local scout", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-scout-api-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: {
          id: user,
          name: user,
          role: user.includes("member") ? "member" : "admin",
          source: "all-round-ai",
        },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    const login = async (user) => {
      const response = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: runtime.url },
        body: JSON.stringify({ user, password: "synthetic-test-password" }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const adminCookie = await login("admin@example.test");
    const adminHeaders = {
      "content-type": "application/json",
      origin: runtime.url,
      cookie: adminCookie,
    };

    const scanRoot = path.join(temporaryRoot, "资料");
    await mkdir(scanRoot);
    await writeFile(path.join(scanRoot, "产品参数.md"), "参数");
    await writeFile(path.join(scanRoot, "合同说明.md"), "合同");

    const endpoint = `${runtime.url}/api/knowledge`;
    const initial = await (await fetch(endpoint, { headers: { cookie: adminCookie } })).json();
    assert.equal(initial.sources.canEdit, true);
    assert.equal(initial.sources.roots.length, 1);
    assert.deepEqual(initial.scouts, []);

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sourcesSave", roots: [scanRoot] }),
    })).status, 401);

    const saved = await fetch(endpoint, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ action: "sourcesSave", roots: [scanRoot] }),
    });
    assert.equal(saved.status, 200);
    const savedState = await saved.json();
    assert.deepEqual(savedState.sources.roots, [path.normalize(scanRoot)]);
    assert.equal(savedState.sources.updatedBy, "admin@example.test");

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ action: "sourcesSave", roots: ["relative"] }),
    })).status, 400);

    const scout = await fetch(endpoint, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        action: "scoutRun",
        root: scanRoot,
        goal: "沉淀产品参数",
        label: "产品资料",
      }),
    });
    assert.equal(scout.status, 200);
    const { run, report } = await scout.json();
    assert.equal(run.counts.files, 2);
    assert.equal(run.counts.keep, 1);
    assert.equal(run.counts.rule, 1);
    assert.match(report, /禁入词「合同」/u);
    assert.match(report, /产品参数\.md/u);

    const listed = await (await fetch(endpoint, { headers: { cookie: adminCookie } })).json();
    assert.equal(listed.scouts.length, 1);
    assert.equal(listed.scouts[0].id, run.id);
    assert.equal("report" in listed.scouts[0], false);

    const detail = await (await fetch(
      `${endpoint}?scout=${encodeURIComponent(run.id)}`,
      { headers: { cookie: adminCookie } },
    )).json();
    assert.equal(detail.run.report, report);
    assert.equal((await fetch(`${endpoint}?scout=missing`, {
      headers: { cookie: adminCookie },
    })).status, 404);

    const outside = path.join(temporaryRoot, "outside");
    await mkdir(outside);
    const refused = await fetch(endpoint, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ action: "scoutRun", root: outside }),
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /白名单/u);

    const memberCookie = await login("member@example.test");
    const memberState = await (await fetch(endpoint, { headers: { cookie: memberCookie } })).json();
    assert.equal(memberState.sources.canEdit, false);
    const memberSave = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: runtime.url,
        cookie: memberCookie,
      },
      body: JSON.stringify({ action: "sourcesSave", roots: [scanRoot] }),
    });
    assert.equal(memberSave.status, 403);
    assert.match((await memberSave.json()).error, /管理员/u);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
