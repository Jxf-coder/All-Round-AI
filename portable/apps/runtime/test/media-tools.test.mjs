import assert from "node:assert/strict";
import test from "node:test";

import {
  createMediaToolProbe,
  detectMediaTools,
  MEDIA_PROBE_TTL_MS,
  parseFfprobeJson,
  runMediaTool,
} from "../src/media-tools.mjs";

function runnerStub(seen) {
  return async (command, args, options) => {
    seen.push({ command, args, options });
    if (command === "ffmpeg" || command.endsWith("ffmpeg.exe")) {
      return { stdout: "ffmpeg version 6.1.1 Copyright (c) 2000-2023\nbuilt with gcc\n" };
    }
    if (command === "ffprobe" || command.endsWith("ffprobe.exe")) {
      return { stdout: "ffprobe version 6.1.1\n" };
    }
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
}

test("both binaries are probed with a fixed command, no shell and a minimal environment", async () => {
  const seen = [];
  const result = await detectMediaTools({ runner: runnerStub(seen) });
  assert.equal(result.ffmpeg.available, true);
  assert.equal(result.ffmpeg.version, "ffmpeg version 6.1.1 Copyright (c) 2000-2023");
  assert.equal(result.ffprobe.version, "ffprobe version 6.1.1");
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.deepEqual(call.args, ["-version"]);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5_000);
    assert.equal(Object.keys(call.options.env).includes("PATH"), true);
    assert.equal(Object.keys(call.options.env).includes("HOME"), false);
  }
});

test("FFMPEG_PATH and FFPROBE_PATH can point outside PATH", async () => {
  const seen = [];
  const result = await detectMediaTools({
    runner: runnerStub(seen),
    env: {
      FFMPEG_PATH: "E:\\FFmpeg\\bin\\ffmpeg.exe",
      FFPROBE_PATH: " E:\\FFmpeg\\bin\\ffprobe.exe ",
      PATH: "C:\\Windows",
    },
  });
  assert.deepEqual(seen.map((call) => call.command), [
    "E:\\FFmpeg\\bin\\ffmpeg.exe",
    "E:\\FFmpeg\\bin\\ffprobe.exe",
  ]);
  assert.equal(result.ffmpeg.path, "E:\\FFmpeg\\bin\\ffmpeg.exe");
  assert.equal(result.ffprobe.path, "E:\\FFmpeg\\bin\\ffprobe.exe");

  const fallback = [];
  await detectMediaTools({
    runner: runnerStub(fallback),
    env: { FFMPEG_PATH: "   ", FFPROBE_PATH: "" },
  });
  assert.deepEqual(fallback.map((call) => call.command), ["ffmpeg", "ffprobe"]);
});

test("a missing binary is reported with a readable reason instead of throwing", async () => {
  const result = await detectMediaTools({
    runner: async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(result.ffmpeg.available, false);
  assert.equal(result.ffmpeg.path, null);
  assert.match(result.ffmpeg.reason, /未安装/u);

  const timedOut = await detectMediaTools({
    runner: async () => {
      throw Object.assign(new Error("timeout"), { killed: true });
    },
  });
  assert.match(timedOut.ffmpeg.reason, /超时/u);
});

test("the probe caches its answer and a refresh bypasses the cache", async () => {
  const seen = [];
  let now = 1_000;
  const probe = createMediaToolProbe({
    runner: runnerStub(seen),
    ttlMs: MEDIA_PROBE_TTL_MS,
    now: () => now,
  });
  await probe();
  await probe();
  assert.equal(seen.length, 2);

  now += MEDIA_PROBE_TTL_MS + 1;
  await probe();
  assert.equal(seen.length, 4);

  await probe({ refresh: true });
  assert.equal(seen.length, 6);
});

test("ffprobe JSON is normalised and malformed output fails loudly", () => {
  const info = parseFfprobeJson(JSON.stringify({
    format: { format_name: "mov,mp4,m4a", duration: "12.5", size: "2048" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
  }));
  assert.equal(info.formatName, "mov,mp4,m4a");
  assert.equal(info.duration, 12.5);
  assert.equal(info.size, 2048);
  assert.deepEqual(info.audio, { codec: "aac", sampleRate: 48000, channels: 2 });
  assert.deepEqual(info.video, { codec: "h264", width: 1920, height: 1080 });

  const silent = parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "video" }] }));
  assert.equal(silent.audio, null);
  assert.equal(silent.duration, null);
  assert.throws(() => parseFfprobeJson("not json"), /无法解析/u);
});

test("media commands run without a shell and validate their input", async () => {
  const seen = [];
  const result = await runMediaTool({
    command: "E:\\FFmpeg\\bin\\ffmpeg.exe",
    args: ["-version"],
    runner: async (command, args, options) => {
      seen.push({ command, args, options });
      return { stdout: "ok", stderr: "" };
    },
  });
  assert.equal(result.stdout, "ok");
  assert.equal(seen[0].command, "E:\\FFmpeg\\bin\\ffmpeg.exe");
  assert.deepEqual(seen[0].args, ["-version"]);
  assert.equal(seen[0].options.windowsHide, true);
  assert.equal(seen[0].options.env.HOME, undefined);

  await assert.rejects(runMediaTool({ command: "" }), /缺少媒体命令/u);
  await assert.rejects(runMediaTool({ command: "ffmpeg", args: [1] }), /字符串数组/u);
  await assert.rejects(runMediaTool({ command: "ffmpeg", timeoutMs: 10 }), /超时无效/u);
});
