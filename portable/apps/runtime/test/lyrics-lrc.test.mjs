import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLyricsTimelineHandler } from "../src/automation-lyrics.mjs";
import { formatLrc, lrcToCues, parseLrc } from "../src/lyrics-lrc.mjs";

const SAMPLE = [
  "[ti:回家]",
  "[ar:测试歌手]",
  "[offset:+100]",
  "[00:01.50]第一句",
  "[00:03.00][00:05.00]副歌",
  "[00:01.50]第一句",
  "这一行没有时间码",
].join("\n");

test("LRC parsing keeps metadata, applies offset and expands repeated stamps", () => {
  const parsed = parseLrc(SAMPLE);
  assert.equal(parsed.meta.ti, "回家");
  assert.equal(parsed.meta.ar, "测试歌手");
  assert.equal(parsed.meta.offset, 100);
  assert.equal(parsed.untimed, 1);
  assert.deepEqual(parsed.lines, [
    { timeMs: 1_400, text: "第一句" },
    { timeMs: 2_900, text: "副歌" },
    { timeMs: 4_900, text: "副歌" },
  ]);
});

test("normalised LRC drops the offset and round-trips", () => {
  const parsed = parseLrc(SAMPLE);
  const text = formatLrc({ meta: { ...parsed.meta, offset: 0 }, lines: parsed.lines });
  assert.match(text, /^\[ti:回家\]/u);
  assert.match(text, /\[00:01\.40\]第一句/u);
  assert.equal(text.includes("[offset:"), false);
  assert.deepEqual(parseLrc(text).lines, parsed.lines);
});

test("unsupported offsets and empty input fail loudly", () => {
  assert.throws(() => parseLrc("[offset:abc]\n[00:01.00]字"), /offset/u);
  assert.throws(() => parseLrc(null), /文本/u);
  assert.throws(() => formatLrc({ lines: [] }), /不能为空/u);
  assert.throws(() => lrcToCues([]), /不能为空/u);
});

test("SRT cues stop before the next line but keep a minimum duration", () => {
  const cues = lrcToCues([
    { timeMs: 0, text: "一" },
    { timeMs: 500, text: "二" },
    { timeMs: 3_000, text: "三" },
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 499, text: "一" },
    { start: 500, end: 2_800, text: "二" },
    { start: 3_000, end: 5_000, text: "三" },
  ]);

  const longGap = lrcToCues([
    { timeMs: 0, text: "长" },
    { timeMs: 20_000, text: "间奏" },
  ]);
  assert.equal(longGap[0].end, 8_000);
});

test("the handler writes LRC, SRT and a report inside the artifacts directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-lyrics-"));
  const sourceDir = path.join(root, "source");
  const artifacts = path.join(root, "artifacts");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "song.lrc"), SAMPLE, "utf8");
  try {
    const handler = createLyricsTimelineHandler({
      sourceStore: { list: async () => ({ roots: [sourceDir] }) },
      artifactsDir: artifacts,
    });
    const result = await handler["lyrics.timeline"]({
      run: { id: "run_lyrics" },
      params: { source: path.join(sourceDir, "song.lrc"), shiftMs: 500 },
    });
    assert.deepEqual(result.artifacts.map((entry) => entry.slot), ["lrc", "srt", "report"]);
    const lrc = await readFile(result.artifacts[0].path, "utf8");
    assert.match(lrc, /\[00:01\.90\]第一句/u);
    const srt = await readFile(result.artifacts[1].path, "utf8");
    assert.match(srt, /^1\n00:00:01,900 --> 00:00:03,200\n第一句/u);
    const report = JSON.parse(await readFile(result.artifacts[2].path, "utf8"));
    assert.equal(report.lines, 3);
    assert.equal(report.untimed_lines, 1);
    assert.equal(report.shift_ms, 500);
    assert.equal(report.first_ms, 1_900);
    assert.equal(report.last_ms, 5_400);
    assert.equal(report.source_offset_ms, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the handler refuses non-LRC files and lyrics without timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-lyrics-"));
  const sourceDir = path.join(root, "source");
  const artifacts = path.join(root, "artifacts");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "song.txt"), SAMPLE, "utf8");
  await writeFile(path.join(sourceDir, "plain.lrc"), "只有歌词没有时间\n第二行", "utf8");
  try {
    const handler = createLyricsTimelineHandler({
      sourceStore: { list: async () => ({ roots: [sourceDir] }) },
      artifactsDir: artifacts,
    });
    await assert.rejects(
      handler["lyrics.timeline"]({
        run: { id: "run_txt" },
        params: { source: path.join(sourceDir, "song.txt"), shiftMs: 0 },
      }),
      /\.lrc/u,
    );
    await assert.rejects(
      handler["lyrics.timeline"]({
        run: { id: "run_plain" },
        params: { source: path.join(sourceDir, "plain.lrc"), shiftMs: 0 },
      }),
      /时间码/u,
    );
    await assert.rejects(
      handler["lyrics.timeline"]({
        run: { id: "run_outside" },
        params: { source: path.join(root, "outside.lrc"), shiftMs: 0 },
      }),
      /白名单|不存在/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
