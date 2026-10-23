import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCues,
  createAsrBatchHandler,
  createAsrHandler,
  createAsrProbe,
  parseSidecarOutput,
  splitCueText,
} from "../src/asr.mjs";

const FFMPEG = "E:\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "E:\\ffmpeg\\bin\\ffprobe.exe";

function toolsAvailable() {
  return {
    ffmpeg: { available: true, path: FFMPEG, version: "ffmpeg version 7", reason: "" },
    ffprobe: { available: true, path: FFPROBE, version: "ffprobe version 7", reason: "" },
  };
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-asr-"));
  const media = path.join(root, "media");
  const artifacts = path.join(root, "artifacts");
  const model = path.join(root, "model");
  await mkdir(media, { recursive: true });
  await mkdir(model, { recursive: true });
  await writeFile(path.join(media, "voice.mp4"), Buffer.alloc(128, 1));
  try {
    await callback({ root, media, artifacts, model });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runLike(id = "run_asr") {
  return { id, steps: {} };
}

const SIDECAR_OK = {
  ok: true,
  engine: "local:faster-whisper-small",
  language: "zh",
  language_probability: 0.98,
  duration: 4.2,
  elapsed: 1.7,
  segments: [
    { start: 0, end: 1.5, text: "第一句话。", words: [{ start: 0, end: 0.5, word: "第一" }] },
    { start: 1.7, end: 4.0, text: "第二句话", words: [] },
  ],
};

function mediaRunner({ calls = [], duration = "4.2", withAudio = true, failEncode = false } = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("-print_format")) {
      return {
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4", duration },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
            ...(withAudio ? [{ codec_type: "audio", codec_name: "aac" }] : []),
          ],
        }),
        stderr: "",
      };
    }
    if (failEncode) throw new Error("wav failed");
    await writeFile(args[args.length - 1], Buffer.alloc(4096, 1));
    return { stdout: "", stderr: "" };
  };
}

function pythonRunner({ calls = [], payload = SIDECAR_OK, stderr = "", code = 0 } = {}) {
  return async (options) => {
    calls.push(options);
    return { stdout: `${JSON.stringify(payload)}\n`, stderr, code };
  };
}

function asrHandler({ media, artifacts, model, mediaRun, pythonRun, env = {} }) {
  return createAsrHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
    mediaProbe: async () => toolsAvailable(),
    runner: mediaRun,
    pythonRunner: pythonRun,
    pythonPath: "E:\\AllRoundAI\\venv\\Scripts\\python.exe",
    modelPath: model,
    env,
  });
}

test("cue text splits at punctuation before the character cap", () => {
  assert.deepEqual(splitCueText("短句"), ["短句"]);
  const parts = splitCueText("第一句比较长的话。第二句也不短，第三句继续。", 10);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((part) => Array.from(part).length <= 10));
  assert.match(parts[0], /。$/u);
  const hard = splitCueText("一二三四五六七八九十", 4);
  assert.deepEqual(hard, ["一二三四", "五六七八", "九十"]);
  assert.deepEqual(splitCueText("   "), []);
});

test("segments become cues with proportional splits and a guaranteed gap", () => {
  const cues = buildCues([
    { start: 0, end: 2, text: "第一句" },
    { start: 1.9, end: 4, text: "第二句" },
    { start: 5, end: 5, text: "空" },
    { start: 6, end: 7.2, text: "abcdefghij" },
  ], { maxChars: 5, minGapMs: 100 });

  assert.equal(cues[0].text, "第一句");
  assert.equal(cues[0].start, 0);
  // The second cue is pushed after the first ends plus the gap.
  assert.equal(cues[1].start, 2100);
  assert.equal(cues[1].end, 4000);
  // The empty-duration segment is dropped.
  assert.equal(cues.some((cue) => cue.text === "空"), false);
  // A 10-character segment with a cap of 5 becomes two cues.
  const long = cues.filter((cue) => cue.text.includes("a") || cue.text.includes("f"));
  assert.equal(long.length, 2);
  assert.ok(cues.every((cue) => cue.end > cue.start));
  assert.throws(() => buildCues(null), /缺少分段/u);
});

test("word timestamps become cue boundaries when they cover the segment", () => {
  const cues = buildCues([{
    start: 0,
    end: 4,
    text: "第一句话。第二句",
    words: [
      { start: 0, end: 0.8, word: "第一" },
      { start: 0.8, end: 1.8, word: "句话。" },
      { start: 2.4, end: 3.2, word: "第二" },
      { start: 3.2, end: 4, word: "句" },
    ],
  }], { maxChars: 6, minGapMs: 120 });

  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [
    [0, 1800, "第一句话。"],
    [2400, 4000, "第二句"],
  ]);
});

