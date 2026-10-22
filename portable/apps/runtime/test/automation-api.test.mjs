import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

async function boot(options = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-automation-api-"));
  const runtime = await startLocalRuntime({
    ...options,
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
    root: temporaryRoot,
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
    assert.equal(body.pipelines.length, 10);
    assert.deepEqual(body.pipelines.map((pipeline) => pipeline.id),
      ["knowledge-brief", "script-draft", "topic-pack", "script-rewrite", "media-inventory",
        "audio-extract", "video-normalize", "video-reframe", "video-subtitle", "publish-pack"]);
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
      body: JSON.stringify({
        pipelineId: "knowledge-brief",
        projectId: app.projectId,
        params: {
          snapshot: { maxCards: 5, includeGaps: false },
          brief: { title: "验收简报" },
        },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.equal(run.params.snapshot.maxCards, 5);
    assert.equal(run.params.snapshot.includeGaps, false);
    assert.equal(run.params.brief.title, "验收简报");
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
    assert.match(briefBody.text, /^# 知识简报 · 验收简报/u);
    assert.match(briefBody.text, /## 概览/u);
    assert.match(briefBody.text, /本次运行未纳入缺口/u);
    assert.ok(briefBody.bytes > 0);

    const snapshot = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/snapshot`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    const parsed = JSON.parse(snapshot.text);
    assert.equal(parsed.projectId, app.projectId);
    assert.equal(parsed.stats.cards, 0);
    assert.equal(parsed.includeGaps, false);
    assert.deepEqual(parsed.gaps, []);

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

test("the script pipeline drafts with the configured model and waits for review", async () => {
  const calls = [];
  const app = await boot({
    automationChat: async ({ messages }) => {
      calls.push(messages);
      return { content: "镜头 1：先算一笔账。\n镜头 2：售后两小时响应。", model: "test-model" };
    },
  });
  try {
    const endpoint = `${app.runtime.url}/api/automation/runs`;
    const missingTopic = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ pipelineId: "script-draft", projectId: app.projectId, params: { draft: {} } }),
    });
    assert.equal(missingTopic.status, 400);
    assert.match((await missingTopic.json()).error, /主题不能为空/u);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "script-draft",
        projectId: app.projectId,
        params: {
          draft: { topic: "售后响应", audience: "boss", durationSec: 45, tone: "sharp", maxCards: 3 },
        },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.equal(run.steps.draft.status, "done");
    assert.equal(run.steps.draft.artifacts[0].slot, "script");
    assert.deepEqual(run.steps.draft.logs, ["引用已确认知识卡 0 张", "模型：test-model"]);

    assert.equal(calls.length, 1);
    assert.match(calls[0][1].content, /主题：售后响应/u);
    assert.match(calls[0][1].content, /受众：企业老板/u);
    assert.match(calls[0][1].content, /语气：直接犀利/u);

    const artifact = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/script`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(artifact.text, /^# 口播脚本草稿/u);
    assert.match(artifact.text, /镜头 1：先算一笔账。/u);
    assert.match(artifact.text, /主题：售后响应/u);

    const confirmed = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/steps/review/complete`,
      { method: "POST", headers: app.admin, body: "{}" },
    );
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).run.status, "done");

    const listed = await (await fetch(`${app.runtime.url}/api/automation?projectId=${app.projectId}`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    assert.equal(listed.configs["script-draft"].params.draft.topic, "售后响应");
    assert.equal(listed.configs["script-draft"].params.draft.durationSec, 45);
  } finally {
    await app.close();
  }
});

test("pipeline params are remembered per project and active runs are capped", async () => {
  const app = await boot();
  try {
    const endpoint = `${app.runtime.url}/api/automation/runs`;
    const first = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "topic-pack",
        projectId: app.projectId,
        params: { topics: { count: 2, audience: "switcher", focus: "售后", maxCards: 1 } },
      }),
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).run.status, "waiting_manual");

    // Only the count is sent: the other fields come from the stored config.
    const second = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "topic-pack",
        projectId: app.projectId,
        params: { topics: { count: 4 } },
      }),
    });
    assert.equal(second.status, 201);
    const secondRun = (await second.json()).run;
    assert.equal(secondRun.params.topics.count, 4);
    assert.equal(secondRun.params.topics.focus, "售后");
    assert.equal(secondRun.params.topics.audience, "switcher");

    const limited = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "topic-pack",
        projectId: app.projectId,
        params: { topics: { count: 1 } },
      }),
    });
    assert.equal(limited.status, 409);
    assert.match((await limited.json()).error, /最多同时 2 个/u);

    const listed = await (await fetch(`${app.runtime.url}/api/automation?projectId=${app.projectId}`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    assert.equal(listed.configs["topic-pack"].params.topics.count, 4);
    assert.equal(listed.pipelines.find((pipeline) => pipeline.id === "topic-pack").maxRunning, 2);
  } finally {
    await app.close();
  }
});

test("the topic and rewrite pipelines produce their own artifacts", async () => {
  const app = await boot({
    automationChat: async ({ messages }) => {
      if (messages[0].content.includes("改写")) {
        return { content: "镜头 1：旧稿第一段。\n需人工核对：无。", model: "test-model" };
      }
      return { content: "## 选题 1：售后不是成本\n- 依据：待补知识", model: "test-model" };
    },
  });
  try {
    const listed = await (await fetch(`${app.runtime.url}/api/automation`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const rewritePipeline = listed.pipelines.find((pipeline) => pipeline.id === "script-rewrite");
    const draft = rewritePipeline.steps[0].params.find((param) => param.key === "draft");
    assert.equal(draft.multiline, true);
    assert.equal(draft.maxLength, 4_000);
    assert.equal(draft.required, true);

    const endpoint = `${app.runtime.url}/api/automation/runs`;
    const missingDraft = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ pipelineId: "script-rewrite", projectId: app.projectId, params: { rewrite: {} } }),
    });
    assert.equal(missingDraft.status, 400);
    assert.match((await missingDraft.json()).error, /原始草稿不能为空/u);

    const topics = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "topic-pack",
        projectId: app.projectId,
        params: { topics: { count: 2, audience: "switcher", focus: "售后", maxCards: 0 } },
      }),
    });
    assert.equal(topics.status, 201);
    const topicRun = (await topics.json()).run;
    assert.equal(topicRun.status, "waiting_manual");
    assert.equal(topicRun.steps.topics.artifacts[0].slot, "topics");
    const topicArtifact = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${topicRun.id}/artifacts/topics`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(topicArtifact.text, /^# 选题提案/u);
    assert.match(topicArtifact.text, /- 受众：转型者/u);
    assert.match(topicArtifact.text, /- 聚焦方向：售后/u);
    assert.match(topicArtifact.text, /## 选题 1：售后不是成本/u);

    const rewrite = await fetch(endpoint, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "script-rewrite",
        projectId: app.projectId,
        params: {
          rewrite: { draft: "旧稿第一段。", audience: "operator", durationSec: 30, tone: "warm", maxCards: 0 },
        },
      }),
    });
    assert.equal(rewrite.status, 201);
    const rewriteRun = (await rewrite.json()).run;
    assert.equal(rewriteRun.status, "waiting_manual");
    assert.equal(rewriteRun.steps.rewrite.artifacts[0].slot, "rewrite");
    const rewriteArtifact = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${rewriteRun.id}/artifacts/rewrite`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(rewriteArtifact.text, /^# 口播改写稿/u);
    assert.match(rewriteArtifact.text, /- 原稿字数：6/u);
    assert.match(rewriteArtifact.text, /镜头 1：旧稿第一段。/u);
    assert.match(rewriteArtifact.text, /需人工核对：无/u);
  } finally {
    await app.close();
  }
});

test("media tools are reported and the inventory pipeline scans an allowed root", async () => {
  const app = await boot({
    mediaProbe: async () => ({
      ffmpeg: { available: false, path: null, version: null, reason: "未安装，或不在 PATH 里" },
      ffprobe: { available: false, path: null, version: null, reason: "未安装，或不在 PATH 里" },
      checkedAt: "2026-10-21T00:00:00.000Z",
    }),
  });
  try {
    assert.equal((await fetch(`${app.runtime.url}/api/media/capabilities`)).status, 401);
    const capabilities = await fetch(`${app.runtime.url}/api/media/capabilities`, {
      headers: { cookie: app.member.cookie },
    });
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).ffmpeg.available, false);

    const listed = await (await fetch(`${app.runtime.url}/api/automation`, {
      headers: { cookie: app.member.cookie },
    })).json();
    assert.equal(listed.pipelines.find((pipeline) => pipeline.id === "media-inventory").maxRunning, 2);
    assert.equal(listed.media.ffmpeg.available, false);

    const mediaDir = path.join(app.root, "media");
    await mkdir(path.join(mediaDir, "sub"), { recursive: true });
    await writeFile(path.join(mediaDir, "clip.mp4"), Buffer.alloc(64, 1));
    await writeFile(path.join(mediaDir, "voice.mp3"), Buffer.alloc(32, 2));
    await writeFile(path.join(mediaDir, "cover.png"), Buffer.alloc(16, 3));
    await writeFile(path.join(mediaDir, "notes.txt"), "skip me");

    const saved = await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });
    assert.equal(saved.status, 200);

    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "media-inventory",
        projectId: app.projectId,
        params: { scan: { root: mediaDir, kinds: "video", maxFiles: 10 } },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.equal(run.steps.scan.artifacts[0].slot, "inventory");
    const artifact = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/inventory`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(artifact.text, /^# 媒体素材清单/u);
    assert.match(artifact.text, /clip\.mp4/u);
    assert.equal(artifact.text.includes("voice.mp3"), false);
    assert.equal(artifact.text.includes("notes.txt"), false);

    const outside = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "media-inventory",
        projectId: app.projectId,
        params: { scan: { root: app.root, kinds: "all", maxFiles: 10 } },
      }),
    });
    assert.equal(outside.status, 201);
    const failed = (await outside.json()).run;
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /白名单/u);
  } finally {
    await app.close();
  }
});

