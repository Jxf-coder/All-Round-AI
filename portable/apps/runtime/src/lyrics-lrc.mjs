// ---------------------------------------------------------------------------
// LRC lyrics: parse, normalise and convert to SRT cues.
//
// The reference project writes `lyrics.lrc` from the score pipeline and reads
// LRC back when aligning words. Both directions are plain text handling, so
// they stay in-process and feed the existing subtitle pipeline instead of
// introducing another external tool.
//
// Offset convention: `[offset:+500]` means the lyrics should appear 500 ms
// earlier, so the effective time is `timestamp - offset`. Negative offsets
// delay the line. Normalised output always writes `offset:0` with shifted
// timestamps, so the result never depends on a player's convention.
// ---------------------------------------------------------------------------

export const LRC_LIMITS = Object.freeze({
  bytes: 1_000_000,
  lines: 2_000,
  text: 500,
});

const TAG = /^\[(ar|ti|al|by|offset):(.*)\]$/iu;
const STAMP = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/gu;

function fractionToMs(raw) {
  if (!raw) return 0;
  if (raw.length === 3) return Number(raw);
  if (raw.length === 2) return Number(raw) * 10;
  return Number(raw) * 100;
}

function stampMs(minutes, seconds, fraction) {
  return (Number(minutes) * 60 + Number(seconds)) * 1_000 + fractionToMs(fraction);
}

// A line may carry several timestamps (a repeated chorus), so one text can
// produce multiple timed entries. Untimed lines are counted but never guessed
// at: guessing would silently shift the whole track.
export function parseLrc(input) {
  if (typeof input !== "string") throw new TypeError("歌词内容必须是文本");
  const text = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (Buffer.byteLength(text, "utf8") > LRC_LIMITS.bytes) throw new Error("LRC 文件超过 1 MB");
  const rawLines = text.split("\n");
  if (rawLines.length > LRC_LIMITS.lines) throw new Error(`LRC 最多 ${LRC_LIMITS.lines} 行`);

  const meta = { ar: "", ti: "", al: "", by: "", offset: 0 };
  const entries = [];
  let untimed = 0;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;
    const tag = TAG.exec(line);
    if (tag) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (key === "offset") {
        const offset = Number(value);
        if (!Number.isFinite(offset) || !Number.isInteger(offset)) throw new Error("LRC offset 必须是整数毫秒");
        meta.offset = offset;
      } else {
        meta[key] = value;
      }
      continue;
    }
    STAMP.lastIndex = 0;
    const stamps = [];
    let lastIndex = 0;
    for (let match = STAMP.exec(line); match; match = STAMP.exec(line)) {
      stamps.push(stampMs(match[1], match[2], match[3]));
      lastIndex = STAMP.lastIndex;
    }
    if (!stamps.length) {
      untimed += 1;
      continue;
    }
    const content = line.slice(lastIndex).trim();
    if (!content) continue;
    if (content.length > LRC_LIMITS.text) throw new Error(`歌词单行超过 ${LRC_LIMITS.text} 个字符`);
    for (const timeMs of stamps) entries.push({ timeMs, text: content });
  }

  const seen = new Set();
  const lines = entries
    .map((entry, index) => ({
      ...entry,
      timeMs: Math.max(0, entry.timeMs - meta.offset),
      order: index,
    }))
    .sort((left, right) => left.timeMs - right.timeMs || left.order - right.order)
    .filter((entry) => {
      const key = `${entry.timeMs}\u0000${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ timeMs, text: content }) => ({ timeMs, text: content }));

  return { meta, lines, untimed };
}

function formatStamp(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const centis = Math.floor((total % 1_000) / 10);
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}]`;
}

export function formatLrc({ meta = {}, lines = [] } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("歌词内容不能为空");
  const output = [];
  for (const key of ["ti", "ar", "al", "by"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) output.push(`[${key}:${meta[key].trim()}]`);
  }
  if (Number.isFinite(meta.offset) && meta.offset !== 0) output.push(`[offset:${Math.trunc(meta.offset)}]`);
  for (const line of lines) {
    if (typeof line?.text !== "string" || !line.text.trim()) continue;
    if (!Number.isFinite(line.timeMs) || line.timeMs < 0) throw new Error("歌词时间必须是非负毫秒");
    output.push(`${formatStamp(line.timeMs)}${line.text.trim()}`);
  }
  if (!output.length) throw new Error("歌词内容不能为空");
  return `${output.join("\n")}\n`;
}

// SRT is the format the subtitle muxer already accepts. Cues end just before
// the next line so two lyrics never share a frame; very short gaps keep a
// minimum duration instead of collapsing to zero.
export function lrcToCues(lines, { gapMs = 200, minDurationMs = 800, maxDurationMs = 8_000 } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("歌词内容不能为空");
  return lines.map((line, index) => {
    const start = Math.max(0, Math.round(line.timeMs));
    const next = lines[index + 1];
    const nextStart = next ? Math.max(start, Math.round(next.timeMs)) : null;
    let end = nextStart === null ? start + 2_000 : nextStart - gapMs;
    end = Math.min(end, start + maxDurationMs);
    const ceiling = nextStart === null ? Number.POSITIVE_INFINITY : Math.max(start + 1, nextStart - 1);
    if (end - start < minDurationMs) end = Math.min(start + minDurationMs, ceiling);
    if (end <= start) end = start + 1;
    return { start, end, text: line.text };
  });
}