test("Latin words keep their spacing and still respect the character cap", () => {
  const cues = buildCues([{
    start: 0,
    end: 2,
    text: "hello world",
    words: [
      { start: 0, end: 0.6, word: "hello" },
      { start: 0.6, end: 1.4, word: "world" },
    ],
  }], { maxChars: 5 });

  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [
    [0, 600, "hello"],
    [720, 1400, "world"],
  ]);
});

test("partial word timings fall back to proportional splitting", () => {
  const cues = buildCues([{
    start: 0,
    end: 3,
    text: "第一句话",
    words: [{ start: 0, end: 1, word: "第一" }],
  }]);

  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [[0, 3000, "第一句话"]]);
});

test("word timings outside the segment are clamped and unusable words ignored", () => {
  const cues = buildCues([{
    start: 1,
    end: 2,
    text: "一二",
    words: [
      { start: 0.5, end: 1.2, word: "一" },
      { start: 1.2, end: 1.2, word: "坏" },
      { start: 1.2, end: 2.4, word: "二" },
    ],
  }]);

  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.text]), [[1000, 2000, "一二"]]);
});

test("the sidecar response is validated before anything is written", () => {
  assert.equal(parseSidecarOutput(`${JSON.stringify(SIDECAR_OK)}\n`).language, "zh");
  assert.equal(parseSidecarOutput(`log line\n${JSON.stringify(SIDECAR_OK)}`).segments.length, 2);
  assert.throws(() => parseSidecarOutput(""), /没有返回结果/u);
  assert.throws(() => parseSidecarOutput("not json"), /无法解析/u);
  assert.throws(() => parseSidecarOutput('{"ok":false,"error":"boom"}'), /语音识别失败：boom/u);
  assert.throws(() => parseSidecarOutput('{"ok":true}'), /缺少分段/u);
});

test("transcription extracts 16 kHz audio, writes SRT plus a transcript and removes the WAV", async () => {
  await fixture(async ({ media, artifacts, model }) => {
    const mediaCalls = [];
    const pythonCalls = [];
    const outcome = await asrHandler({
      media,
      artifacts,
      model,
      mediaRun: mediaRunner({ calls: mediaCalls, duration: "4.2" }),
      pythonRun: pythonRunner({ calls: pythonCalls }),
    })["media.transcribe"]({
      run: runLike(),
      params: { source: path.join(media, "voice.mp4") },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["subtitles", "transcript"]);
    assert.equal(outcome.artifacts[0].label, "字幕（SRT）");
    assert.match(outcome.logs[0], /源文件：voice\.mp4，时长 0:04/u);
    assert.match(outcome.logs[1], /语言 zh，2 条字幕/u);

    const encode = mediaCalls.find((call) => !call.args.includes("-print_format"));
    assert.deepEqual(encode.args.slice(encode.args.indexOf("-vn"), encode.args.indexOf("-vn") + 7), [
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    ]);

    assert.equal(pythonCalls.length, 1);
    const request = JSON.parse(pythonCalls[0].input);
    assert.equal(request.language, "auto");
    assert.equal(request.model, model);
    // Under 15 seconds the VAD guard disables filtering.
    assert.equal(request.vad, false);
    assert.match(pythonCalls[0].args[0], /asr_worker\.py$/u);

    const srt = await readFile(outcome.artifacts[0].path, "utf8");
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\n第一句话。\n/u);
    assert.match(srt, /2\n00:00:01,700 --> 00:00:04,000\n第二句话/u);

    const transcript = JSON.parse(await readFile(outcome.artifacts[1].path, "utf8"));
    assert.equal(transcript.engine, "local:faster-whisper-small");
    assert.equal(transcript.words, 1);
    assert.equal(transcript.cues.length, 2);

    // The intermediate WAV is not kept next to the products.
    await assert.rejects(stat(path.join(artifacts, "run_asr", "audio.wav")), /ENOENT/u);
  });
});

test("long audio keeps VAD enabled and the language hint reaches the sidecar", async () => {
  await fixture(async ({ media, artifacts, model }) => {
    const pythonCalls = [];
    await asrHandler({
      media,
      artifacts,
      model,
      mediaRun: mediaRunner({ duration: "42" }),
      pythonRun: pythonRunner({ calls: pythonCalls }),
    })["media.transcribe"]({
      run: runLike(),
      params: { source: path.join(media, "voice.mp4"), language: "zh" },
    });
    const request = JSON.parse(pythonCalls[0].input);
    assert.equal(request.language, "zh");
    assert.equal(request.vad, true);
  });
});

