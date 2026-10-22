import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMusicXmlHandler } from "../src/automation-musicxml.mjs";
import { buildMusicXml } from "../src/musicxml.mjs";
import { writeMidi } from "../src/midi.mjs";

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
