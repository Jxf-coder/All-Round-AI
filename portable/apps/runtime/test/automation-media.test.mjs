import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDIO_FORMATS,
  VIDEO_HEIGHTS,
  VIDEO_QUALITIES,
  VIDEO_SPECS,
  createAudioExtractHandler,
  createMediaInventoryHandler,
  createVideoNormalizeHandler,
  createVideoReframeHandler,
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

// --- video normalisation -------------------------------------------------

function normalizeRunner({
  video = { codec_name: "h264", width: 1920, height: 1080 },
  duration = "12.5",
  withAudio = true,
  failEncode = false,
  failCover = false,
  calls = [],
} = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("-print_format")) {
      return {
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4", duration, size: "2048" },
          streams: [
            { codec_type: "video", ...video },
            ...(withAudio ? [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }] : []),
          ],
        }),
        stderr: "",
      };
    }
    const output = args[args.length - 1];
    if (args.includes("-frames:v")) {
      if (failCover) {
        await writeFile(output, "");
        throw new Error("cover extraction failed");
      }
      await writeFile(output, Buffer.alloc(512, 3));
      return { stdout: "", stderr: "" };
    }
    if (failEncode) {
      await writeFile(output, Buffer.alloc(64, 1));
      throw new Error("encode failed");
    }
    await writeFile(output, Buffer.alloc(1024, 2));
    return { stdout: "", stderr: "" };
  };
}

function normalizeHandler({ media, artifacts, runner, mediaProbe = async () => toolsAvailable() }) {
  return createVideoNormalizeHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
    mediaProbe,
    runner,
  });
}

async function normalizeFixture(callback) {
  await fixture(async ({ root, media, artifacts }) => {
    await callback({ root, media, artifacts, source: path.join(media, "a.mp4") });
  });
}

test("video normalisation scales to the requested height and writes a cover", async () => {
  assert.deepEqual(VIDEO_HEIGHTS, [1080, 720, 540, 360]);
  await normalizeFixture(async ({ media, artifacts, source }) => {
    const calls = [];
    const handler = normalizeHandler({ media, artifacts, runner: normalizeRunner({ calls }) });
    const outcome = await handler["media.normalize-video"]({
      run: runLike(),
      params: { source, height: "720", cover: true },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["video", "cover"]);
    assert.match(outcome.artifacts[0].path, /run_media[\\/]video\.mp4$/u);
    assert.match(outcome.artifacts[1].path, /run_media[\\/]cover\.jpg$/u);
    assert.equal(outcome.artifacts[0].bytes, 1024);
    assert.equal(outcome.artifacts[1].bytes, 512);

    const encode = calls.find((call) => call.args.includes("-c:v"));
    assert.deepEqual(encode.args.slice(0, 3), ["-hide_banner", "-nostdin", "-y"]);
    assert.equal(encode.args[encode.args.indexOf("-vf") + 1], "scale=-2:720");
    assert.ok(encode.args.includes("libx264"));
    assert.ok(encode.args.includes("+faststart"));
    assert.equal(encode.options.timeout, 120_000);

    const cover = calls.find((call) => call.args.includes("-frames:v"));
    assert.equal(cover.args[cover.args.indexOf("-ss") + 1], "1.00");
    assert.match(cover.args[cover.args.length - 1], /cover\.jpg$/u);

    assert.equal(outcome.logs[0], "源文件：a.mp4；1920×1080，时长 0:13");
    assert.equal(outcome.logs[1], "目标高度 720p，h264 → H.264 / AAC");
    assert.equal(outcome.logs[2], "视频 1.0 KB；封面 512 B");
    assert.equal((await readFile(path.join(artifacts, "run_media", "video.mp4"))).length, 1024);
  });
});

test("video normalisation never upscales a smaller source", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    const calls = [];
    const handler = normalizeHandler({
      media,
      artifacts,
      runner: normalizeRunner({ video: { codec_name: "hevc", width: 854, height: 481 }, calls }),
    });
    const outcome = await handler["media.normalize-video"]({
      run: runLike(),
      params: { source, height: "1080", cover: false },
    });
    const encode = calls.find((call) => call.args.includes("-c:v"));
    // 481 becomes 480 so the derived width stays even.
    assert.equal(encode.args[encode.args.indexOf("-vf") + 1], "scale=-2:480");
    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["video"]);
    assert.match(outcome.logs[2], /未抽取封面/u);
    await assert.rejects(readFile(path.join(artifacts, "run_media", "cover.jpg")), /ENOENT/u);
  });
});

