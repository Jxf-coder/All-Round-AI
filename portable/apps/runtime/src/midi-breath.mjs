import { parseMidi, writeMidi } from "./midi.mjs";

// ---------------------------------------------------------------------------
// MIDI breath marking (port of skills-py/midi-breath/breath_mark/core.py).
//
// The reference rules come from 122 measured vocal recordings: the score
// already had rests, but real singers breathe far more often. Five rules run in
// a fixed order — widen short score rests, cut at lyric line ends, cut after
// long notes, cap every phrase at eight seconds, then optionally transpose.
// Cutting always protects the sung character: a note keeps at least 60% of its
// original length (and 0.12s), so the breath shrinks before the word does.
// ---------------------------------------------------------------------------

export const BREATH_RULES = Object.freeze({
  restSecMin: 0.42,
  extraRestSec: 0.42,
  extraRestFloorSec: 0.1,
  minNoteAfterCutSec: 0.12,
  keepNoteRatioMin: 0.6,
  alignLyricLines: true,
  longNoteBreath: true,
  longNoteMinBeats: 1.5,
  longNoteMinSec: 0.9,
  longNoteMinSinceGapSec: 3.0,
  maxPhraseSec: 8.0,
});

export const MAX_TRANSPOSE = 24;
export const MAX_LYRIC_LINES = 500;
const CJK = /[\u4e00-\u9fff]/u;

export function parseLyricLines(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const lines = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/u)) {
    const line = [...raw].filter((char) => CJK.test(char)).join("");
    if (line.length < 2 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= MAX_LYRIC_LINES) break;
  }
  return lines;
}

function isCjk(text) {
  const value = String(text ?? "").trim();
  return Boolean(value) && value !== "-" && CJK.test(value);
}

function cjkChars(notes) {
  const chars = [];
  const owner = [];
  notes.forEach((note, index) => {
    for (const char of String(note.lyric ?? "")) {
      if (CJK.test(char)) {
        chars.push(char);
        owner.push(index);
      }
    }
  });
  return { text: chars.join(""), owner };
}

function findFuzzy(haystack, line, start, maxBad) {
  const direct = haystack.indexOf(line, start);
  if (direct >= 0 || maxBad <= 0) return direct;
  const length = line.length;
  for (let position = start; position <= haystack.length - length; position += 1) {
    let bad = 0;
    for (let index = 0; index < length; index += 1) {
      if (haystack[position + index] !== line[index]) {
        bad += 1;
        if (bad > maxBad) break;
      }
    }
    if (bad <= maxBad) return position;
  }
  return -1;
}

function lineEndIndices(notes, lines) {
  const { text, owner } = cjkChars(notes);
  const ends = new Set();
  for (const line of lines) {
    if (line.length < 2) continue;
    const maxBad = line.length >= 6 ? 1 : 0;
    let start = 0;
    for (;;) {
      const position = findFuzzy(text, line, start, maxBad);
      if (position < 0) break;
      ends.add(owner[position + line.length - 1]);
      start = position + Math.max(1, Math.floor(line.length / 2));
    }
  }
  return [...ends].sort((left, right) => left - right);
}

function keepLen(note, minNote, keepRatio) {
  return Math.max(minNote, (note.t1 - note.t0) * keepRatio);
}

function widenShortRests(notes, limit, minNote, keepRatio) {
  let count = 0;
  for (let index = 0; index < notes.length - 1; index += 1) {
    const note = notes[index];
    const next = notes[index + 1];
    const gap = next.t0 - note.t1;
    if (gap < 0.12 || gap >= limit) continue;
    const keep = keepLen(note, minNote, keepRatio);
    const newEnd = Math.max(next.t0 - limit, note.t0 + keep);
    if (newEnd >= note.t1 - 0.01) continue;
    note.t1 = newEnd;
    count += 1;
  }
  return count;
}