test("the audio pipeline transcodes an allowed source and serves the binary artifact", async () => {
  const app = await boot({
    mediaProbe: async () => ({
      ffmpeg: { available: true, path: "ffmpeg", version: "test", reason: "" },
      ffprobe: { available: true, path: "ffprobe", version: "test", reason: "" },
      checkedAt: "2026-10-21T00:00:00.000Z",
    }),
    mediaRun: async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { format_name: "mov,mp4", duration: "12.5", size: "4096" },
            streams: [{ codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1 }],
          }),
          stderr: "",
        };
      }
      await writeFile(args[args.length - 1], Buffer.alloc(2048, 5));
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const mediaDir = path.join(app.root, "audio-source");
    await mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "clip.mp4");
    await writeFile(source, Buffer.alloc(4096, 1));
    const saved = await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });
    assert.equal(saved.status, 200);

    assert.equal(
      (await fetch(`${app.runtime.url}/api/automation/runs/run_x/artifacts/audio/download`)).status,
      401,
    );

    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "audio-extract",
        projectId: app.projectId,
        params: { extract: { source, format: "wav" } },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.equal(run.steps.extract.status, "done");
    assert.equal(run.steps.extract.artifacts[0].slot, "audio");
    assert.match(run.steps.extract.artifacts[0].path, /audio\.wav$/u);
    assert.equal(run.steps.extract.artifacts[0].bytes, 2048);
    assert.equal(run.steps.extract.logs[0], "源文件：clip.mp4");

    const download = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/audio/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "audio/wav");
    assert.match(download.headers.get("content-disposition"), /attachment; filename="audio\.wav"/u);
    assert.equal((await download.arrayBuffer()).byteLength, 2048);

    const outside = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "audio-extract",
        projectId: app.projectId,
        params: { extract: { source: path.join(app.root, "missing.mp4"), format: "m4a" } },
      }),
    });
    assert.equal(outside.status, 201);
    const failed = (await outside.json()).run;
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /不存在|白名单/u);
  } finally {
    await app.close();
  }
});