test("transcription refuses unusable input and cleans up after a failed sidecar", async () => {
  await fixture(async ({ media, artifacts, model }) => {
    await assert.rejects(
      asrHandler({
        media,
        artifacts,
        model,
        mediaRun: mediaRunner(),
        pythonRun: pythonRunner(),
      })["media.transcribe"]({
        run: runLike(),
        params: { source: path.join(media, "voice.mp4"), language: "fr" },
      }),
      /识别语言无效/u,
    );

    const silent = asrHandler({
      media,
      artifacts,
      model,
      mediaRun: mediaRunner({ withAudio: false }),
      pythonRun: pythonRunner(),
    });
    await assert.rejects(
      silent["media.transcribe"]({ run: runLike(), params: { source: path.join(media, "voice.mp4") } }),
      /没有音频轨/u,
    );

    await assert.rejects(
      asrHandler({
        media,
        artifacts,
        model,
        mediaRun: mediaRunner({ failEncode: true }),
        pythonRun: pythonRunner(),
      })["media.transcribe"]({
        run: runLike(),
        params: { source: path.join(media, "voice.mp4") },
      }),
      /提取音频失败/u,
    );

    await assert.rejects(
      asrHandler({
        media,
        artifacts,
        model,
        mediaRun: mediaRunner(),
        pythonRun: pythonRunner({ payload: { ok: false, error: "model missing" } }),
      })["media.transcribe"]({
        run: runLike(),
        params: { source: path.join(media, "voice.mp4") },
      }),
      /语音识别失败：model missing/u,
    );
    for (const file of ["audio.wav", "captions.srt", "transcript.json"]) {
      await assert.rejects(
        stat(path.join(artifacts, "run_asr", file)),
        /ENOENT/u,
        `${file} should be removed`,
      );
    }

    await assert.rejects(
      asrHandler({
        media,
        artifacts,
        model,
        mediaRun: mediaRunner(),
        pythonRun: pythonRunner({ payload: { ...SIDECAR_OK, segments: [] } }),
      })["media.transcribe"]({
        run: runLike(),
        params: { source: path.join(media, "voice.mp4") },
      }),
      /没有识别出可用的字幕/u,
    );
  });
});

test("the ASR probe reports a missing interpreter or model without throwing", async () => {
  await fixture(async ({ model }) => {
    const ok = createAsrProbe({
      pythonPath: "python",
      modelPath: model,
      runner: async () => ({ stdout: "", stderr: "", code: 0 }),
      env: {},
    });
    const available = await ok({ refresh: true });
    assert.equal(available.available, true);
    assert.equal(available.model, model);

    const noPython = createAsrProbe({
      pythonPath: "missing-python",
      modelPath: model,
      runner: async () => {
        throw new Error("找不到 Python");
      },
      env: {},
    });
    const missing = await noPython({ refresh: true });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /找不到 Python/u);

    const noModel = createAsrProbe({
      pythonPath: "python",
      modelPath: path.join(model, "absent"),
      runner: async () => ({ stdout: "", stderr: "", code: 0 }),
      env: {},
    });
    const absent = await noModel({ refresh: true });
    assert.equal(absent.available, false);
    assert.match(absent.reason, /模型目录不可用/u);
  });
});

test("the ASR handler refuses to be built without its dependencies", () => {
  assert.throws(
    () => createAsrHandler({
      sourceStore: null,
      artifactsDir: os.tmpdir(),
      mediaProbe: async () => toolsAvailable(),
    }),
    /来源配置/u,
  );
  assert.throws(
    () => createAsrHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
  assert.throws(
    () => createAsrHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: os.tmpdir(),
    }),
    /媒体工具探测/u,
  );
});

// --- batch transcription -------------------------------------------------

async function batchFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-asr-batch-"));
  const media = path.join(root, "media");
  const artifacts = path.join(root, "artifacts");
  const model = path.join(root, "model");
  await mkdir(media, { recursive: true });
  await mkdir(model, { recursive: true });
  try {
    await callback({ root, media, artifacts, model });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function batchMediaRunner({ calls = [] } = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("-print_format")) {
      const name = path.basename(args[args.length - 1]);
      if (name === "broken.mp4") throw new Error("probe exploded");
      const duration = name === "a.mp4" ? "20" : "8";
      return {
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4", duration },
          streams: [
            ...(name === "c.mp3" ? [] : [{ codec_type: "video", codec_name: "h264" }]),
            ...(name === "b.mp4" ? [] : [{ codec_type: "audio", codec_name: "aac" }]),
          ],
        }),
        stderr: "",
      };
    }
    await writeFile(args[args.length - 1], Buffer.alloc(1024, 1));
    return { stdout: "", stderr: "" };
  };
}

function batchPythonRunner({ calls = [] } = {}) {
  return async (options) => {
    calls.push(options);
    // The second audio file fails, proving one bad file does not abort the run.
    if (calls.length === 2) {
      return { stdout: '{"ok":false,"error":"decode error"}\n', stderr: "", code: 0 };
    }
    return {
      stdout: `${JSON.stringify({ ...SIDECAR_OK, duration: 8 })}\n`,
      stderr: "",
      code: 0,
    };
  };
}

