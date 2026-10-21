import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMediaInventoryHandler,
  mediaKindOf,
  scanMediaDirectory,
} from "../src/automation-media.mjs";

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-media-"));
  const media = path.join(root, "media");
  const artifacts = path.join(root, "artifacts");
  await mkdir(path.join(media, "sub"), { recursive: true });
  await writeFile(path.join(media, "a.mp4"), Buffer.alloc(100, 1));
  await writeFile(path.join(media, "b.MP3"), Buffer.alloc(50, 2));
  await writeFile(path.join(media, "notes.txt"), "not media");
  await writeFile(path.join(media, ".hidden.mp4"), Buffer.alloc(5, 3));
  await writeFile(path.join(media, "sub", "c.png"), Buffer.alloc(10, 4));
  try {
    await callback({ root, media, artifacts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runLike() {
  return { id: "run_media", projectId: "project-1", steps: {} };
}

test("extensions map to media kinds without confusing case", () => {
  assert.equal(mediaKindOf("clip.MP4"), "video");
  assert.equal(mediaKindOf("voice.m4a"), "audio");
  assert.equal(mediaKindOf("cover.JPEG"), "image");
  assert.equal(mediaKindOf("notes.txt"), null);
  assert.equal(mediaKindOf("archive.tar.gz"), null);
});

test("the scan keeps only media, honours the kind filter and flags truncation", async () => {
  await fixture(async ({ media }) => {
    const all = await scanMediaDirectory({ root: media, kinds: "all", maxFiles: 50 });
    assert.deepEqual(all.files.map((file) => file.path).sort(), ["a.mp4", "b.MP3", "sub/c.png"]);
    assert.equal(all.counts.dirs, 2);
    assert.equal(all.counts.files, 4);
    assert.equal(all.totalBytes, 160);
    assert.equal(all.truncated, false);

    const video = await scanMediaDirectory({ root: media, kinds: "video", maxFiles: 50 });
    assert.deepEqual(video.files.map((file) => file.path), ["a.mp4"]);

    const limited = await scanMediaDirectory({ root: media, kinds: "all", maxFiles: 1 });
    assert.equal(limited.files.length, 1);
    assert.equal(limited.truncated, true);

    await assert.rejects(scanMediaDirectory({ root: media, kinds: "text" }), /素材类型无效/u);
    await assert.rejects(scanMediaDirectory({ root: media, maxFiles: 0 }), /保留文件数/u);
    await assert.rejects(scanMediaDirectory({ root: "relative" }), /绝对路径/u);
  });
});

test("the handler writes a reviewable inventory with relative paths", async () => {
  await fixture(async ({ media, artifacts }) => {
    const handler = createMediaInventoryHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
    });
    const outcome = await handler["media.inventory"]({
      run: runLike(),
      params: { root: media, kinds: "all", maxFiles: 10 },
    });
    const artifact = outcome.artifacts[0];
    assert.equal(artifact.slot, "inventory");
    assert.match(artifact.path, /run_media[\\/]media-inventory\.md$/u);
    const text = await readFile(artifact.path, "utf8");
    assert.match(text, /^# 媒体素材清单/u);
    assert.match(text, /- 找到：3 个文件，共 160 B/u);
    assert.match(text, /a\.mp4/u);
    assert.match(text, /sub\/c\.png/u);
    assert.equal(text.includes("notes.txt"), false);
    assert.equal(text.includes(".hidden.mp4"), false);
    assert.deepEqual(outcome.logs, ["扫描 4 个文件，保留 3 个媒体文件", "合计 160 B"]);
  });
});

test("a root outside the allowlist is refused and an empty folder still writes a report", async () => {
  await fixture(async ({ root, media, artifacts }) => {
    const handler = createMediaInventoryHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
    });
    await assert.rejects(
      handler["media.inventory"]({
        run: runLike(),
        params: { root, kinds: "all", maxFiles: 10 },
      }),
      /白名单/u,
    );

    const empty = path.join(media, "empty");
    await mkdir(empty);
    const outcome = await handler["media.inventory"]({
      run: runLike(),
      params: { root: empty, kinds: "video", maxFiles: 10 },
    });
    const text = await readFile(outcome.artifacts[0].path, "utf8");
    assert.match(text, /没有找到符合类型的素材/u);
  });
});

test("the handler refuses to be built without its dependencies", () => {
  assert.throws(
    () => createMediaInventoryHandler({ sourceStore: null, artifactsDir: os.tmpdir() }),
    /来源配置/u,
  );
  assert.throws(
    () => createMediaInventoryHandler({ sourceStore: { list: async () => ({ roots: [] }) }, artifactsDir: "relative" }),
    /产物目录必须是绝对路径/u,
  );
});
