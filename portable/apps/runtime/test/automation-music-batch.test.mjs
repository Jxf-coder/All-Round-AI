import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMusicBatchHandler } from "../src/automation-music-batch.mjs";
import { parseMidi, writeMidi } from "../src/midi.mjs";

const META = {
  ticksPerBeat: 480,
  tempoUs: 500_000,
  timeSignature: { numerator: 4, denominator: 4 },
};

const NOTES = [
  { t0: 0, t1: 0.5, pitch: 60, lyric: "只" },
  { t0: 0.5, t1: 1.5, pitch: 62, lyric: "剩" },
  { t0: 1.5, t1: 3.2, pitch: 64, lyric: "下" },
];

function midi() {
  return writeMidi({ notes: NOTES, meta: META });
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-music-batch-"));
  const source = path.join(root, "songs");
  const artifacts = path.join(root, "artifacts");
  await mkdir(source, { recursive: true });
  try {
    await callback({ root, source, artifacts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function handlerFor(source, artifacts) {
  return createMusicBatchHandler({
    sourceStore: { list: async () => ({ roots: [source] }) },
    artifactsDir: artifacts,
  });
}

test("the music batch handler validates its dependencies", () => {
  assert.throws(() => createMusicBatchHandler({}), /来源配置/u);
  assert.throws(
    () => createMusicBatchHandler({ sourceStore: { list: async () => ({ roots: [] }) }, artifactsDir: "relative" }),
    /绝对路径/u,
  );
});

test("the breath batch skips a broken file and reports every result", async () => {
  await fixture(async ({ source, artifacts }) => {
    await writeFile(path.join(source, "a.mid"), midi());
    await writeFile(path.join(source, "b.mid"), midi());
    await writeFile(path.join(source, "broken.mid"), Buffer.from("not a midi", "utf8"));
    await writeFile(path.join(source, "notes.txt"), "ignored", "utf8");
    const handler = handlerFor(source, artifacts);

    const result = await handler["music.batch"]({
      run: { id: "run_batch" },
      params: { root: source, task: "breaths", maxFiles: 5 },
    });

    assert.deepEqual(result.artifacts.map((entry) => entry.slot),
      ["product-1", "product-2", "report-json", "report-markdown"]);
    const first = parseMidi(await readFile(result.artifacts[0].path));
    assert.deepEqual(first.notes.map((note) => note.pitch), [60, 62, 64]);
    const report = JSON.parse(await readFile(result.artifacts[2].path, "utf8"));
    assert.equal(report.task, "breaths");
    assert.deepEqual(report.counts, { ok: 2, failed: 1 });
    assert.deepEqual(report.files.map((entry) => [entry.name, entry.status]),
      [["a.mid", "ok"], ["b.mid", "ok"], ["broken.mid", "failed"]]);
    assert.match(report.files[2].error, /MIDI/u);
    // A failed file does not consume a sequence number.
    assert.equal(report.files[0].out, "01-a/a_气口.mid");
    const markdown = await readFile(result.artifacts[3].path, "utf8");
    assert.match(markdown, /\| a\.mid \| ok \|/u);
    assert.match(markdown, /\| broken\.mid \| failed \|/u);
    assert.match(result.logs[1], /成功 2、失败 1/u);
  });
});

test("the breath batch applies a manual transpose to every file", async () => {
  await fixture(async ({ source, artifacts }) => {
    await writeFile(path.join(source, "a.mid"), midi());
    const handler = handlerFor(source, artifacts);
    const result = await handler["music.batch"]({
      run: { id: "run_transpose" },
      params: { root: source, task: "breaths", maxFiles: 1, manualTranspose: true, transpose: 2 },
    });
    const parsed = parseMidi(await readFile(result.artifacts[0].path));
    assert.deepEqual(parsed.notes.map((note) => note.pitch), [62, 64, 66]);
    const report = JSON.parse(await readFile(result.artifacts[1].path, "utf8"));
    assert.equal(report.params.transpose, 2);
    assert.equal(report.files[0].transpose, 2);
  });
});

test("the export batch writes one MusicXML per MIDI", async () => {
  await fixture(async ({ source, artifacts }) => {
    await writeFile(path.join(source, "one.mid"), midi());
    await writeFile(path.join(source, "two.mid"), midi());
    const handler = handlerFor(source, artifacts);
    const result = await handler["music.batch"]({
      run: { id: "run_export" },
      params: { root: source, task: "export", maxFiles: 5, fifths: -2 },
    });
    assert.equal(result.artifacts.filter((entry) => entry.slot.startsWith("product-")).length, 2);
    const xml = await readFile(result.artifacts[0].path, "utf8");
    assert.match(xml, /<fifths>-2<\/fifths>/u);
    assert.match(xml, /<text>只<\/text>/u);
    const report = JSON.parse(await readFile(result.artifacts[2].path, "utf8"));
    assert.equal(report.counts.ok, 2);
    assert.equal(report.params.fifths, -2);
    assert.equal(report.files[0].measures, 2);
  });
});

test("the import batch turns MusicXML files back into MIDI", async () => {
  await fixture(async ({ source, artifacts }) => {
    const { buildMusicXml } = await import("../src/musicxml.mjs");
    const { xml } = buildMusicXml({
      notes: [
        { tickStart: 0, tickEnd: 960, pitch: 60, lyric: "只" },
        { tickStart: 960, tickEnd: 1_920, pitch: 62, lyric: "剩" },
      ],
      meta: { ticksPerBeat: 480, timeSignature: { numerator: 4, denominator: 4 }, tempoBpm: 120 },
      title: "批量导入",
    });
    await writeFile(path.join(source, "a.musicxml"), xml, "utf8");
    await writeFile(path.join(source, "b.xml"), xml, "utf8");
    const handler = handlerFor(source, artifacts);
    const result = await handler["music.batch"]({
      run: { id: "run_import" },
      params: { root: source, task: "import", maxFiles: 5 },
    });
    assert.equal(result.artifacts.filter((entry) => entry.slot.startsWith("product-")).length, 2);
    const parsed = parseMidi(await readFile(result.artifacts[0].path));
    assert.deepEqual(parsed.notes.map((note) => note.pitch), [60, 62]);
    assert.match(result.logs[0], /导入旋律 2 个文件/u);
  });
});

test("the batch stops at maxFiles and only scans the first level", async () => {
  await fixture(async ({ source, artifacts }) => {
    await writeFile(path.join(source, "a.mid"), midi());
    await writeFile(path.join(source, "b.mid"), midi());
    await writeFile(path.join(source, "c.mid"), midi());
    await mkdir(path.join(source, "nested"));
    await writeFile(path.join(source, "nested", "d.mid"), midi());
    const handler = handlerFor(source, artifacts);
    const result = await handler["music.batch"]({
      run: { id: "run_limit" },
      params: { root: source, task: "breaths", maxFiles: 2 },
    });
    const report = JSON.parse(await readFile(result.artifacts[2].path, "utf8"));
    assert.equal(report.truncated, true);
    assert.deepEqual(report.files.map((entry) => entry.name), ["a.mid", "b.mid"]);
  });
});

test("the batch rejects empty directories, bad limits and a total failure", async () => {
  await fixture(async ({ source, artifacts }) => {
    const handler = handlerFor(source, artifacts);
    await assert.rejects(
      handler["music.batch"]({ run: { id: "run_empty" }, params: { root: source, maxFiles: 5 } }),
      /没有可处理的音乐文件/u,
    );
    await assert.rejects(
      handler["music.batch"]({ run: { id: "run_limit" }, params: { root: source, maxFiles: 0 } }),
      /文件数必须是 1 到 20/u,
    );
    await assert.rejects(
      handler["music.batch"]({ run: { id: "run_task" }, params: { root: source, task: "sing" } }),
      /批量任务无效/u,
    );
    await writeFile(path.join(source, "broken.mid"), Buffer.from("not a midi", "utf8"));
    await assert.rejects(
      handler["music.batch"]({ run: { id: "run_fail" }, params: { root: source, task: "breaths" } }),
      /没有任何文件处理成功/u,
    );
  });
});
