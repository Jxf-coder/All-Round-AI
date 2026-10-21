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

async function boot() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-skills-api-"));
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
    // Keep the counts deterministic: the host may or may not have FFmpeg.
    mediaProbe: async () => ({
      ffmpeg: { available: false, path: null, version: null, reason: "测试环境未安装" },
      ffprobe: { available: false, path: null, version: null, reason: "测试环境未安装" },
      checkedAt: new Date(0).toISOString(),
    }),
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

  const admin = {
    "content-type": "application/json",
    origin: runtime.url,
    cookie: await login("admin@example.test"),
  };
  const member = {
    "content-type": "application/json",
    origin: runtime.url,
    cookie: await login("member@example.test"),
  };

  async function toggle(id, enabled) {
    return fetch(`${runtime.url}/api/skills/toggle`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ id, enabled }),
    });
  }

  async function pairDevice(capabilities) {
    const created = await fetch(`${runtime.url}/api/devices/tickets`, {
      method: "POST",
      headers: admin,
      body: "{}",
    });
    assert.equal(created.status, 201);
    const { ticket } = await created.json();
    const paired = await fetch(`${runtime.url}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({
        ticket,
        name: "能力验收机",
        platform: process.platform,
        version: "1.0.0",
        capabilities,
      }),
    });
    assert.equal(paired.status, 201);
    return paired.json();
  }

  return {
    runtime,
    admin,
    member,
    toggle,
    pairDevice,
    async close() {
      await runtime.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("the catalog is readable by any session and reports missing desk capability", async () => {
  const app = await boot();
  try {
    assert.equal((await fetch(`${app.runtime.url}/api/skills`)).status, 401);

    const response = await fetch(`${app.runtime.url}/api/skills`, {
      headers: { cookie: app.member.cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.skills.length, 15);
    assert.equal(body.stats.enabled, 11);
    assert.equal(body.stats.available, 7);
    assert.equal(body.stats.comingSoon, 4);

    const files = body.skills.find((skill) => skill.id === "local-files");
    assert.equal(files.available, false);
    assert.match(files.reason, /files/);
    const later = body.skills.find((skill) => skill.id === "doc-rewrite");
    assert.equal(later.comingSoon, true);
    assert.equal(later.enabled, false);
    const audio = body.skills.find((skill) => skill.id === "audio-extract");
    assert.equal(audio.enabled, true);
    assert.equal(audio.available, false);
    assert.match(audio.reason, /FFmpeg/u);

    const { device } = await app.pairDevice(["files", "screen"]);
    assert.ok(device.id);
    const refreshed = await (await fetch(`${app.runtime.url}/api/skills`, {
      headers: { cookie: app.member.cookie },
    })).json();
    const readyFiles = refreshed.skills.find((skill) => skill.id === "local-files");
    assert.equal(readyFiles.available, true);
    assert.equal(readyFiles.devices, 1);
    assert.equal(refreshed.stats.available, 9);
  } finally {
    await app.close();
  }
});

test("only an administrator can flip a switch and every attempt is audited", async () => {
  const app = await boot();
  try {
    const denied = await fetch(`${app.runtime.url}/api/skills/toggle`, {
      method: "POST",
      headers: app.member,
      body: JSON.stringify({ id: "knowledge-qa", enabled: false }),
    });
    assert.equal(denied.status, 403);

    const unknown = await app.toggle("does-not-exist", false);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "技能不存在");

    const later = await app.toggle("doc-rewrite", true);
    assert.equal(later.status, 400);

    const off = await app.toggle("local-screen", false);
    assert.equal(off.status, 200);
    const listed = await off.json();
    assert.equal(listed.skills.find((skill) => skill.id === "local-screen").enabled, false);
    assert.equal(listed.stats.enabled, 10);

    const audit = await (await fetch(`${app.runtime.url}/api/audit?limit=100`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const rows = audit.entries.filter((entry) => entry.action === "skill.toggle");
    assert.ok(rows.length >= 4);
    assert.ok(rows.some((entry) => entry.outcome === "denied" && entry.detail === "没有管理员权限"));
    assert.ok(rows.some((entry) => entry.outcome === "denied" && entry.detail === "技能不存在"));
    assert.ok(rows.some((entry) => entry.outcome === "ok" && entry.detail === "停用 屏幕截图"));
  } finally {
    await app.close();
  }
});

test("a disabled desk skill refuses the matching command before it reaches the queue", async () => {
  const app = await boot();
  try {
    const { device } = await app.pairDevice(["screen"]);
    assert.equal((await app.toggle("local-screen", false)).status, 200);

    const response = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "screen.capture" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "技能已停用：屏幕截图");

    // Turning it back on must restore the switch, so a later attempt is no
    // longer refused by the skill gate.
    assert.equal((await app.toggle("local-screen", true)).status, 200);
  } finally {
    await app.close();
  }
});

test("disabled automation and handover skills refuse their entry points", async () => {
  const app = await boot();
  try {
    const projects = await (await fetch(`${app.runtime.url}/api/projects`, {
      headers: { cookie: app.admin.cookie },
    })).json();

    assert.equal((await app.toggle("script-draft", false)).status, 200);
    const listed = await (await fetch(`${app.runtime.url}/api/automation`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const scripted = listed.pipelines.find((pipeline) => pipeline.id === "script-draft");
    assert.equal(scripted.enabled, false);
    assert.equal(scripted.skillId, "script-draft");

    const run = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "script-draft",
        projectId: projects.defaultProjectId,
        params: { draft: { topic: "售后响应" } },
      }),
    });
    assert.equal(run.status, 403);
    assert.equal((await run.json()).error, "技能已停用：口播脚本");

    assert.equal((await app.toggle("handover", false)).status, 200);
    const handover = await fetch(`${app.runtime.url}/api/handover`, {
      method: "POST",
      headers: app.admin,
      body: "{}",
    });
    assert.equal(handover.status, 403);
    assert.equal((await handover.json()).error, "技能已停用：交接包");
  } finally {
    await app.close();
  }
});

test("disabling knowledge-qa stops confirmed cards from entering a reply", async () => {
  const app = await boot();
  try {
    const created = await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "card", kind: "fact", title: "主推产品", body: "主推产品是折叠彩虹琴。" }),
    });
    const card = (await created.json()).cards[0];
    await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "cardStatus", id: card.id, status: "confirmed" }),
    });

    async function ask(content) {
      const conversation = await fetch(`${app.runtime.url}/api/conversations`, {
        method: "POST",
        headers: app.admin,
        body: "{}",
      });
      const conversationId = (await conversation.json()).conversation.id;
      const stream = await fetch(`${app.runtime.url}/api/ai/chat/stream`, {
        method: "POST",
        headers: app.admin,
        body: JSON.stringify({ conversationId, content }),
      });
      assert.equal(stream.status, 200);
      return parseEvents(await stream.text()).find((event) => event.meta)?.meta;
    }

    const before = await ask("主推产品是什么？");
    assert.deepEqual(before.citations, [{ id: card.id, title: "主推产品", kind: "fact" }]);

    assert.equal((await app.toggle("knowledge-qa", false)).status, 200);
    const after = await ask("主推产品是什么？");
    assert.deepEqual(after.citations, []);
  } finally {
    await app.close();
  }
});
