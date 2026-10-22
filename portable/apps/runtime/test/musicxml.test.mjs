import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMusicXmlHandler } from "../src/automation-musicxml.mjs";
import { buildMusicXml, parseMusicXml } from "../src/musicxml.mjs";
import { parseMidi, writeMidi } from "../src/midi.mjs";

const META = {
  ticksPerBeat: 480,
  timeSignature: { numerator: 4, denominator: 4 },
  tempoBpm: 120,
};

const NOTES = [
  { tickStart: 0, tickEnd: 960, pitch: 60, lyric: "只" },
  { tickStart: 960, tickEnd: 2_880, pitch: 62, lyric: "剩" },
  { tickStart: 2_880, tickEnd: 3_360, pitch: 64, lyric: "下" },
];

test("MusicXML splits bar-crossing notes into tied segments and fills rests", () => {
  const { xml, report } = buildMusicXml({
    notes: NOTES,
    meta: META,
    title: "A & B",
    fifths: 3,
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
  assert.match(xml, /<work-title>A &amp; B<\/work-title>/u);
  assert.equal((xml.match(/<measure number=/gu) ?? []).length, 2);
  assert.match(xml, /<divisions>480<\/divisions>/u);
  assert.match(xml, /<fifths>3<\/fifths>/u);
  assert.match(xml, /<beats>4<\/beats><beat-type>4<\/beat-type>/u);
  assert.match(xml, /<per-minute>120<\/per-minute>/u);
  assert.match(xml, /<tie type="start"\/>/u);
  assert.match(xml, /<tied type="start"\/>/u);
  assert.match(xml, /<tie type="stop"\/>/u);
  const [firstMeasure, secondMeasure] = xml.split("<measure number=\"2\">");
  assert.match(firstMeasure, /<tie type="start"\/>/u);
  assert.match(secondMeasure, /<tie type="stop"\/>/u);
  assert.equal(firstMeasure.includes('<tie type="stop"/>'), false);
  assert.match(xml, /<text>只<\/text>/u);
  assert.match(xml, /<text>剩<\/text>/u);
  // Measure one opens with a half-note rest before the first syllable.
  assert.match(xml, /<measure number="1"><attributes>[\s\S]*?<rest\/><duration>480<\/duration>/u);
  assert.equal(report.notes, 3);
  assert.equal(report.measures, 2);
  assert.equal(report.tied_segments, 2);
  assert.equal(report.fifths, 3);
  assert.equal(report.time_signature, "4/4");
  assert.equal(report.tempo_bpm, 120);
});

test("MusicXML falls back to a clean default title and rejects invalid input", () => {
  const { xml } = buildMusicXml({ notes: NOTES, meta: META });
  assert.match(xml, /<work-title>旋律<\/work-title>/u);
  assert.throws(() => buildMusicXml({ notes: [], meta: META }), /音符/u);
  assert.throws(() => buildMusicXml({ notes: NOTES, meta: META, fifths: 8 }), /调号/u);
  assert.throws(
    () => buildMusicXml({ notes: NOTES, meta: { ...META, timeSignature: { numerator: 4, denominator: 3 } } }),
    /拍号/u,
  );
  assert.throws(
    () => buildMusicXml({ notes: NOTES, meta: { ...META, ticksPerBeat: 480.5 } }),
    /时基/u,
  );
});

test("MusicXML import round-trips the exported melody and merges ties", () => {
  const { xml } = buildMusicXml({ notes: NOTES, meta: META, title: "A & B", fifths: 3 });
  const parsed = parseMusicXml(xml);
  assert.equal(parsed.notes.length, 3);
  assert.deepEqual(parsed.notes.map((note) => [note.tickStart, note.tickEnd, note.pitch, note.lyric]), [
    [0, 960, 60, "只"],
    [960, 2_880, 62, "剩"],
    [2_880, 3_360, 64, "下"],
  ]);
  assert.equal(parsed.report.ties_merged, 1);
  assert.equal(parsed.meta.ticksPerBeat, 480);
  assert.equal(parsed.meta.tempoBpm, 120);
  assert.deepEqual(parsed.meta.timeSignature, { numerator: 4, denominator: 4 });
  assert.equal(parsed.report.title, "A & B");
  assert.equal(parsed.report.measures, 2);
});

test("MusicXML import refuses structures that would be flattened silently", () => {
  const { xml } = buildMusicXml({ notes: NOTES, meta: META });
  const secondPart = xml.replace("</part>", "</part><part id=\"P2\">" + xml.match(/<measure[\s\S]*<\/measure>/u)[0] + "</part>");
  assert.throws(() => parseMusicXml(secondPart), /多声部/u);

  const chord = xml.replace("<note>", "<note><chord/>");
  assert.throws(() => parseMusicXml(chord), /和弦/u);

  const grace = xml.replace("<note>", "<note><grace/>");
  assert.throws(() => parseMusicXml(grace), /装饰音/u);

  const voice = xml.replace("<voice>1</voice>", "<voice>2</voice>");
  assert.throws(() => parseMusicXml(voice), /多声部/u);

  assert.throws(() => parseMusicXml("<score-partwise><part id=\"P1\"></part></score-partwise>"), /小节/u);
  assert.throws(() => parseMusicXml("<score-partwise><part-list/></score-partwise>"), /声部/u);
  assert.throws(() => parseMusicXml(""), /不能为空/u);
});

test("the handler converts MusicXML back to a MIDI with merged ties", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-musicxml-in-"));
  const sourceDir = path.join(root, "source");
  const artifacts = path.join(root, "artifacts");
  await mkdir(sourceDir, { recursive: true });
  const { xml } = buildMusicXml({ notes: NOTES, meta: META, title: "导入测试" });
  await writeFile(path.join(sourceDir, "score.musicxml"), xml, "utf8");
  await writeFile(path.join(sourceDir, "score.txt"), xml, "utf8");
  try {
    const handler = createMusicXmlHandler({
      sourceStore: { list: async () => ({ roots: [sourceDir] }) },
      artifactsDir: artifacts,
    });
    const result = await handler["musicxml.to-midi"]({
      run: { id: "run_import" },
      params: { source: path.join(sourceDir, "score.musicxml") },
    });
    assert.deepEqual(result.artifacts.map((entry) => entry.slot), ["midi", "report"]);
    const midi = parseMidi(await readFile(result.artifacts[0].path));
    assert.deepEqual(midi.notes.map((note) => note.pitch), [60, 62, 64]);
    assert.deepEqual(midi.notes.map((note) => note.lyric), ["只", "剩", "下"]);
    assert.equal(Math.round(midi.notes[1].t1 * 1000) / 1000, 3);
    const report = JSON.parse(await readFile(result.artifacts[1].path, "utf8"));
    assert.equal(report.notes, 3);
    assert.equal(report.ties_merged, 1);
    assert.equal(report.title, "导入测试");

    await assert.rejects(
      handler["musicxml.to-midi"]({
        run: { id: "run_bad" },
        params: { source: path.join(sourceDir, "score.txt") },
      }),
      /\.musicxml/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("the handler writes a MusicXML score and a report inside the artifacts directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-musicxml-"));
  const sourceDir = path.join(root, "source");
  const artifacts = path.join(root, "artifacts");
  await mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "vocal.mid");
  await writeFile(source, writeMidi({
    notes: [
      { t0: 0, t1: 0.5, pitch: 60, lyric: "只" },
      { t0: 0.5, t1: 1.5, pitch: 62, lyric: "剩" },
    ],
    meta: { ticksPerBeat: 480, tempoUs: 500_000, timeSignature: { numerator: 4, denominator: 4 } },
  }));
  await writeFile(path.join(sourceDir, "notes.txt"), "not a midi", "utf8");
  try {
    const handler = createMusicXmlHandler({
      sourceStore: { list: async () => ({ roots: [sourceDir] }) },
      artifactsDir: artifacts,
    });
    const result = await handler["midi.to-musicxml"]({
      run: { id: "run_xml" },
      params: { source, title: "测试旋律", fifths: -2 },
    });
    assert.deepEqual(result.artifacts.map((entry) => entry.slot), ["musicxml", "report"]);
    const xml = await readFile(result.artifacts[0].path, "utf8");
    assert.match(xml, /<work-title>测试旋律<\/work-title>/u);
    assert.match(xml, /<fifths>-2<\/fifths>/u);
    assert.match(xml, /<text>只<\/text>/u);
    const report = JSON.parse(await readFile(result.artifacts[1].path, "utf8"));
    assert.equal(report.notes, 2);
    assert.equal(report.title, "测试旋律");
    assert.equal(report.out.endsWith("melody.musicxml"), true);

    await assert.rejects(
      handler["midi.to-musicxml"]({
        run: { id: "run_bad" },
        params: { source: path.join(sourceDir, "notes.txt"), title: "", fifths: 0 },
      }),
      /\.mid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