function carveAfter(notes, index, rest, minNote, floor, keepRatio) {
  if (index < 0 || index >= notes.length - 1) return false;
  if (!isCjk(notes[index].lyric)) {
    let back = index;
    while (back >= 0 && !isCjk(notes[back].lyric)) back -= 1;
    if (back < 0) return false;
    index = back;
    if (index >= notes.length - 1) return false;
  }
  while (index + 1 < notes.length && notes[index + 1].lyric.trim() === "-") index += 1;
  if (index >= notes.length - 1) return false;
  const next = notes[index + 1];
  if (next.lyric.trim() === "-") return false;
  const gap = next.t0 - notes[index].t1;
  if (gap >= rest - 0.02) return false;
  const keep = keepLen(notes[index], minNote, keepRatio);
  const use = Math.min(rest, next.t0 - notes[index].t0 - keep);
  if (use < floor || use <= gap + 0.01) return false;
  notes[index].t1 = next.t0 - use;
  return true;
}

function breatheAfterLongNotes(notes, options) {
  const {
    beatSec, minBeats, minSec, minSinceGap, rest, minNote, floor, keepRatio, gapSec,
  } = options;
  let count = 0;
  const threshold = Math.max(minBeats * beatSec, minSec) - 0.03;
  let lastGapAt = notes.length ? notes[0].t0 : 0;
  for (let index = 0; index < notes.length - 1; index += 1) {
    const note = notes[index];
    const next = notes[index + 1];
    const gap = next.t0 - note.t1;
    if (gap >= gapSec) {
      lastGapAt = next.t0;
      continue;
    }
    if (next.lyric.trim() === "-" || !isCjk(note.lyric)) continue;
    const duration = next.t0 - note.t0;
    if (duration < threshold || note.t1 - lastGapAt < minSinceGap) continue;
    if (carveAfter(notes, index, rest, minNote, floor, keepRatio)) {
      count += 1;
      lastGapAt = next.t0;
    }
  }
  return count;
}

function enforcePhraseCap(notes, cap, rest, minNote, floor, keepRatio, gapSec) {
  let count = 0;
  let lastCut = notes.length ? notes[0].t0 : 0;
  let index = 0;
  while (index < notes.length) {
    const note = notes[index];
    const gapAfter = index + 1 < notes.length ? notes[index + 1].t0 - note.t1 : 0;
    if (gapAfter >= gapSec && index + 1 < notes.length) {
      lastCut = notes[index + 1].t0;
      index += 1;
      continue;
    }
    if (note.t1 - lastCut < cap || index >= notes.length - 1) {
      index += 1;
      continue;
    }
    const candidates = [];
    for (let back = index; back >= 0; back -= 1) {
      if (notes[back].t0 < lastCut) break;
      if (!isCjk(notes[back].lyric)) continue;
      if (notes[back].t1 - lastCut < 1.6) continue;
      if (back >= notes.length - 1) continue;
      candidates.push(back);
    }
    if (!candidates.length) {
      index += 1;
      continue;
    }
    candidates.sort((left, right) => {
      const leftSpan = notes[left + 1].t0 - notes[left].t0;
      const rightSpan = notes[right + 1].t0 - notes[right].t0;
      return rightSpan - leftSpan || right - left;
    });
    let cut = false;
    for (const candidate of candidates) {
      if (carveAfter(notes, candidate, rest, minNote, floor, keepRatio)) {
        count += 1;
        lastCut = notes[candidate + 1].t0;
        index = candidate + 1;
        cut = true;
        break;
      }
    }
    if (!cut) index += 1;
  }
  return count;
}

export function phraseStats(notes, minGap = 0.22) {
  if (!notes.length) return { n_gap: 0, max_phrase: 0, n_phrase: 0, median_phrase: 0 };
  const phrases = [];
  let start = notes[0].t0;
  let end = notes[0].t1;
  let gaps = 0;
  for (let index = 0; index < notes.length - 1; index += 1) {
    const gap = notes[index + 1].t0 - end;
    if (gap >= minGap) {
      phrases.push(end - start);
      gaps += 1;
      start = notes[index + 1].t0;
    }
    end = Math.max(end, notes[index + 1].t1);
  }
  phrases.push(end - start);
  return {
    n_gap: gaps,
    n_phrase: phrases.length,
    max_phrase: Math.round(Math.max(...phrases) * 100) / 100,
    median_phrase: Math.round(phrases.sort((left, right) => left - right)[Math.floor(phrases.length / 2)] * 100) / 100,
  };
}

