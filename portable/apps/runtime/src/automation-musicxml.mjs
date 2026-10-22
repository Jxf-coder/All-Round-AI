import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { MUSICXML_LIMITS, buildMusicXml } from "./musicxml.mjs";
import { MIDI_LIMITS, parseMidi } from "./midi.mjs";
import { resolveAllowedFile } from "./sources.mjs";

const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

// A melody export is the readable counterpart of the breath MIDI: same notes,
// but in a format a score editor can open. The source is restricted to the
// allowed roots and the two products are written only after the XML is built.
export function createMusicXmlHandler({ sourceStore, artifactsDir } = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("旋律导出需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "midi.to-musicxml": async ({ run, params }) => {
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);
      if (!MIDI_EXTENSIONS.has(path.extname(source).toLowerCase())) {
        throw new Error("源文件必须是 .mid 或 .midi");
      }
      const info = await stat(source);
      if (info.size === 0) throw new Error("MIDI 文件为空");
      if (info.size > MIDI_LIMITS.bytes) throw new Error("MIDI 文件超过 4 MB");

      const parsed = parseMidi(await readFile(source));
      if (!parsed.notes.length) throw new Error("MIDI 里没有音符");
      if (parsed.notes.length > MUSICXML_LIMITS.notes) throw new Error("MIDI 音符过多，已停止导出");
      const title = typeof params.title === "string" && params.title.trim()
        ? params.title.trim()
        : path.basename(source, path.extname(source));
      const fifths = Number(params.fifths ?? 0);
      const { xml, report } = buildMusicXml({
        notes: parsed.notes,
        meta: {
          ticksPerBeat: parsed.ticksPerBeat,
          timeSignature: parsed.meta.timeSignature,
          tempoBpm: parsed.meta.tempoBpm,
        },
        title,
        fifths,
      });

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const xmlFile = path.join(directory, "melody.musicxml");
      const reportFile = path.join(directory, "report.json");
      const payload = { ...report, in: source, out: xmlFile };
      const reportText = `${JSON.stringify(payload, null, 2)}\n`;
      try {
        await writeFile(xmlFile, xml, { encoding: "utf8", mode: 0o600 });
        await writeFile(reportFile, reportText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await Promise.all([xmlFile, reportFile].map((file) => rm(file, { force: true }).catch(() => {})));
        throw new Error(`写入 MusicXML 产物失败：${error.message}`);
      }

      return {
        artifacts: [
          { slot: "musicxml", label: "旋律谱（MusicXML）", path: xmlFile, bytes: Buffer.byteLength(xml, "utf8") },
          { slot: "report", label: "导出报告（JSON）", path: reportFile, bytes: Buffer.byteLength(reportText, "utf8") },
        ],
        logs: [
          `源文件：${path.basename(source)}，${report.notes} 个音符`,
          `${report.measures} 个小节，${report.time_signature} 拍，${report.tempo_bpm} BPM，调号 ${report.fifths}`,
          report.tied_segments ? `${report.tied_segments} 个跨小节音符已用延音线连接` : "没有跨小节音符",
        ],
      };
    },
  });
}