test("the video pipeline normalises an allowed source and serves both artifacts", async () => {
  const app = await boot({
    mediaProbe: async () => ({
      ffmpeg: { available: true, path: "ffmpeg", version: "test", reason: "" },
      ffprobe: { available: true, path: "ffprobe", version: "test", reason: "" },
      checkedAt: "2026-10-21T00:00:00.000Z",
    }),
    mediaRun: async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { format_name: "mov,mp4", duration: "9.5", size: "8192" },
            streams: [
              { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
              { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
            ],
          }),
          stderr: "",
        };
      }
      const output = args[args.length - 1];
      if (args.includes("-frames:v")) {
        await writeFile(output, Buffer.alloc(900, 4));
      } else {
        await writeFile(output, Buffer.alloc(2048, 6));
      }
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const mediaDir = path.join(app.root, "video-source");
    await mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "clip.mov");
    await writeFile(source, Buffer.alloc(8192, 1));
    const saved = await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });
    assert.equal(saved.status, 200);

    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "video-normalize",
        projectId: app.projectId,
        params: { normalize: { source, height: "720", cover: true } },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.deepEqual(run.steps.normalize.artifacts.map((entry) => entry.slot), ["video", "cover"]);
    assert.equal(run.steps.normalize.artifacts[0].bytes, 2048);
    assert.equal(run.steps.normalize.artifacts[1].bytes, 900);
    assert.equal(run.steps.normalize.logs[1], "目标高度 720p，h264 → H.264 / AAC");

    const video = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/video/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    assert.equal((await video.arrayBuffer()).byteLength, 2048);

    const cover = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/cover/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get("content-type"), "image/jpeg");
    assert.equal((await cover.arrayBuffer()).byteLength, 900);

    // The accepted params are remembered for the next run of this project.
    const listed = await (await fetch(`${app.runtime.url}/api/automation?projectId=${app.projectId}`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    assert.equal(listed.configs["video-normalize"].params.normalize.height, "720");
    assert.equal(listed.configs["video-normalize"].params.normalize.cover, true);
  } finally {
    await app.close();
  }
});