function batchHandler({ media, artifacts, model, mediaRun, pythonRun }) {
  return createAsrBatchHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
    mediaProbe: async () => toolsAvailable(),
    runner: mediaRun,
    pythonRunner: pythonRun,
    pythonPath: "python",
    modelPath: model,
    env: {},
  });
}

test("batch transcription keeps going when a file is skipped or fails", async () => {
  await batchFixture(async ({ media, artifacts, model }) => {
    for (const name of ["a.mp4", "b.mp4", "broken.mp4", "c.mp3"]) {
      await writeFile(path.join(media, name), Buffer.alloc(64, 1));
    }
    const outcome = await batchHandler({
      media,
      artifacts,
      model,
      mediaRun: batchMediaRunner(),
      pythonRun: batchPythonRunner(),
    })["media.transcribe-batch"]({
      run: runLike("run_batch"),
      params: { root: media, language: "zh", maxFiles: 5 },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot),
      ["subtitles-1", "report-json", "report-markdown"]);
    assert.equal(outcome.artifacts[0].label, "字幕：a.mp4");
    assert.match(outcome.logs[1], /成功 1、跳过 1、失败 2/u);

    const report = JSON.parse(await readFile(outcome.artifacts[1].path, "utf8"));
    assert.deepEqual(report.counts, { ok: 1, skipped: 1, failed: 2 });
    const byName = new Map(report.files.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("a.mp4").status, "ok");
    assert.equal(byName.get("b.mp4").status, "skipped");
    assert.match(byName.get("b.mp4").error, /没有音频轨/u);
    assert.equal(byName.get("broken.mp4").status, "failed");
    assert.match(byName.get("broken.mp4").error, /无法读取媒体信息/u);
    assert.equal(byName.get("c.mp3").status, "failed");
    assert.match(byName.get("c.mp3").error, /decode error/u);
    assert.equal(report.totalCues, 2);

    const markdown = await readFile(outcome.artifacts[2].path, "utf8");
    assert.match(markdown, /# 批量转字幕报告/u);
    assert.match(markdown, /\| a\.mp4 \| ok \|/u);
    assert.match(markdown, /\| c\.mp3 \| failed \|/u);

    // Per-file folders only keep the SRT; the intermediate WAV is gone.
    await assert.rejects(stat(path.join(artifacts, "run_batch", "01-a", "audio.wav")), /ENOENT/u);
    assert.match(await readFile(path.join(artifacts, "run_batch", "01-a", "captions.srt"), "utf8"),
      /第一句话/u);
  });
});

test("batch transcription refuses empty folders, bad limits and all-failure runs", async () => {
  await batchFixture(async ({ media, artifacts, model }) => {
    const empty = path.join(media, "empty");
    await mkdir(empty, { recursive: true });
    const handler = batchHandler({
      media,
      artifacts,
      model,
      mediaRun: batchMediaRunner(),
      pythonRun: batchPythonRunner(),
    });
    await assert.rejects(
      handler["media.transcribe-batch"]({ run: runLike(), params: { root: empty } }),
      /没有音频或视频文件/u,
    );
    await assert.rejects(
      handler["media.transcribe-batch"]({ run: runLike(), params: { root: media, maxFiles: 20 } }),
      /文件数必须是 1 到 12/u,
    );

    await writeFile(path.join(media, "silent.mp4"), Buffer.alloc(64, 1));
    const silentOnly = batchHandler({
      media,
      artifacts,
      model,
      mediaRun: async (command, args) => {
        if (args.includes("-print_format")) {
          return {
            stdout: JSON.stringify({
              format: { duration: "4" },
              streams: [{ codec_type: "video", codec_name: "h264" }],
            }),
            stderr: "",
          };
        }
        await writeFile(args[args.length - 1], Buffer.alloc(64, 1));
        return { stdout: "", stderr: "" };
      },
      pythonRun: batchPythonRunner(),
    });
    await assert.rejects(
      silentOnly["media.transcribe-batch"]({ run: runLike("run_silent"), params: { root: media } }),
      /没有任何文件识别成功/u,
    );
  });
});

test("the batch handler refuses to be built without its dependencies", () => {
  assert.throws(
    () => createAsrBatchHandler({ sourceStore: null, artifactsDir: os.tmpdir(), mediaProbe: async () => toolsAvailable() }),
    /来源配置/u,
  );
  assert.throws(
    () => createAsrBatchHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
  assert.throws(
    () => createAsrBatchHandler({ sourceStore: { list: async () => ({ roots: [] }) }, artifactsDir: os.tmpdir() }),
    /媒体工具探测/u,
  );
});
