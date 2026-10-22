import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLISH_LIMITS,
  PUBLISH_PLATFORMS,
  buildPublishPlan,
  createPublishPackHandler,
} from "../src/automation-publish.mjs";

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-publish-"));
  const media = path.join(root, "media");
  const artifacts = path.join(root, "artifacts");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "final.mp4"), Buffer.alloc(2048, 1));
  await writeFile(path.join(media, "notes.txt"), "not a video");
  try {
    await callback({ root, media, artifacts, source: path.join(media, "final.mp4") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runLike() {
  return { id: "run_publish", projectId: "project-1", steps: {} };
}

function handlerFor(media, artifacts) {
  return createPublishPackHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
  });
}

test("the plan carries the copy, platform checks and the manual receipt notice", () => {
  const plan = buildPublishPlan({
    run: runLike(),
    source: path.join(os.tmpdir(), "final.mp4"),
    sourceInfo: { size: 2048 },
    title: "售后不是成本",
    description: "两小时响应。\n#售后 #效率",
    platforms: PUBLISH_PLATFORMS.slice(0, 2),
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  assert.match(plan, /^# 发布清单 · 售后不是成本/u);
  assert.match(plan, /- 源文件：final\.mp4（2\.0 KB）/u);
  assert.match(plan, /- 标题字数：6/u);
  assert.match(plan, /- 平台：抖音、视频号/u);
  assert.match(plan, /### 抖音/u);
  assert.match(plan, /建议画布：竖屏 9:16/u);
  assert.match(plan, /- \[ \] 发布后回填作品链接/u);
  assert.match(plan, /不会自动上传到任何平台/u);
  assert.equal(plan.includes("小红书"), false);
});

test("the handler writes a plan and a manifest inside the artifacts directory", async () => {
  await fixture(async ({ media, artifacts, source }) => {
    const handler = handlerFor(media, artifacts);
    const outcome = await handler["publish.package"]({
      run: runLike(),
      params: {
        source,
        title: "售后不是成本",
        description: "两小时响应。\n#售后 #效率",
        douyin: true,
        wechat: false,
        xiaohongshu: true,
      },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["plan", "manifest"]);
    assert.match(outcome.artifacts[0].path, /run_publish[\\/]publish-plan\.md$/u);
    assert.match(outcome.artifacts[1].path, /run_publish[\\/]publish-manifest\.json$/u);

    const plan = await readFile(outcome.artifacts[0].path, "utf8");
    assert.match(plan, /^# 发布清单 · 售后不是成本/u);
    assert.match(plan, /#售后 #效率/u);
    assert.match(plan, /### 小红书/u);
    assert.equal(plan.includes("### 视频号"), false);

    const manifest = JSON.parse(await readFile(outcome.artifacts[1].path, "utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.runId, "run_publish");
    assert.equal(manifest.projectId, "project-1");
    assert.equal(manifest.source.path, await realpath(source));
    assert.equal(manifest.source.name, "final.mp4");
    assert.equal(manifest.source.bytes, 2048);
    assert.equal(manifest.content.titleLength, 6);
    assert.equal(manifest.content.descriptionLength, [..."两小时响应。\n#售后 #效率"].length);
    assert.deepEqual(manifest.platforms.map((platform) => [platform.id, platform.uploaded]), [
      ["douyin", false],
      ["xiaohongshu", false],
    ]);

    assert.equal(outcome.artifacts[1].bytes, Buffer.byteLength(await readFile(outcome.artifacts[1].path, "utf8")));
    assert.deepEqual(outcome.logs, [
      "源文件：final.mp4（2.0 KB）",
      "平台：抖音、小红书",
      "标题 6 字；文案 14 字",
    ]);
  });
});

test("publishing refuses empty titles, oversized copy, no platform and non-video sources", async () => {
  await fixture(async ({ root, media, artifacts, source }) => {
    const handler = handlerFor(media, artifacts);
    const base = { source, title: "标题", douyin: true, wechat: false, xiaohongshu: false };

    await assert.rejects(
      handler["publish.package"]({ run: runLike(), params: { ...base, title: "  " } }),
      /标题不能为空/u,
    );
    await assert.rejects(
      handler["publish.package"]({
        run: runLike(),
        params: { ...base, title: "字".repeat(PUBLISH_LIMITS.title + 1) },
      }),
      /标题不能超过 120 个字符/u,
    );
    await assert.rejects(
      handler["publish.package"]({
        run: runLike(),
        params: { ...base, description: "字".repeat(PUBLISH_LIMITS.description + 1) },
      }),
      /文案不能超过 2000 个字符/u,
    );
    await assert.rejects(
      handler["publish.package"]({
        run: runLike(),
        params: { ...base, douyin: false, wechat: false, xiaohongshu: false },
      }),
      /至少要选择一个发布平台/u,
    );
    await assert.rejects(
      handler["publish.package"]({ run: runLike(), params: { ...base, douyin: "yes" } }),
      /平台开关必须是布尔值/u,
    );
    await assert.rejects(
      handler["publish.package"]({
        run: runLike(),
        params: { ...base, source: path.join(media, "notes.txt") },
      }),
      /必须是视频文件/u,
    );
    await assert.rejects(
      handler["publish.package"]({
        run: runLike(),
        params: { ...base, source: path.join(root, "outside.mp4") },
      }),
      /不存在|白名单/u,
    );
  });
});

test("the publish handler refuses to be built without its dependencies", () => {
  assert.throws(
    () => createPublishPackHandler({ sourceStore: null, artifactsDir: os.tmpdir() }),
    /来源配置/u,
  );
  assert.throws(
    () => createPublishPackHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
    }),
    /产物目录必须是绝对路径/u,
  );
});
