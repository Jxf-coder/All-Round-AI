import assert from "node:assert/strict";
import test from "node:test";

import { midiNoteName, parseMidi, writeMidi } from "../src/midi.mjs";

const META = {
  ticksPerBeat: 480,
  tempoUs: 500000,
  timeSignature: { numerator: 4, denominator: 4 },
};

test("a written MIDI keeps tempo, time signature, lyrics and note timing", () => {
  const buffer = writeMidi({
    notes: [
      { t0: 0, t1: 0.5, pitch: 60, lyric: "只" },
      { t0: 0.5, t1: 1.0, pitch: 62, lyric: "剩" },
    ],
    meta: META,
    trackName: "VOCAL",
  });

  assert.equal(buffer.toString("latin1", 0, 4), "MThd");
  assert.equal(buffer.readUInt16BE(8), 0);
  assert.equal(buffer.readUInt16BE(10), 1);
  assert.equal(buffer.readUInt16BE(12), 480);

  const parsed = parseMidi(buffer);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].name, "VOCAL");
  assert.equal(parsed.meta.tempoBpm, 120);
  assert.deepEqual(parsed.meta.timeSignature, { numerator: 4, denominator: 4 });
  assert.deepEqual(parsed.notes.map((note) => note.pitch), [60, 62]);
  assert.deepEqual(parsed.notes.map((note) => note.lyric), ["只", "剩"]);
  assert.equal(parsed.notes[0].t0, 0);
  assert.equal(Math.round(parsed.notes[1].t0 * 1000) / 1000, 0.5);
  assert.equal(Math.round(parsed.notes[1].t1 * 1000) / 1000, 1);
});

test("running status, note-on velocity zero and tempo changes are parsed", () => {
  const track = Buffer.from([
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xff, 0x03, 0x05, 0x50, 0x69, 0x61, 0x6e, 0x6f,
    0x00, 0x90, 0x3c, 0x64,
    0x60, 0x3e, 0x64,
    0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
    0x00, 0x3c, 0x00,
    0x60, 0x3e, 0x00,
    0x00, 0xff, 0x2f, 0x00,
  ]);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "latin1");
  trackHeader.writeUInt32BE(track.length, 4);

  const parsed = parseMidi(Buffer.concat([header, trackHeader, track]));
  assert.equal(parsed.tracks[0].name, "Piano");
  // The file reports the last tempo seen, while note seconds follow the map.
  assert.equal(parsed.meta.tempoBpm, 60);
  assert.deepEqual(parsed.notes.map((note) => note.pitch), [60, 62]);
  assert.equal(Math.round(parsed.notes[0].t1 * 1000) / 1000, 0.5);
  assert.equal(Math.round(parsed.notes[1].t0 * 1000) / 1000, 0.5);
  assert.equal(Math.round(parsed.notes[1].t1 * 1000) / 1000, 1.5);
  assert.deepEqual(parsed.notes.map((note) => note.lyric), ["-", "-"]);
});

test("broken or unsupported MIDI is rejected with a readable reason", () => {
  assert.throws(() => parseMidi(Buffer.from("not a midi file")), /MIDI/u);
  assert.throws(() => parseMidi(Buffer.alloc(0)), /MIDI/u);

  const format2 = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 0, 0, 96]);
  assert.throws(() => parseMidi(format2), /format 2/u);

  const smpte = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 0, 0xe7, 0x28]);
  assert.throws(() => parseMidi(smpte), /SMPTE/u);

  assert.throws(() => writeMidi({ notes: [] }), /音符/u);
  assert.throws(() => writeMidi({ notes: [{ t0: 0, t1: 1, pitch: 200 }], meta: META }), /音高/u);
});

test("note names follow scientific pitch notation", () => {
  assert.equal(midiNoteName(60), "C4");
  assert.equal(midiNoteName(69), "A4");
  assert.equal(midiNoteName(61), "C#4");
});