test("video normalisation refuses sources without a video track or with a bad height", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    // A stream list with only audio claims no video track.
    const audioOnly = async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { duration: "5" },
            streams: [{ codec_type: "audio", codec_name: "aac" }],
          }),
          stderr: "",
        };
      }
      throw new Error("should not encode");
    };
    await assert.rejects(
      normalizeHandler({ media, artifacts, runner: audioOnly })["media.normalize-video"]({
        run: runLike(),
        params: { source, height: "720" },
      }),
      /没有视频轨/u,
    );

    const handler = normalizeHandler({ media, artifacts, runner: normalizeRunner() });
    await assert.rejects(
      handler["media.normalize-video"]({
        run: runLike(),
        params: { source, height: "900", cover: false },
      }),
      /目标高度无效/u,
    );

    await assert.rejects(
      normalizeHandler({
        media,
        artifacts,
        runner: normalizeRunner(),
        mediaProbe: async () => ({
          ffmpeg: { available: false, reason: "未安装" },
          ffprobe: { available: true, path: FFPROBE },
        }),
      })["media.normalize-video"]({ run: runLike(), params: { source, height: "720" } }),
      /未检测到 FFmpeg/u,
    );
  });
});

test("a failed encode or cover removes both partial files", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    await assert.rejects(
      normalizeHandler({ media, artifacts, runner: normalizeRunner({ failEncode: true }) })["media.normalize-video"]({
        run: runLike(),
        params: { source, height: "720", cover: true },
      }),
      (error) => {
        assert.match(error.message, /^视频规格化失败：encode failed$/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(artifacts, "run_media", "video.mp4")), /ENOENT/u);

    await assert.rejects(
      normalizeHandler({ media, artifacts, runner: normalizeRunner({ failCover: true }) })["media.normalize-video"]({
        run: runLike(),
        params: { source, height: "720", cover: true },
      }),
      (error) => {
        assert.match(error.message, /^封面抽取失败：cover extraction failed$/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(artifacts, "run_media", "video.mp4")), /ENOENT/u);
    await assert.rejects(readFile(path.join(artifacts, "run_media", "cover.jpg")), /ENOENT/u);
  });
});

// --- platform reframing --------------------------------------------------

function reframeHandler({ media, artifacts, runner, mediaProbe = async () => toolsAvailable() }) {
  return createVideoReframeHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
    mediaProbe,
    runner,
  });
}

test("platform reframing writes every selected canvas with padding", async () => {
  assert.deepEqual(VIDEO_QUALITIES, [1080, 720, 540]);
  assert.deepEqual(Object.keys(VIDEO_SPECS), ["landscape", "vertical", "square"]);
  await normalizeFixture(async ({ media, artifacts, source }) => {
    const calls = [];
    const handler = reframeHandler({ media, artifacts, runner: normalizeRunner({ calls }) });
    const outcome = await handler["media.reframe-video"]({
      run: runLike(),
      params: { source, quality: "720", landscape: true, vertical: true, square: true },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["landscape", "vertical", "square"]);
    assert.deepEqual(outcome.artifacts.map((entry) => entry.label), [
      "横屏 16:9（1280×720）",
      "竖屏 9:16（720×1280）",
      "方屏 1:1（720×720）",
    ]);
    assert.deepEqual(outcome.artifacts.map((entry) => path.basename(entry.path)), [
      "landscape.mp4",
      "vertical.mp4",
      "square.mp4",
    ]);

    const encodes = calls.filter((call) => call.args.includes("-c:v"));
    assert.equal(encodes.length, 3);
    for (const [index, expected] of [
      ["1280:720", "1280:720"],
      ["720:1280", "720:1280"],
      ["720:720", "720:720"],
    ].entries()) {
      const filter = encodes[index].args[encodes[index].args.indexOf("-vf") + 1];
      assert.ok(filter.startsWith(`scale=${expected[0]}:force_original_aspect_ratio=decrease,`), filter);
      assert.ok(filter.includes(`pad=${expected[1]}:(ow-iw)/2:(oh-ih)/2:color=black`), filter);
      assert.ok(filter.endsWith("setsar=1"), filter);
    }
    assert.equal(encodes[0].options.timeout, 120_000);
    assert.match(outcome.logs[1], /^规格：横屏 16:9（1280×720）；竖屏 9:16（720×1280）；方屏 1:1（720×720）$/u);
    assert.equal(outcome.logs[2], "输出 3 个文件，共 3.0 KB");
  });
});

test("platform reframing honours a single canvas and the 1080 tier", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    const calls = [];
    const handler = reframeHandler({ media, artifacts, runner: normalizeRunner({ calls }) });
    const outcome = await handler["media.reframe-video"]({
      run: runLike(),
      params: { source, quality: "1080", landscape: false, vertical: true, square: false },
    });
    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["vertical"]);
    assert.equal(outcome.artifacts[0].label, "竖屏 9:16（1080×1920）");
    const encode = calls.find((call) => call.args.includes("-c:v"));
    assert.match(encode.args[encode.args.indexOf("-vf") + 1], /^scale=1080:1920:/u);
  });
});