test("the reframe pipeline writes every requested platform canvas", async () => {
  const app = await boot({
    mediaProbe: async () => ({
      ffmpeg: { available: true, path: "ffmpeg", version: "test", reason: "" },
      ffprobe: { available: true, path: "ffprobe", version: "test", reason: "" },
      checkedAt: "2026-10-21T00:00:00.000Z",
    }),
    mediaRun: async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { format_name: "mov,mp4", duration: "6", size: "4096" },
            streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }],
          }),
          stderr: "",
        };
      }
      await writeFile(args[args.length - 1], Buffer.alloc(1024, 7));
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const mediaDir = path.join(app.root, "portrait-source");
    await mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "portrait.mp4");
    await writeFile(source, Buffer.alloc(4096, 1));
    await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });

    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "video-reframe",
        projectId: app.projectId,
        params: { reframe: { source, quality: "720", landscape: true, vertical: true, square: true } },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.deepEqual(run.steps.reframe.artifacts.map((entry) => entry.label), [
      "横屏 16:9（1280×720）",
      "竖屏 9:16（720×1280）",
      "方屏 1:1（720×720）",
    ]);
    assert.deepEqual(run.steps.reframe.artifacts.map((entry) => entry.slot),
      ["landscape", "vertical", "square"]);

    for (const slot of ["landscape", "vertical", "square"]) {
      const download = await fetch(
        `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/${slot}/download`,
        { headers: { cookie: app.admin.cookie } },
      );
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-type"), "video/mp4");
      assert.equal((await download.arrayBuffer()).byteLength, 1024);
    }
  } finally {
    await app.close();
  }
});

