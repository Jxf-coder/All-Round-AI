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

// ---------------------------------------------------------------------------
// MusicXML → notes. Only the single-part, single-voice subset that the export
// above produces (plus hand-written melodies in the same shape) is accepted.
// Chords, grace notes, multiple parts or extra voices are refused instead of
// being flattened silently.
// ---------------------------------------------------------------------------

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const MUSICXML_IMPORT_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  notes: 20_000,
  measures: 2_000,
});

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function firstMatch(pattern, text) {
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

export function parseMusicXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new TypeError("MusicXML 内容不能为空");
  if (Buffer.byteLength(xml, "utf8") > MUSICXML_IMPORT_LIMITS.bytes) {
    throw new Error("MusicXML 文件超过 2 MB");
  }
  if (!/<score-partwise\b/u.test(xml)) throw new Error("只支持 MusicXML score-partwise");
  const parts = xml.match(/<part(?=[\s>])[^>]*>/gu) ?? [];
  if (parts.length === 0) throw new Error("MusicXML 里没有声部");
  if (parts.length > 1) throw new Error("暂不支持多声部 MusicXML");
  const partStart = xml.indexOf(parts[0]);
  const partBody = xml.slice(partStart);
  const measures = partBody.match(/<measure\b[^>]*>[\s\S]*?<\/measure>/gu) ?? [];
  if (!measures.length) throw new Error("MusicXML 里没有小节");
  if (measures.length > MUSICXML_IMPORT_LIMITS.measures) throw new Error("MusicXML 小节过多");

  const title = firstMatch(/<work-title>([\s\S]*?)<\/work-title>/u, xml);
  let divisions = null;
  let tempoBpm = 120;
  let timeSignature = null;
  let cursor = 0;
  const notes = [];
  let mergedTies = 0;

  for (const measure of measures) {
    const attributes = firstMatch(/<attributes>([\s\S]*?)<\/attributes>/u, measure);
    if (attributes) {
      const divisionText = firstMatch(/<divisions>(\d+)<\/divisions>/u, attributes);
      if (divisionText) {
        const value = Number(divisionText);
        if (!Number.isSafeInteger(value) || value < 1 || value > 9_600) throw new Error("MusicXML divisions 无效");
        divisions = value;
      }
      const beats = firstMatch(/<beats>(\d+)<\/beats>/u, attributes);
      const beatType = firstMatch(/<beat-type>(\d+)<\/beat-type>/u, attributes);
      if (beats && beatType) timeSignature = { numerator: Number(beats), denominator: Number(beatType) };
    }
    const tempo = firstMatch(/<sound\b[^>]*tempo="([\d.]+)"/u, measure)
      ?? firstMatch(/<per-minute>([\d.]+)<\/per-minute>/u, measure);
    if (tempo) {
      const value = Number(tempo);
      if (Number.isFinite(value) && value > 0 && value <= 600) tempoBpm = value;
    }
    if (!divisions) throw new Error("MusicXML 缺少 divisions");

    const blocks = measure.match(/<(note|backup|forward)\b[\s\S]*?<\/\1>/gu) ?? [];
    for (const block of blocks) {
      if (block.startsWith("<backup")) {
        const duration = Number(firstMatch(/<duration>(\d+)<\/duration>/u, block) ?? 0);
        cursor = Math.max(0, cursor - duration);
        continue;
      }
      if (block.startsWith("<forward")) {
        const duration = Number(firstMatch(/<duration>(\d+)<\/duration>/u, block) ?? 0);
        cursor += duration;
        continue;
      }
      if (/<grace\b/u.test(block)) throw new Error("暂不支持装饰音（grace note）");
      if (/<chord\s*\/>/u.test(block)) throw new Error("暂不支持和弦（chord）");
      const voice = firstMatch(/<voice>(\d+)<\/voice>/u, block);
      if (voice && voice !== "1") throw new Error("暂不支持多声部（voice）");
      const duration = Number(firstMatch(/<duration>(\d+)<\/duration>/u, block) ?? 0);
      if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("MusicXML 音符缺少有效时值");
      if (/<rest\s*\/>/u.test(block)) {
        cursor += duration;
        continue;
      }
      const step = firstMatch(/<step>([A-G])<\/step>/u, block);
      const octave = firstMatch(/<octave>(-?\d+)<\/octave>/u, block);
      if (!step || octave === null) throw new Error("MusicXML 音符缺少音高");
      const alter = Number(firstMatch(/<alter>(-?\d+)<\/alter>/u, block) ?? 0);
      const pitch = (Number(octave) + 1) * 12 + STEP_SEMITONES[step] + alter;
      if (pitch < 0 || pitch > 127) throw new Error("MusicXML 音高超出 MIDI 范围");
      const lyricBlock = firstMatch(/<lyric\b[^>]*>([\s\S]*?)<\/lyric>/u, block);
      const lyricText = lyricBlock ? firstMatch(/<text>([\s\S]*?)<\/text>/u, lyricBlock) : null;
      const lyric = lyricText ? unescapeXml(lyricText).trim() || "-" : "-";
      const tieStop = /<tie\b[^>]*type="stop"/u.test(block) || /<tied\b[^>]*type="stop"/u.test(block);

      if (tieStop) {
        const previous = notes[notes.length - 1];
        if (previous && previous.pitch === pitch && previous.tickEnd === cursor) {
          previous.tickEnd = cursor + duration;
          mergedTies += 1;
          cursor += duration;
          continue;
        }
        throw new Error("MusicXML 延音线无法连接到前一个音符");
      }
      notes.push({ tickStart: cursor, tickEnd: cursor + duration, pitch, lyric });
      cursor += duration;
      if (notes.length > MUSICXML_IMPORT_LIMITS.notes) throw new Error("MusicXML 音符过多");
    }
  }

  if (!notes.length) throw new Error("MusicXML 里没有音符");
  return {
    notes,
    meta: {
      ticksPerBeat: divisions,
      tempoBpm,
      timeSignature: timeSignature ?? { numerator: 4, denominator: 4 },
    },
    report: {
      notes: notes.length,
      measures: measures.length,
      divisions,
      tempo_bpm: Math.round(tempoBpm * 100) / 100,
      time_signature: `${(timeSignature ?? { numerator: 4, denominator: 4 }).numerator}/`
        + `${(timeSignature ?? { numerator: 4, denominator: 4 }).denominator}`,
      ties_merged: mergedTies,
      title: title ? unescapeXml(title).trim() : "",
    },
  };
}
