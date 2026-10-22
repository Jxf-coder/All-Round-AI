import assert from "node:assert/strict";
import test from "node:test";

import { parseMidi, writeMidi } from "../src/midi.mjs";
import {
  BREATH_RULES,
  VOCAL_PROFILES,
  fitVocalOctave,
  markBreaths,
  parseKeyToPc,
  parseLyricLines,
} from "../src/midi-breath.mjs";

const META = {
  ticksPerBeat: 480,
  tempoUs: 500000,
  timeSignature: { numerator: 4, denominator: 4 },
};

function build(notes) {
  return writeMidi({ notes, meta: META, trackName: "VOCAL" });
}

function syllables(count, duration = 0.5, lyrics) {
  return Array.from({ length: count }, (_, index) => ({
    t0: index * duration,
    t1: (index + 1) * duration,
    pitch: 60 + (index % 7),
    lyric: lyrics?.[index] ?? "字",
  }));
}

function round(value, digits = 3) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

test("lyric lines keep only CJK, drop duplicates and cap the list", () => {
  assert.deepEqual(
    parseLyricLines("只剩下钢琴\n\n只剩下钢琴\nhello 世界!\n一"),
    ["只剩下钢琴", "世界"],
  );
  const many = Array.from(
    { length: 600 },
    (_, index) => `${String.fromCharCode(0x4e00 + index)}${String.fromCharCode(0x4e00 + index + 1000)}`,
  ).join("\n");
  assert.equal(parseLyricLines(many).length, 500);
  assert.deepEqual(parseLyricLines(""), []);
  assert.deepEqual(parseLyricLines(null), []);
});

test("the long-note rule carves a breath after three seconds of continuous singing", () => {
  const notes = [
    ...syllables(6, 0.5, ["一", "二", "三", "四", "五", "六"]),
    { t0: 3, t1: 4, pitch: 67, lyric: "长" },
    { t0: 4, t1: 4.5, pitch: 65, lyric: "尾" },
  ];
  const { buffer, report } = markBreaths({ buffer: build(notes) });
  assert.equal(report.long_note_cuts, 1);
  assert.equal(report.transpose, 0);
  const parsed = parseMidi(buffer);
  assert.equal(round(parsed.notes[6].t1), 3.6);
  assert.equal(round(parsed.notes[7].t0), 4);
  assert.ok(report.after.n_gap > report.before.n_gap);
});

test("line ends cut breaths but a short syllable keeps at least 60% of its length", () => {
  const notes = syllables(8, 0.5, ["只", "剩", "下", "钢", "琴", "陪", "我", "唱"]);
  const { buffer, report } = markBreaths({
    buffer: build(notes),
    lyrics: ["只剩", "下钢", "琴陪", "我唱"],
  });
  assert.equal(report.lyric_lines_total, 4);
  assert.ok(report.lyric_line_ends_matched >= 3);
  assert.ok(report.lyric_line_cuts >= 2);

  const parsed = parseMidi(buffer);
  // 0.5s syllable: keep 0.3s, breath shrinks to 0.2s instead of the full 0.42s.
  const kept = parsed.notes[1].t1 - parsed.notes[1].t0;
  const breath = parsed.notes[2].t0 - parsed.notes[1].t1;
  assert.equal(round(kept), 0.3);
  assert.equal(round(breath), 0.2);
  assert.ok(kept >= 0.5 * BREATH_RULES.keepNoteRatioMin - 1e-6);
  assert.ok(report.short_gaps_protecting_note >= 1);
});

test("lyric sheets that do not belong to the MIDI are ignored instead of cutting at random", () => {
  const notes = syllables(8, 0.5);
  const { report } = markBreaths({ buffer: build(notes), lyrics: ["完全不同"] });
  assert.equal(report.lyric_line_ends_matched, 0);
  assert.equal(report.lyric_line_cuts, 0);
});

test("notes inside a melisma are never separated", () => {
  const notes = syllables(8, 0.5, ["只", "-", "-", "剩", "下", "钢", "琴", "唱"]);
  const { buffer } = markBreaths({ buffer: build(notes), lyrics: ["只剩", "下钢", "琴唱"] });
  const parsed = parseMidi(buffer);
  assert.equal(round(parsed.notes[0].t1), round(parsed.notes[1].t0));
  assert.equal(round(parsed.notes[1].t1), round(parsed.notes[2].t0));
  assert.equal(round(parsed.notes[2].t1), round(parsed.notes[3].t0));
});

