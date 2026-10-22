// ---------------------------------------------------------------------------
// MIDI → MusicXML (score-partwise) for a single melody part.
//
// The reference project produces MusicXML through music21. That dependency is
// far heavier than what a melody export needs: pitches, durations, ties across
// bar lines, rests, lyrics and one tempo/key/time signature. Everything here
// works on the tick positions already produced by `parseMidi`, so the export
// stays exact and dependency-free.
// ---------------------------------------------------------------------------

export const MUSICXML_LIMITS = Object.freeze({
  notes: 20_000,
  measures: 2_000,
});

const SHARP_SPELLING = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

const NOTATION_TYPES = [
  { value: 4, type: "whole", dot: false },
  { value: 3, type: "half", dot: true },
  { value: 2, type: "half", dot: false },
  { value: 1.5, type: "quarter", dot: true },
  { value: 1, type: "quarter", dot: false },
  { value: 0.75, type: "eighth", dot: true },
  { value: 0.5, type: "eighth", dot: false },
  { value: 0.25, type: "16th", dot: false },
  { value: 0.125, type: "32nd", dot: false },
];

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function notationOf(duration, divisions) {
  const ratio = duration / divisions;
  for (const entry of NOTATION_TYPES) {
    if (Math.abs(ratio - entry.value) < 0.05) return entry;
  }
  return { value: ratio, type: "quarter", dot: false };
}

