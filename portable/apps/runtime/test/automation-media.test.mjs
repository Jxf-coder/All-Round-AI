import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDIO_FORMATS,
  createAudioExtractHandler,
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

// --- audio extraction -----------------------------------------------------

const FFMPEG = path.join(os.tmpdir(), "E-tools-ffmpeg.exe");
const FFPROBE = path.join(os.tmpdir(), "E-tools-ffprobe.exe");

function toolsAvailable() {
  return {
    ffmpeg: { available: true, path: FFMPEG, version: "ffmpeg version 7", reason: "" },
    ffprobe: { available: true, path: FFPROBE, version: "ffprobe version 7", reason: "" },
  };
}

function ffprobeJson(overrides = {}) {
  return JSON.stringify({
    format: { format_name: "mov,mp4,m4a", duration: "30.5", size: "2048" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
    ...overrides,
  });
}

async function audioFixture(callback) {
  await fixture(async ({ root, media, artifacts }) => {
    const source = path.join(media, "a.mp4");
    await callback({ root, media, artifacts, source });
  });
}

test("audio extraction probes the source, transcodes and reports the artifact", async () => {
  await audioFixture(async ({ media, artifacts, source }) => {
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === FFPROBE) return { stdout: ffprobeJson(), stderr: "" };
      await writeFile(args[args.length - 1], Buffer.alloc(4096, 7));
      return { stdout: "", stderr: "" };
    };
    const handler = createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
      mediaProbe: async () => toolsAvailable(),
      runner,
    });
    const outcome = await handler["media.extract-audio"]({
      run: runLike(),
      params: { source, format: "mp3" },
    });

    const artifact = outcome.artifacts[0];
    assert.equal(artifact.slot, "audio");
    assert.match(artifact.path, /run_media[\\/]audio\.mp3$/u);
    assert.equal(artifact.label, "音频（MP3 (LAME 192k)）");
    assert.equal(artifact.bytes, 4096);
    assert.equal((await readFile(artifact.path)).length, 4096);

    const ffmpegCall = calls.find((call) => call.command === FFMPEG);
    assert.deepEqual(ffmpegCall.args.slice(0, 3), ["-hide_banner", "-nostdin", "-y"]);
    assert.ok(ffmpegCall.args.includes("-vn"));
    assert.deepEqual(
      ffmpegCall.args.slice(ffmpegCall.args.indexOf("-map"), ffmpegCall.args.indexOf("-map") + 2),
      ["-map", "0:a:0"],
    );
    assert.ok(ffmpegCall.args.includes("libmp3lame"));
    // 30.5s * 3 秒/秒, clamped to the 60s floor.
    assert.equal(ffmpegCall.options.timeout, 91_500);
    assert.equal(ffmpegCall.options.env.FFMPEG_PATH, undefined);

    assert.deepEqual(outcome.logs, [
      "源文件：a.mp4",
      "时长：0:31；音频：aac / 48000 Hz / 2 声道",
      `MP3 (LAME 192k)，${(4096 / 1024).toFixed(1)} KB`,
    ]);
  });
});

test("audio extraction uses the requested container and codec", async () => {
  await audioFixture(async ({ media, artifacts, source }) => {
    const seen = [];
    const runner = async (command, args) => {
      if (command === FFPROBE) return { stdout: ffprobeJson(), stderr: "" };
      seen.push(args);
      await writeFile(args[args.length - 1], Buffer.alloc(64, 1));
      return { stdout: "", stderr: "" };
    };
    const handler = createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
      mediaProbe: async () => toolsAvailable(),
      runner,
    });

    for (const name of Object.keys(AUDIO_FORMATS)) {
      const outcome = await handler["media.extract-audio"]({
        run: { ...runLike(), id: `run_${name}` },
        params: { source, format: name },
      });
      assert.match(outcome.artifacts[0].path, new RegExp(`audio\\.${name}$`, "u"));
    }
    assert.deepEqual(seen.map((args) => args[args.length - 1].split(".").pop()), ["m4a", "mp3", "wav"]);
    assert.ok(seen[0].includes("aac"));
    assert.ok(seen[2].includes("pcm_s16le"));
  });
});

test("audio extraction refuses missing tools, unknown formats and files without audio", async () => {
  await audioFixture(async ({ root, media, artifacts, source }) => {
    const handlerWith = (mediaProbe, runner = async () => ({ stdout: "", stderr: "" })) =>
      createAudioExtractHandler({
        sourceStore: { list: async () => ({ roots: [media] }) },
        artifactsDir: artifacts,
        mediaProbe,
        runner,
      });

    await assert.rejects(
      handlerWith(async () => ({
        ffmpeg: { available: false, reason: "未安装" },
        ffprobe: { available: true, path: FFPROBE },
      }))["media.extract-audio"]({ run: runLike(), params: { source, format: "m4a" } }),
      /未检测到 FFmpeg/u,
    );

    await assert.rejects(
      handlerWith(async () => toolsAvailable())["media.extract-audio"]({
        run: runLike(),
        params: { source, format: "flac" },
      }),
      /音频格式无效/u,
    );

    await assert.rejects(
      handlerWith(async () => toolsAvailable(), async () => ({
        stdout: ffprobeJson({ streams: [{ codec_type: "video", codec_name: "h264" }] }),
        stderr: "",
      }))["media.extract-audio"]({ run: runLike(), params: { source, format: "m4a" } }),
      /没有音频轨/u,
    );

    await assert.rejects(
      handlerWith(
        async () => toolsAvailable(),
        async () => ({ stdout: ffprobeJson(), stderr: "" }),
      )["media.extract-audio"]({
        run: runLike(),
        params: { source: path.join(root, "outside.mp4"), format: "m4a" },
      }),
      /不存在|白名单/u,
    );
  });
});

test("a failed encode removes the partial file and reports the first error line", async () => {
  await audioFixture(async ({ media, artifacts, source }) => {
    const runner = async (command, args) => {
      if (command === FFPROBE) return { stdout: ffprobeJson(), stderr: "" };
      await writeFile(args[args.length - 1], Buffer.alloc(128, 9));
      throw new Error("ffmpeg exited with code 1\nsecond line should be dropped");
    };
    const handler = createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
      mediaProbe: async () => toolsAvailable(),
      runner,
    });
    await assert.rejects(
      handler["media.extract-audio"]({ run: runLike(), params: { source, format: "m4a" } }),
      (error) => {
        assert.match(error.message, /^音频提取失败：ffmpeg exited with code 1$/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(artifacts, "run_media", "audio.m4a")), /ENOENT/u);
  });
});

test("an encode that produces no bytes is rejected", async () => {
  await audioFixture(async ({ media, artifacts, source }) => {
    const runner = async (command, args) => {
      if (command === FFPROBE) return { stdout: ffprobeJson(), stderr: "" };
      await writeFile(args[args.length - 1], "");
      return { stdout: "", stderr: "" };
    };
    const handler = createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [media] }) },
      artifactsDir: artifacts,
      mediaProbe: async () => toolsAvailable(),
      runner,
    });
    await assert.rejects(
      handler["media.extract-audio"]({ run: runLike(), params: { source, format: "wav" } }),
      /输出文件为空/u,
    );
    await assert.rejects(readFile(path.join(artifacts, "run_media", "audio.wav")), /ENOENT/u);
  });
});

test("audio extraction refuses to be built without a probe or artifacts directory", () => {
  assert.throws(
    () => createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: os.tmpdir(),
    }),
    /媒体工具探测/u,
  );
  assert.throws(
    () => createAudioExtractHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
});