test("transpose shifts every pitch and clamps to the MIDI range", () => {
  const notes = syllables(4, 0.5);
  const up = markBreaths({ buffer: build(notes), transpose: 2 });
  assert.deepEqual(parseMidi(up.buffer).notes.map((note) => note.pitch), [62, 63, 64, 65]);
  assert.equal(up.report.transpose, 2);

  const low = markBreaths({
    buffer: build([{ t0: 0, t1: 0.5, pitch: 2, lyric: "低" }]),
    transpose: -24,
  });
  assert.equal(parseMidi(low.buffer).notes[0].pitch, 0);
  assert.throws(() => markBreaths({ buffer: build(notes), transpose: 25 }), /移调/u);
});

test("key names resolve to pitch classes including flats and unicode accidentals", () => {
  assert.equal(parseKeyToPc("C"), 0);
  assert.equal(parseKeyToPc("Eb major"), 3);
  assert.equal(parseKeyToPc("E♭"), 3);
  assert.equal(parseKeyToPc("F# minor"), 6);
  assert.equal(parseKeyToPc("B"), 11);
  assert.equal(parseKeyToPc("H"), null);
  assert.equal(parseKeyToPc(""), null);
  assert.equal(parseKeyToPc(null), null);
});

test("the octave search keeps the key and respects the singer's window", () => {
  assert.equal(VOCAL_PROFILES.female.targetMedian, 67);
  assert.deepEqual(fitVocalOctave([60, 62, 64, 66], 3, "female"), {
    semitones: 3,
    fit: {
      median_before: 64,
      median_after: 67,
      range_before: [60, 66],
      range_after: [63, 69],
      key_pc_delta: 3,
      octave_fit: 0,
      singer: "female",
    },
  });
  const male = fitVocalOctave([60, 62, 64, 66], 3, "male");
  assert.equal(male.semitones, -9);
  assert.equal(male.fit.octave_fit, -12);
  assert.deepEqual(male.fit.range_after, [51, 57]);
  const empty = fitVocalOctave([], 9, "female");
  assert.equal(empty.semitones, -3);
  assert.equal(empty.fit.reason, "no_pitches");
});

test("key matching transposes the output and a manual transpose wins", () => {
  const notes = syllables(8, 0.5);
  const eb = markBreaths({ buffer: build(notes), key: "Eb major", singer: "female" });
  assert.equal(eb.report.transpose, 3);
  assert.equal(eb.report.key, "Eb major");
  assert.equal(eb.report.source_key, "C");
  assert.equal(eb.report.vocal_fit.singer, "female");
  assert.deepEqual(
    parseMidi(eb.buffer).notes.map((note) => note.pitch),
    [63, 64, 65, 66, 67, 68, 69, 63],
  );

  const manual = markBreaths({ buffer: build(notes), key: "Eb major", transpose: 5 });
  assert.equal(manual.report.transpose, 5);
  assert.equal(manual.report.vocal_fit, null);

  const noFit = markBreaths({ buffer: build(notes), key: "Eb major", fitRange: false });
  assert.equal(noFit.report.transpose, 3);
  assert.equal(noFit.report.vocal_fit, null);

  const unusual = markBreaths({ buffer: build(notes), key: "B major", sourceKey: "C", fitRange: false });
  assert.equal(unusual.report.transpose, -1);
});

test("an unknown singer falls back to the default window without failing", () => {
  const notes = syllables(4, 0.5);
  const result = markBreaths({ buffer: build(notes), key: "Eb major", singer: "不存在" });
  assert.equal(result.report.vocal_fit.singer, "不存在");
  assert.equal(result.report.transpose, 3);
});

test("rule overrides are validated and an empty MIDI fails loudly", () => {
  const notes = syllables(4, 0.5);
  assert.throws(() => markBreaths({ buffer: build(notes), rules: { unknown: 1 } }), /未知/u);
  assert.throws(() => markBreaths({ buffer: build(notes), rules: { extraRestSec: "x" } }), /非负数/u);

  const emptyTrack = Buffer.from([0x00, 0xff, 0x2f, 0x00]);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "latin1");
  trackHeader.writeUInt32BE(emptyTrack.length, 4);
  assert.throws(
    () => markBreaths({ buffer: Buffer.concat([header, trackHeader, emptyTrack]) }),
    /音符/u,
  );
});