function pitchXml(pitch) {
  const [step, alter] = SHARP_SPELLING[((pitch % 12) + 12) % 12];
  const octave = Math.floor(pitch / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? "<alter>1</alter>" : ""}<octave>${octave}</octave></pitch>`;
}

function lyricXml(text) {
  const value = String(text ?? "").trim();
  if (!value || value === "-") return "";
  return `<lyric number="1"><syllabic>single</syllabic><text>${escapeXml(value)}</text></lyric>`;
}

function noteXml(duration, divisions, body, extras = "") {
  const notation = notationOf(duration, divisions);
  return `<note>${body}<duration>${duration}</duration><voice>1</voice>`
    + `<type>${notation.type}</type>${notation.dot ? "<dot/>" : ""}${extras}</note>`;
}

function splitIntoSegments(notes, measureTicks) {
  const segments = [];
  for (const note of notes) {
    const originalStart = Math.max(0, Math.round(note.tickStart ?? 0));
    const end = Math.max(originalStart + 1, Math.round(note.tickEnd ?? originalStart + 1));
    let start = originalStart;
    while (start < end) {
      const measure = Math.floor(start / measureTicks);
      const boundary = (measure + 1) * measureTicks;
      const segmentEnd = Math.min(end, boundary);
      segments.push({
        measure,
        start,
        end: segmentEnd,
        pitch: note.pitch,
        lyric: note.lyric,
        // MusicXML marks the first segment as the tie start and every later
        // segment as a stop, so a score editor joins them in order.
        tieStart: start === originalStart && segmentEnd < end,
        tieStop: start > originalStart,
      });
      start = segmentEnd;
    }
  }
  return segments;
}

export function buildMusicXml({ notes, meta, title = "旋律", fifths = 0, partName = "Melody" } = {}) {
  if (!Array.isArray(notes) || !notes.length) throw new TypeError("没有可导出的音符");
  if (notes.length > MUSICXML_LIMITS.notes) throw new TypeError("音符过多，已停止导出");
  const ticksPerBeat = Number(meta?.ticksPerBeat ?? 480);
  if (!Number.isSafeInteger(ticksPerBeat) || ticksPerBeat < 24 || ticksPerBeat > 9_600) {
    throw new TypeError("MIDI 时基无效");
  }
  const signature = meta?.timeSignature ?? { numerator: 4, denominator: 4 };
  if (!Number.isInteger(signature.numerator) || signature.numerator < 1
    || ![1, 2, 4, 8, 16].includes(signature.denominator)) {
    throw new TypeError("拍号无效");
  }
  const keyFifths = Number(fifths ?? 0);
  if (!Number.isInteger(keyFifths) || keyFifths < -7 || keyFifths > 7) {
    throw new TypeError("调号必须在 -7 到 7 之间");
  }
  const divisions = ticksPerBeat;
  const measureTicks = signature.numerator * (divisions * 4) / signature.denominator;
  if (!Number.isInteger(measureTicks) || measureTicks < 1) throw new TypeError("拍号与 MIDI 时基不兼容");

  const sorted = [...notes].sort((left, right) => (left.tickStart ?? 0) - (right.tickStart ?? 0));
  const segments = splitIntoSegments(sorted, measureTicks);
  const lastMeasure = Math.floor(Math.max(...sorted.map((note) => note.tickEnd ?? note.tickStart ?? 0)) / measureTicks);
  if (lastMeasure + 1 > MUSICXML_LIMITS.measures) throw new TypeError("小节数过多，已停止导出");

  const tempoBpm = Number(meta?.tempoBpm ?? (meta?.tempoUs ? 60_000_000 / meta.tempoUs : 120));
  const perMinute = Math.max(1, Math.round(tempoBpm));
  const measures = [];
  let tiedNotes = 0;
  for (let index = 0; index <= lastMeasure; index += 1) {
    const inMeasure = segments
      .filter((segment) => segment.measure === index)
      .sort((left, right) => left.start - right.start);
    const parts = [];
    if (index === 0) {
      parts.push(
        "<attributes>"
        + `<divisions>${divisions}</divisions>`
        + `<key><fifths>${keyFifths}</fifths></key>`
        + `<time><beats>${signature.numerator}</beats><beat-type>${signature.denominator}</beat-type></time>`
        + "<clef><sign>G</sign><line>2</line></clef>"
        + "</attributes>",
        "<direction placement=\"above\"><direction-type><metronome>"
        + `<beat-unit>quarter</beat-unit><per-minute>${perMinute}</per-minute>`
        + "</metronome></direction-type>"
        + `<sound tempo="${perMinute}"/></direction>`,
      );
    }
    let cursor = index * measureTicks;
    for (const segment of inMeasure) {
      if (segment.start > cursor) {
        parts.push(noteXml(segment.start - cursor, divisions, "<rest/>"));
      }
      const duration = segment.end - segment.start;
      const extras = [
        segment.tieStop ? "<tie type=\"stop\"/>" : "",
        segment.tieStart ? "<tie type=\"start\"/>" : "",
        (segment.tieStop || segment.tieStart)
          ? `<notations>${segment.tieStop ? "<tied type=\"stop\"/>" : ""}`
            + `${segment.tieStart ? "<tied type=\"start\"/>" : ""}</notations>`
          : "",
        lyricXml(segment.lyric),
      ].join("");
      if (segment.tieStop || segment.tieStart) tiedNotes += 1;
      parts.push(noteXml(duration, divisions, pitchXml(segment.pitch), extras));
      cursor = segment.end;
    }
    const measureEnd = (index + 1) * measureTicks;
    if (cursor < measureEnd) parts.push(noteXml(measureEnd - cursor, divisions, "<rest/>"));
    measures.push(`<measure number="${index + 1}">${parts.join("")}</measure>`);
  }

  const xml = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 4.0 Partwise//EN\""
    + " \"http://www.musicxml.org/dtds/partwise.dtd\">",
    "<score-partwise version=\"4.0\">",
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    `<part-list><score-part id="P1"><part-name>${escapeXml(partName)}</part-name></score-part></part-list>`,
    "<part id=\"P1\">",
    ...measures,
    "</part>",
    "</score-partwise>",
    "",
  ].join("\n");

  return {
    xml,
    report: {
      notes: notes.length,
      measures: measures.length,
      tied_segments: tiedNotes,
      divisions,
      time_signature: `${signature.numerator}/${signature.denominator}`,
      fifths: keyFifths,
      tempo_bpm: perMinute,
      title,
    },
  };
}
