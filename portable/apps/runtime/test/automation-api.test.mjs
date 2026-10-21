import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

async function boot() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-automation-api-"));
  const runtime = await startLocalRuntime({
    authProvider: async ({ user }) => ({
      ok: true,
      user: {
        id: user,
        name: user,
        role: user.startsWith("member") ? "member" : "admin",
        source: "all-round-ai",
      },
      landing: "/",
    }),
    env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
    home: temporaryRoot,
    port: 0,
  });

  async function login(user) {
    const response = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user, password: "synthetic-test-password" }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }

  const adminCookie = await login("admin@example.test");
  const memberCookie = await login("member@example.test");
  const projects = await (await fetch(`${runtime.url}/api/projects`, {
    headers: { cookie: adminCookie },
  })).json();

  return {
    runtime,
    projectId: projects.defaultProjectId,
    admin: {
      "content-type": "application/json",
      origin: runtime.url,
      cookie: adminCookie,
    },
    member: {
      "content-type": "application/json",
      origin: runtime.url,
      cookie: memberCookie,
    },
    async close() {
      await runtime.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("automation endpoints require a session and list the built-in pipeline", async () => {
  const app = await boot();
  try {
    assert.equal((await fetch(`${app.runtime.url}/api/automation`)).status, 401);

    const listed = await fetch(`${app.runtime.url}/api/automation`, { headers: { cookie: app.member.cookie } });
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.pipelines.length, 1);
    assert.equal(body.pipelines[0].id, "knowledge-brief");
    assert.deepEqual(body.pipelines[0].steps.map((step) => step.runner), ["app", "app", "manual"]);
    assert.deepEqual(body.runs, []);
  } finally {
    await app.close();
  }
});

test("a knowledge run writes both artifacts and waits for the operator", async () => {
  const app = await boot();
  try {
    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ pipelineId: "knowledge-brief", projectId: app.projectId }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.equal(run.steps.snapshot.status, "done");
    assert.equal(run.steps.brief.status, "done");
    assert.equal(run.steps.review.status, "waiting_manual");
    assert.equal(run.steps.brief.artifacts[0].slot, "brief");
    assert.ok(path.isAbsolute(run.steps.brief.artifacts[0].path));

    const brief = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/brief`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(brief.status, 200);
    const briefBody = await brief.json();
    assert.match(briefBody.text, new RegExp(`^# 知识简报 · ${app.projectId}`, "u"));
    assert.match(briefBody.text, /## 概览/u);
    assert.ok(briefBody.bytes > 0);

    const snapshot = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/snapshot`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    const parsed = JSON.parse(snapshot.text);
    assert.equal(parsed.projectId, app.projectId);
    assert.equal(parsed.stats.cards, 0);

    const missingArtifact = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/nope`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(missingArtifact.status, 404);

    const confirmed = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/steps/review/complete`,
      { method: "POST", headers: app.admin, body: "{}" },
    );
    assert.equal(confirmed.status, 200);
    const finished = (await confirmed.json()).run;
    assert.equal(finished.status, "done");
    assert.equal(finished.steps.review.completedBy, "admin@example.test");

    const again = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/steps/review/complete`,
      { method: "POST", headers: app.admin, body: "{}" },
    );
    assert.equal(again.status, 409);

    const cancelled = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/cancel`,
      { method: "POST", headers: app.admin, body: "{}" },
    );
    assert.equal(cancelled.status, 409);

    const trail = await (await fetch(`${app.runtime.url}/api/audit?limit=10`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const actions = trail.entries.map((entry) => [entry.action, entry.outcome]);
    assert.deepEqual(actions.slice(0, 5), [
      ["automation.cancel", "denied"],
      ["automation.complete", "denied"],
      ["automation.complete", "ok"],
      ["automation.run", "ok"],
      ["auth.login", "ok"],
    ]);
    assert.equal(trail.entries[2].target, run.id);
  } finally {
    await app.close();
  }
});

test("invalid automation requests are refused and audited", async () => {
  const app = await boot();
  try {
    const unknown = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ pipelineId: "missing", projectId: app.projectId }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /没有这条产线/u);

    const noProject = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ pipelineId: "knowledge-brief", projectId: "project-does-not-exist" }),
    });
    assert.equal(noProject.status, 404);
    assert.match((await noProject.json()).error, /项目不存在/u);

    const missingRun = await fetch(`${app.runtime.url}/api/automation/runs/run_missing`, {
      headers: { cookie: app.admin.cookie },
    });
    assert.equal(missingRun.status, 404);

    const trail = await (await fetch(`${app.runtime.url}/api/audit?limit=10`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const denials = trail.entries.filter((entry) => entry.action === "automation.run");
    assert.deepEqual(denials.map((entry) => entry.outcome), ["denied", "denied"]);
    assert.match(denials[0].detail, /项目不存在/u);
    assert.match(denials[1].detail, /没有这条产线/u);
  } finally {
    await app.close();
  }
});
