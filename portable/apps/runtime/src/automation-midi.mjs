import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { MIDI_LIMITS } from "./midi.mjs";
import { markBreaths, parseLyricLines } from "./midi-breath.mjs";
import { resolveAllowedFile } from "./sources.mjs";

const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

// Breath marking is the first music step that fits the zero-dependency rule:
// it only reads and rewrites a Standard MIDI File, no audio, model or service.
// The source still has to sit inside an allowed root, and both products are
// written only after the whole transform succeeds.
export function createMidiBreathHandler({ sourceStore, artifactsDir } = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("MIDI 气口需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "midi.mark-breaths": async ({ run, params }) => {
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);
      if (!MIDI_EXTENSIONS.has(path.extname(source).toLowerCase())) {
        throw new Error("源文件必须是 .mid 或 .midi");
      }
      const info = await stat(source);
      if (info.size === 0) throw new Error("MIDI 文件为空");
      if (info.size > MIDI_LIMITS.bytes) throw new Error("MIDI 文件超过 4 MB");
      const buffer = await readFile(source);

      const lyrics = parseLyricLines(params.lyrics ?? "");
      const transpose = Number(params.transpose ?? 0);
      const { buffer: output, report } = markBreaths({ buffer, lyrics, transpose });

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const stem = path.basename(source, path.extname(source));
      const midiFile = path.join(directory, `${stem}_气口.mid`);
      const reportFile = path.join(directory, "report.json");
      const payload = {
        ...report,
        in: source,
        out: midiFile,
        lyrics_source: lyrics.length ? "text" : "none",
      };
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      try {
        await writeFile(midiFile, output, { mode: 0o600 });
        await writeFile(reportFile, text, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await rm(midiFile, { force: true }).catch(() => {});
        await rm(reportFile, { force: true }).catch(() => {});
        throw new Error(`写入 MIDI 气口产物失败：${error.message}`);
      }

      const before = report.before;
      const after = report.after;
      return {
        artifacts: [
          { slot: "midi", label: "气口 MIDI", path: midiFile, bytes: output.length },
          { slot: "report", label: "气口报告（JSON）", path: reportFile, bytes: Buffer.byteLength(text, "utf8") },
        ],
        logs: [
          `源文件：${path.basename(source)}，${report.notes} 个音符，${report.duration_sec} 秒`,
          `气口 ${before.n_gap} → ${after.n_gap}（约 ${report.breaths_per_min}/分钟），`
          + `最长乐句 ${before.max_phrase} → ${after.max_phrase} 秒`,
          `句尾 ${report.lyric_line_cuts}、长音 ${report.long_note_cuts}、`
          + `兜底 ${report.phrase_cap_cuts}、保字短口 ${report.short_gaps_protecting_note}`,
          `移调 ${report.transpose >= 0 ? "+" : ""}${report.transpose} 半音`,
        ],
      };
    },
  });
}
