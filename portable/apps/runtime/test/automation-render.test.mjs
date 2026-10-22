import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RENDER_LIMITS,
  buildCompositeFilter,
  createRenderHandler,
  parseClipEntries,
  parseClipList,
  renderCanvas,
} from "../src/automation-render.mjs";

const FFMPEG = "E:\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "E:\\ffmpeg\\bin\\ffprobe.exe";

function toolsAvailable() {
  return {
    ffmpeg: { available: true, path: FFMPEG, version: "ffmpeg version 7", reason: "" },
    ffprobe: { available: true, path: FFPROBE, version: "ffprobe version 7", reason: "" },
  };
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-render-"));
  const media = path.join(root, "media");
  const artifacts = path.join(root, "artifacts");
  await mkdir(media, { recursive: true });
  for (const [name, byte] of [
    ["a.mp4", 1], ["b.mp4", 2], ["bgm.mp3", 3], ["silent.mp4", 4], ["short.mp4", 5],
  ]) {
    await writeFile(path.join(media, name), Buffer.alloc(64, byte));
  }
  try {
    await callback({ root, media, artifacts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runLike(id = "run_render") {
  return { id, steps: {} };
}

test("the clip list ignores comments and enforces its bounds", () => {
  const clips = parseClipList(
    "# 开场\r\nC:\\media\\a.mp4\r\n\r\n  C:\\media\\b.mp4  \r\n# 结尾\r\nC:\\media\\c.mp4",
  );
  assert.deepEqual(clips, ["C:\\media\\a.mp4", "C:\\media\\b.mp4", "C:\\media\\c.mp4"]);

  assert.throws(() => parseClipList(""), /不能为空/u);
  assert.throws(() => parseClipList("C:\\media\\a.mp4"), /至少要两个片段/u);
  const many = Array.from({ length: RENDER_LIMITS.clips + 1 }, (_, index) => `C:\\media\\${index}.mp4`);
  assert.throws(() => parseClipList(many.join("\n")), /最多合成/u);
  assert.throws(() => parseClipList(`C:\\media\\a.mp4\n${"x".repeat(401)}`), /路径过长/u);
});

test("a clip line can carry an optional trim range", () => {
  const entries = parseClipEntries("C:\\a.mp4\nC:\\b.mp4 | 1.5-6\nC:\\c.mp4 | 2-");
  assert.deepEqual(entries, [
    { path: "C:\\a.mp4", start: null, end: null },
    { path: "C:\\b.mp4", start: 1.5, end: 6 },
    { path: "C:\\c.mp4", start: 2, end: null },
  ]);
  assert.throws(() => parseClipEntries("C:\\a.mp4\nC:\\b.mp4 | 6-1.5"), /裁剪范围无效/u);
  assert.throws(() => parseClipEntries("C:\\a.mp4\nC:\\b.mp4 | -"), /裁剪范围无效/u);
  assert.throws(() => parseClipEntries("C:\\a.mp4\nC:\\b.mp4 | x-y"), /裁剪范围无效/u);
});

test("the render canvas maps the three platform ratios", () => {
  assert.deepEqual(renderCanvas("landscape"), { width: 1280, height: 720 });
  assert.deepEqual(renderCanvas("vertical"), { width: 720, height: 1280 });
  assert.deepEqual(renderCanvas("square"), { width: 720, height: 720 });
  assert.throws(() => renderCanvas("wide"), /画布规格无效/u);
});

test("trims and transition names reach the filter graph", () => {
  const { filter } = buildCompositeFilter({
    clips: [
      { duration: 2, hasAudio: true, start: 1, end: 3 },
      { duration: 2, hasAudio: false, start: 0.5, end: 2.5 },
    ],
    canvas: { width: 720, height: 1280 },
    transitionSeconds: 0.6,
    transitionName: "slideleft",
  });
  assert.match(filter, /\[0:v\]trim=start=1\.000:end=3\.000,setpts=PTS-STARTPTS,scale=/u);
  assert.match(filter, /\[0:a\]atrim=start=1\.000:end=3\.000,asetpts=PTS-STARTPTS,aresample/u);
  assert.match(filter, /\[1:v\]trim=start=0\.500:end=2\.500/u);
  assert.match(filter, /xfade=transition=slideleft:duration=0\.6:offset=1\.400/u);
});

test("the composite filter pads, silences and concatenates clips", () => {
  const { filter, videoLabel, audioLabel } = buildCompositeFilter({
    clips: [
      { duration: 4, hasAudio: true },
      { duration: 3, hasAudio: false },
    ],
    canvas: { width: 1280, height: 720 },
  });
  assert.equal(videoLabel, "vcat");
  assert.equal(audioLabel, "acat");
  assert.match(filter, /\[0:v\]scale=1280:720:force_original_aspect_ratio=decrease/u);
  assert.match(filter, /pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/u);
  assert.match(filter, /\[0:a\]aresample=48000/u);
  assert.match(filter, /apad=whole_dur=4\.000,atrim=0:4\.000/u);
  assert.match(filter, /anullsrc=r=48000:cl=stereo,atrim=0:3\.000/u);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[vcat\]\[acat\]/u);
  assert.equal(filter.includes("xfade"), false);
  assert.equal(filter.includes("amix"), false);
});

test("crossfades accumulate offsets and the background music is mixed under the clips", () => {
  const clips = [
    { duration: 4, hasAudio: true },
    { duration: 3, hasAudio: true },
    { duration: 2.5, hasAudio: true },
  ];
  const { filter, videoLabel, audioLabel } = buildCompositeFilter({
    clips,
    canvas: { width: 720, height: 1280 },
    transitionSeconds: 0.6,
    hasBgm: true,
    bgmVolume: 40,
  });
  assert.equal(videoLabel, "vcat");
  assert.equal(audioLabel, "amix");
  // 4 - 0.6 and 4 + 3 - 1.2
  assert.match(filter, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.6:offset=3\.400\[vx1\]/u);
  assert.match(filter, /\[vx1\]\[v2\]xfade=transition=fade:duration=0\.6:offset=5\.800\[vcat\]/u);
  assert.match(filter, /acrossfade=d=0\.6:c1=tri:c2=tri\[ax1\]/u);
  assert.match(filter, /\[ax1\]\[a2\]acrossfade=d=0\.6/u);
  assert.match(filter, /\[3:a\]aresample=48000/u);
  assert.match(filter, /volume=0\.40\[bgm\]/u);
  assert.match(filter, /\[acat\]\[bgm\]amix=inputs=2:duration=first:normalize=0\[amix\]/u);
  assert.throws(() => buildCompositeFilter({ clips: [clips[0]], canvas: { width: 1, height: 1 } }), /至少要两个片段/u);
});

function renderProbe(map) {
  return async (command, args) => {
    const file = args[args.length - 1];
    const key = path.basename(file);
    const media = map[key];
    if (!media) throw new Error(`unexpected probe ${key}`);
    return {
      stdout: JSON.stringify({
        format: { duration: String(media.duration) },
        streams: [
          ...(media.video === false
            ? []
            : [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }]),
          ...(media.audio ? [{ codec_type: "audio", codec_name: "aac" }] : []),
        ],
      }),
      stderr: "",
    };
  };
}

function renderRunner({ calls = [], map = {}, fail = false, empty = false } = {}) {
  return async (command, args, options) => {
    if (args.includes("-print_format")) return renderProbe(map)(command, args, options);
    calls.push({ command, args, options });
    if (fail) {
      await writeFile(args[args.length - 1], Buffer.alloc(32, 1));
      throw new Error("render failed");
    }
    await writeFile(args[args.length - 1], Buffer.alloc(empty ? 0 : 8192, 4));
    return { stdout: "", stderr: "" };
  };
}

function renderHandler({ media, artifacts, runner, mediaProbe = async () => toolsAvailable() }) {
  return createRenderHandler({
    sourceStore: { list: async () => ({ roots: [media] }) },
    artifactsDir: artifacts,
    mediaProbe,
    runner,
  });
}

test("the render handler assembles clips, reports the plan and writes both artifacts", async () => {
  await fixture(async ({ media, artifacts }) => {
    const calls = [];
    const map = {
      "a.mp4": { duration: 4, audio: true },
      "b.mp4": { duration: 3, audio: false },
      "bgm.mp3": { duration: 30, audio: true, video: false },
    };
    const handler = renderHandler({ media, artifacts, runner: renderRunner({ calls, map }) });
    const outcome = await handler["media.render"]({
      run: runLike(),
      params: {
        clips: `${path.join(media, "a.mp4")}\n${path.join(media, "b.mp4")}`,
        aspect: "vertical",
        transition: "crossfade",
        bgm: path.join(media, "bgm.mp3"),
        bgmVolume: 40,
      },
    });

    assert.deepEqual(outcome.artifacts.map((entry) => entry.slot), ["video", "report"]);
    assert.equal(outcome.artifacts[0].label, "成片（MP4 / H.264）");
    assert.equal(outcome.artifacts[0].bytes, 8192);
    assert.match(outcome.logs[0], /2 个片段，合计 0:06；画布 720×1280/u);

    const encode = calls.at(-1);
    // The allow-list resolver returns the real path, which on Windows is the
    // long form even when the temporary directory was created as 8.3.
    const resolved = await realpath(media);
    assert.deepEqual(encode.args.slice(0, 7), [
      "-hide_banner", "-nostdin", "-y",
      "-i", path.join(resolved, "a.mp4"),
      "-i", path.join(resolved, "b.mp4"),
    ]);
    assert.ok(encode.args.includes("-stream_loop"));
    const filter = encode.args[encode.args.indexOf("-filter_complex") + 1];
    assert.match(filter, /offset=3\.400/u);
    assert.match(filter, /amix=inputs=2/u);
    assert.equal(encode.args[encode.args.indexOf("-map") + 1], "[vcat]");
    assert.equal(encode.args[encode.args.indexOf("-map", encode.args.indexOf("-map") + 1) + 1], "[amix]");

    const report = JSON.parse(await readFile(outcome.artifacts[1].path, "utf8"));
    assert.equal(report.clips.length, 2);
    assert.equal(report.clips[0].seconds, 4);
    assert.equal(report.clips[1].has_audio, false);
    assert.deepEqual(report.canvas, { width: 720, height: 1280, aspect: "vertical" });
    assert.equal(report.transition.seconds, 0.6);
    assert.equal(report.bgm.volume, 40);
    assert.equal(report.seconds, 6.4);
  });
});

test("the render handler applies trims, honours the transition name and reports effective durations", async () => {
  await fixture(async ({ media, artifacts }) => {
    const calls = [];
    const map = {
      "a.mp4": { duration: 4, audio: true },
      "b.mp4": { duration: 3, audio: false },
    };
    const handler = renderHandler({ media, artifacts, runner: renderRunner({ calls, map }) });
    const outcome = await handler["media.render"]({
      run: runLike("run_trim"),
      params: {
        clips: `${path.join(media, "a.mp4")} | 1-3\n${path.join(media, "b.mp4")} | 0-2`,
        aspect: "landscape",
        transition: "slide",
      },
    });

    assert.match(outcome.logs[0], /2 个片段，合计 0:03/u);
    const encode = calls.at(-1);
    const filter = encode.args[encode.args.indexOf("-filter_complex") + 1];
    assert.match(filter, /\[0:v\]trim=start=1\.000:end=3\.000/u);
    assert.match(filter, /\[1:v\]trim=start=0\.000:end=2\.000/u);
    assert.match(filter, /xfade=transition=slideleft:duration=0\.6:offset=1\.400/u);

    const report = JSON.parse(await readFile(outcome.artifacts[1].path, "utf8"));
    assert.equal(report.clips[0].seconds, 2);
    assert.deepEqual(report.clips[0].trim, { start: 1, end: 3 });
    assert.equal(report.clips[1].seconds, 2);
    assert.equal(report.transition.key, "slide");
    assert.equal(report.transition.xfade, "slideleft");
    assert.equal(report.seconds, 3.4);

    await assert.rejects(
      handler["media.render"]({
        run: runLike(),
        params: { clips: `${path.join(media, "a.mp4")} | 1-9\n${path.join(media, "b.mp4")}` },
      }),
      /裁剪结束时间超出片段时长/u,
    );
  });
});

test("the render handler refuses unusable clips, styles and music", async () => {
  await fixture(async ({ media, artifacts }) => {
    const map = {
      "a.mp4": { duration: 4, audio: true },
      "b.mp4": { duration: 3, audio: false },
      "bgm.mp3": { duration: 30, audio: true, video: false },
      "silent.mp4": { duration: 4, audio: false, video: false },
      "short.mp4": { duration: 0.5, audio: true },
    };
    const handler = renderHandler({ media, artifacts, runner: renderRunner({ map }) });
    const two = `${path.join(media, "a.mp4")}\n${path.join(media, "b.mp4")}`;

    await assert.rejects(
      handler["media.render"]({ run: runLike(), params: { clips: two, aspect: "wide" } }),
      /画布规格无效/u,
    );
    await assert.rejects(
      handler["media.render"]({ run: runLike(), params: { clips: two, transition: "spin" } }),
      /转场方式无效/u,
    );
    await assert.rejects(
      handler["media.render"]({ run: runLike(), params: { clips: two, bgmVolume: 140 } }),
      /音量必须是 0 到 100/u,
    );
    await assert.rejects(
      handler["media.render"]({
        run: runLike(),
        params: { clips: `${path.join(media, "a.mp4")}\n${path.join(media, "silent.mp4")}` },
      }),
      /片段没有视频轨/u,
    );
    await assert.rejects(
      handler["media.render"]({
        run: runLike(),
        params: {
          clips: `${path.join(media, "short.mp4")}\n${path.join(media, "b.mp4")}`,
          transition: "crossfade",
        },
      }),
      /片段太短，无法使用淡入淡出/u,
    );
    await assert.rejects(
      handler["media.render"]({
        run: runLike(),
        params: { clips: two, bgm: path.join(media, "b.mp4") },
      }),
      /背景音乐没有音频轨/u,
    );
  });
});

test("a failed or empty render leaves no broken video behind", async () => {
  await fixture(async ({ media, artifacts }) => {
    const map = {
      "a.mp4": { duration: 4, audio: true },
      "b.mp4": { duration: 3, audio: false },
    };
    const params = {
      clips: `${path.join(media, "a.mp4")}\n${path.join(media, "b.mp4")}`,
    };
    await assert.rejects(
      renderHandler({ media, artifacts, runner: renderRunner({ map, fail: true }) })["media.render"]({
        run: runLike(),
        params,
      }),
      /影音成片失败：render failed/u,
    );
    await assert.rejects(readFile(path.join(artifacts, "run_render", "final.mp4")), /ENOENT/u);

    await assert.rejects(
      renderHandler({ media, artifacts, runner: renderRunner({ map, empty: true }) })["media.render"]({
        run: runLike("run_empty"),
        params,
      }),
      /输出文件为空/u,
    );
    await assert.rejects(readFile(path.join(artifacts, "run_empty", "final.mp4")), /ENOENT/u);
  });
});

test("the render handler refuses to be built without its dependencies", () => {
  assert.throws(
    () => createRenderHandler({
      sourceStore: null,
      artifactsDir: os.tmpdir(),
      mediaProbe: async () => toolsAvailable(),
    }),
    /来源配置/u,
  );
  assert.throws(
    () => createRenderHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: "relative",
      mediaProbe: async () => toolsAvailable(),
    }),
    /产物目录必须是绝对路径/u,
  );
  assert.throws(
    () => createRenderHandler({
      sourceStore: { list: async () => ({ roots: [] }) },
      artifactsDir: os.tmpdir(),
    }),
    /媒体工具探测/u,
  );
});
