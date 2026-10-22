import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LRC_LIMITS, formatLrc, lrcToCues, parseLrc } from "./lyrics-lrc.mjs";
import { formatSrt } from "./automation-media.mjs";
import { resolveAllowedFile } from "./sources.mjs";

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function shiftLines(lines, shiftMs) {
  return lines
    .map((line) => ({ ...line, timeMs: Math.max(0, line.timeMs + shiftMs) }))
    .sort((left, right) => left.timeMs - right.timeMs);
}

function gapStats(lines) {
  const gaps = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    gaps.push(lines[index + 1].timeMs - lines[index].timeMs);
  }
  if (!gaps.length) return { minGapMs: 0, maxGapMs: 0, medianGapMs: 0 };
  const sorted = [...gaps].sort((left, right) => left - right);
  return {
    minGapMs: sorted[0],
    maxGapMs: sorted[sorted.length - 1],
    medianGapMs: sorted[Math.floor(sorted.length / 2)],
  };
}

// LRC files come from lyric sheets and score pipelines; this step normalises
// the timestamps, applies one explicit shift and emits SRT for the existing
// subtitle muxer. It never guesses a timing for an untimed line.
export function createLyricsTimelineHandler({ sourceStore, artifactsDir } = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("歌词时间轴需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "lyrics.timeline": async ({ run, params }) => {
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);
      if (path.extname(source).toLowerCase() !== ".lrc") throw new Error("源文件必须是 .lrc");
      const info = await stat(source);
      if (info.size === 0) throw new Error("LRC 文件为空");
      if (info.size > LRC_LIMITS.bytes) throw new Error("LRC 文件超过 1 MB");

      const parsed = parseLrc(await readFile(source, "utf8"));
      if (!parsed.lines.length) throw new Error("LRC 里没有带时间码的歌词");
      const shiftMs = Number(params.shiftMs ?? 0);
      const lines = shiftLines(parsed.lines, shiftMs);
      const cues = lrcToCues(lines);

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const lrcFile = path.join(directory, "lyrics.lrc");
      const srtFile = path.join(directory, "lyrics.srt");
      const reportFile = path.join(directory, "report.json");
      const lrcText = formatLrc({ meta: { ...parsed.meta, offset: 0 }, lines });
      const srtText = formatSrt(cues);
      const gaps = gapStats(lines);
      const report = {
        lines: lines.length,
        untimed_lines: parsed.untimed,
        first_ms: lines[0].timeMs,
        last_ms: lines[lines.length - 1].timeMs,
        shift_ms: shiftMs,
        ...gaps,
        meta: { ar: parsed.meta.ar, ti: parsed.meta.ti, al: parsed.meta.al, by: parsed.meta.by },
        source_offset_ms: parsed.meta.offset,
        in: source,
        out: { lrc: lrcFile, srt: srtFile },
      };
      const reportText = `${JSON.stringify(report, null, 2)}\n`;
      try {
        await writeFile(lrcFile, lrcText, { encoding: "utf8", mode: 0o600 });
        await writeFile(srtFile, srtText, { encoding: "utf8", mode: 0o600 });
        await writeFile(reportFile, reportText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await Promise.all([lrcFile, srtFile, reportFile].map((file) => rm(file, { force: true }).catch(() => {})));
        throw new Error(`写入歌词产物失败：${error.message}`);
      }

      return {
        artifacts: [
          { slot: "lrc", label: "歌词（LRC）", path: lrcFile, bytes: Buffer.byteLength(lrcText, "utf8") },
          { slot: "srt", label: "字幕（SRT）", path: srtFile, bytes: Buffer.byteLength(srtText, "utf8") },
          { slot: "report", label: "时间轴报告（JSON）", path: reportFile, bytes: Buffer.byteLength(reportText, "utf8") },
        ],
        logs: [
          `源文件：${path.basename(source)}，${lines.length} 行带时间歌词`
          + (parsed.untimed ? `（忽略 ${parsed.untimed} 行无时间码）` : ""),
          `时间范围 ${(lines[0].timeMs / 1_000).toFixed(2)} – ${(lines[lines.length - 1].timeMs / 1_000).toFixed(2)} 秒，`
          + `位移 ${shiftMs >= 0 ? "+" : ""}${shiftMs} 毫秒`,
          `输出 LRC 与 SRT（${cues.length} 条字幕）`,
        ],
      };
    },
  });
}