test("the subtitle pipeline muxes an SRT and serves both artifacts", async () => {
  const app = await boot({
    mediaProbe: async () => ({
      ffmpeg: { available: true, path: "ffmpeg", version: "test", reason: "" },
      ffprobe: { available: true, path: "ffprobe", version: "test", reason: "" },
      checkedAt: "2026-10-21T00:00:00.000Z",
    }),
    mediaRun: async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { format_name: "mov,mp4", duration: "10", size: "4096" },
            streams: [
              { codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
              { codec_type: "audio", codec_name: "aac" },
            ],
          }),
          stderr: "",
        };
      }
      await writeFile(args[args.length - 1], Buffer.alloc(2048, 8));
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const mediaDir = path.join(app.root, "subtitle-source");
    await mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "clip.mp4");
    await writeFile(source, Buffer.alloc(4096, 1));
    await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });

    const srt = "1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n2\n00:00:02,500 --> 00:00:04,000\n第二句\n";
    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "video-subtitle",
        projectId: app.projectId,
        params: { mux: { source, subtitles: srt } },
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const { run } = JSON.parse(text);
    assert.equal(run.status, "waiting_manual");
    assert.deepEqual(run.steps.mux.artifacts.map((entry) => entry.slot), ["video", "subtitles"]);
    assert.equal(run.steps.mux.artifacts[0].bytes, 2048);

    const video = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/video/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    assert.equal((await video.arrayBuffer()).byteLength, 2048);

    const subtitles = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/subtitles/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(subtitles.status, 200);
    assert.equal(subtitles.headers.get("content-type"), "application/x-subrip");
    assert.equal(await subtitles.text(), srt);

    // The SRT is plain text, so the preview endpoint can show it too.
    const preview = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/subtitles`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(preview.text, /^1\n00:00:00,500/u);

    const bad = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "video-subtitle",
        projectId: app.projectId,
        params: { mux: { source, subtitles: "没有时间码" } },
      }),
    });
    assert.equal(bad.status, 201);
    const failed = (await bad.json()).run;
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /缺少时间码/u);
  } finally {
    await app.close();
  }
});

test("the publish pipeline writes a plan and a manifest without calling a platform", async () => {
  const app = await boot();
  try {
    const mediaDir = path.join(app.root, "publish-source");
    await mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "final.mp4");
    await writeFile(source, Buffer.alloc(2048, 1));
    await fetch(`${app.runtime.url}/api/knowledge`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ action: "sourcesSave", roots: [mediaDir] }),
    });

    const response = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "publish-pack",
        projectId: app.projectId,
        params: {
          pack: {
            source,
            title: "售后不是成本",
            description: "两小时响应。\n#售后 #效率",
            douyin: true,
            wechat: true,
            xiaohongshu: false,
          },
        },
      }),
    });
    assert.equal(response.status, 201);
    const { run } = await response.json();
    assert.equal(run.status, "waiting_manual");
    assert.deepEqual(run.steps.pack.artifacts.map((entry) => entry.slot), ["plan", "manifest"]);

    const plan = await (await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/plan`,
      { headers: { cookie: app.admin.cookie } },
    )).json();
    assert.match(plan.text, /^# 发布清单 · 售后不是成本/u);
    assert.match(plan.text, /### 抖音/u);
    assert.match(plan.text, /不会自动上传到任何平台/u);

    const manifestDownload = await fetch(
      `${app.runtime.url}/api/automation/runs/${run.id}/artifacts/manifest/download`,
      { headers: { cookie: app.admin.cookie } },
    );
    assert.equal(manifestDownload.status, 200);
    assert.equal(manifestDownload.headers.get("content-type"), "application/json");
    const manifest = JSON.parse(await manifestDownload.text());
    assert.equal(manifest.content.title, "售后不是成本");
    assert.deepEqual(manifest.platforms.map((platform) => platform.id), ["douyin", "wechat"]);
    assert.equal(manifest.platforms.every((platform) => platform.uploaded === false), true);

    const bad = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "publish-pack",
        projectId: app.projectId,
        params: {
          pack: { source, title: "标题", douyin: false, wechat: false, xiaohongshu: false },
        },
      }),
    });
    assert.equal(bad.status, 201);
    const failed = (await bad.json()).run;
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /至少要选择一个发布平台/u);

    // A failed run must not overwrite the last working params.
    const listed = await (await fetch(`${app.runtime.url}/api/automation?projectId=${app.projectId}`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    assert.equal(listed.configs["publish-pack"].params.pack.douyin, true);
    assert.equal(listed.configs["publish-pack"].params.pack.wechat, true);
    assert.equal(listed.configs["publish-pack"].params.pack.xiaohongshu, false);
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

    const badParams = await fetch(`${app.runtime.url}/api/automation/runs`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({
        pipelineId: "knowledge-brief",
        projectId: app.projectId,
        params: { snapshot: { maxCards: 999 } },
      }),
    });
    assert.equal(badParams.status, 400);
    assert.match((await badParams.json()).error, /不能大于 100/u);

    const trail = await (await fetch(`${app.runtime.url}/api/audit?limit=10`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    const denials = trail.entries.filter((entry) => entry.action === "automation.run");
    assert.deepEqual(denials.map((entry) => entry.outcome), ["denied", "denied", "denied"]);
    assert.match(denials[0].detail, /不能大于 100/u);
    assert.match(denials[1].detail, /项目不存在/u);
    assert.match(denials[2].detail, /没有这条产线/u);
  } finally {
    await app.close();
  }
});