test("platform reframing refuses empty or invalid selections and sources without video", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    const handler = reframeHandler({ media, artifacts, runner: normalizeRunner() });
    await assert.rejects(
      handler["media.reframe-video"]({
        run: runLike(),
        params: { source, quality: "720", landscape: false, vertical: false, square: false },
      }),
      /至少要选择一种输出规格/u,
    );
    await assert.rejects(
      handler["media.reframe-video"]({
        run: runLike(),
        params: { source, quality: "900", landscape: true, vertical: false, square: false },
      }),
      /目标规格无效/u,
    );

    const audioOnly = async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({ format: { duration: "3" }, streams: [{ codec_type: "audio" }] }),
          stderr: "",
        };
      }
      throw new Error("should not encode");
    };
    await assert.rejects(
      reframeHandler({ media, artifacts, runner: audioOnly })["media.reframe-video"]({
        run: runLike(),
        params: { source, quality: "720", landscape: true, vertical: false, square: false },
      }),
      /没有视频轨/u,
    );

    await assert.rejects(
      reframeHandler({
        media,
        artifacts,
        runner: normalizeRunner(),
        mediaProbe: async () => ({
          ffmpeg: { available: false, reason: "未安装" },
          ffprobe: { available: false, reason: "未安装" },
        }),
      })["media.reframe-video"]({
        run: runLike(),
        params: { source, quality: "720", landscape: true, vertical: false, square: false },
      }),
      /未检测到 FFmpeg/u,
    );
  });
});

test("a failed canvas removes every file produced by the run", async () => {
  await normalizeFixture(async ({ media, artifacts, source }) => {
    let encodes = 0;
    const runner = async (command, args) => {
      if (args.includes("-print_format")) {
        return {
          stdout: JSON.stringify({
            format: { duration: "4" },
            streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }],
          }),
          stderr: "",
        };
      }
      encodes += 1;
      const output = args[args.length - 1];
      if (encodes === 2) {
        await writeFile(output, Buffer.alloc(32, 1));
        throw new Error("second canvas failed");
      }
      await writeFile(output, Buffer.alloc(1024, 2));
      return { stdout: "", stderr: "" };
    };
    await assert.rejects(
      reframeHandler({ media, artifacts, runner })["media.reframe-video"]({
        run: runLike(),
        params: { source, quality: "720", landscape: true, vertical: true, square: false },
      }),
      (error) => {
        assert.equal(error.message, "多规格转码失败：second canvas failed");
        return true;
      },
    );
    await assert.rejects(readFile(path.join(artifacts, "run_media", "landscape.mp4")), /ENOENT/u);
    await assert.rejects(readFile(path.join(artifacts, "run_media", "vertical.mp4")), /ENOENT/u);
  });
});

test("platform reframing refuses to be built without its dependencies", () => {
  assert.throws(
    () => createVideoReframeHandler({
      sourceStore: null,
      artifactsDir: os.tmpdir(),
      mediaProbe: async () => toolsAvailable(),
    }),
    /来源配置/u,
  );
  assert.throws(
    () => createVideoReframeHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
  assert.throws(
    () => createVideoReframeHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: os.tmpdir(),
    }),
    /媒体工具探测/u,
  );
});

test("video normalisation refuses to be built without its dependencies", () => {
  assert.throws(
    () => createVideoNormalizeHandler({
      sourceStore: null,
      artifactsDir: os.tmpdir(),
      mediaProbe: async () => toolsAvailable(),
    }),
    /来源配置/u,
  );
  assert.throws(
    () => createVideoNormalizeHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
  assert.throws(
    () => createVideoNormalizeHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: os.tmpdir(),
    }),
    /媒体工具探测/u,
  );
});