function mergeRules(overrides) {
  if (overrides === undefined || overrides === null) return { ...BREATH_RULES };
  if (typeof overrides !== "object") throw new TypeError("气口规则必须是对象");
  const merged = { ...BREATH_RULES };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in BREATH_RULES)) throw new TypeError(`未知的气口规则：${key}`);
    if (typeof BREATH_RULES[key] === "boolean") {
      if (typeof value !== "boolean") throw new TypeError(`气口规则 ${key} 必须是布尔值`);
    } else if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`气口规则 ${key} 必须是非负数`);
    }
    merged[key] = value;
  }
  return merged;
}

export function markBreaths({ buffer, lyrics = [], transpose = 0, rules } = {}) {
  const active = mergeRules(rules);
  const semitones = Number(transpose ?? 0);
  if (!Number.isInteger(semitones) || Math.abs(semitones) > MAX_TRANSPOSE) {
    throw new TypeError(`移调必须是 -${MAX_TRANSPOSE} 到 ${MAX_TRANSPOSE} 之间的整数`);
  }
  const parsed = parseMidi(buffer);
  const notes = parsed.notes.map((note) => ({ ...note }));
  if (!notes.length) throw new Error("MIDI 里没有音符");

  const rest = active.extraRestSec;
  const minNote = active.minNoteAfterCutSec;
  const floor = active.extraRestFloorSec;
  const keepRatio = active.keepNoteRatioMin;
  const gapSec = Math.min(0.22, floor);
  const before = phraseStats(notes, gapSec);

  const widened = widenShortRests(notes, active.restSecMin, minNote, keepRatio);

  let lineCuts = 0;
  let lineEnds = [];
  const lines = lyrics.filter((line) => typeof line === "string" && line.length >= 2);
  if (lines.length && active.alignLyricLines) {
    lineEnds = lineEndIndices(notes, lines);
    // A weak match means the lyric sheet belongs to another song (or the MIDI
    // is instrumental); aligning it would cut syllables at random.
    if (lineEnds.length < Math.max(3, Math.floor(lines.length * 0.3))) lineEnds = [];
    for (const index of lineEnds) {
      if (carveAfter(notes, index, rest, minNote, floor, keepRatio)) lineCuts += 1;
    }
  }

  let longCuts = 0;
  if (active.longNoteBreath) {
    longCuts = breatheAfterLongNotes(notes, {
      beatSec: 60 / parsed.meta.tempoBpm,
      minBeats: active.longNoteMinBeats,
      minSec: active.longNoteMinSec,
      minSinceGap: active.longNoteMinSinceGapSec,
      rest,
      minNote,
      floor,
      keepRatio,
      gapSec,
    });
  }

  const capCuts = enforcePhraseCap(
    notes, active.maxPhraseSec, rest, minNote, floor, keepRatio, gapSec,
  );

  const after = phraseStats(notes, gapSec);
  const gaps = notes.slice(0, -1).map((note, index) => notes[index + 1].t0 - note.t1);
  after.n_red_v = gaps.filter((gap) => gap >= active.restSecMin - 0.02).length;
  const microGaps = gaps.filter((gap) => gap >= gapSec && gap < active.restSecMin - 0.02).length;

  if (semitones) {
    for (const note of notes) note.pitch = Math.max(0, Math.min(127, note.pitch + semitones));
  }

  const output = writeMidi({
    notes,
    meta: {
      ticksPerBeat: parsed.ticksPerBeat,
      tempoUs: parsed.meta.tempoUs,
      timeSignature: parsed.meta.timeSignature,
    },
  });
  const duration = notes.length ? notes[notes.length - 1].t1 - notes[0].t0 : 0;
  return {
    buffer: output,
    report: {
      notes: notes.length,
      tempo_bpm: Math.round(parsed.meta.tempoBpm * 100) / 100,
      duration_sec: Math.round(duration * 100) / 100,
      widened_score_rests: widened,
      lyric_lines_total: lines.length,
      lyric_line_ends_matched: lineEnds.length,
      lyric_line_cuts: lineCuts,
      long_note_cuts: longCuts,
      phrase_cap_cuts: capCuts,
      short_gaps_protecting_note: microGaps,
      before,
      after,
      breaths_per_min: duration ? Math.round((after.n_gap / duration) * 60 * 10) / 10 : 0,
      transpose: semitones,
    },
  };
}
