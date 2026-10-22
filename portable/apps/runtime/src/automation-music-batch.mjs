import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { MIDI_LIMITS, parseMidi, writeMidi } from "./midi.mjs";
import { markBreaths } from "./midi-breath.mjs";
import { MUSICXML_IMPORT_LIMITS, MUSICXML_LIMITS, buildMusicXml, parseMusicXml } from "./musicxml.mjs";
import { resolveAllowedFile, resolveScoutRoot } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Music batch mode.
//
// The three symbolic music steps each read one file. In practice a song folder
// arrives with a dozen MIDI or MusicXML files, so this handler scans one level
// of an allowed directory and applies the chosen transform to every match.
// Like the subtitle batch, one bad file is recorded and skipped instead of
// discarding the products already written; the run only fails when nothing
// succeeded.
// ---------------------------------------------------------------------------

export const MUSIC_BATCH_TASKS = Object.freeze({
  breaths: { label: "补齐气口", extensions: [".mid", ".midi"], suffix: "_气口.mid" },
  export: { label: "导出旋律谱", extensions: [".mid", ".midi"], suffix: ".musicxml" },
  import: { label: "导入旋律", extensions: [".musicxml", ".xml"], suffix: ".mid" },
});

export const MUSIC_BATCH_LIMITS = Object.freeze({ files: 20 });

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function safeStem(name) {
  return path.basename(name, path.extname(name))
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .slice(0, 40) || "track";
}

// One level only: a song folder is flat, and recursion would mix album
// subfolders into one report without a way to tell them apart.
async function scanMusicDirectory(root, extensions, maxFiles) {
  const wanted = new Set(extensions);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error(`无法读取目录：${root}`);
  }
  const files = [];
  let truncated = false;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    if (!wanted.has(path.extname(entry.name).toLowerCase())) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(entry.name);
  }
  return { files, truncated };
}

async function readMidi(source) {
  const info = await stat(source);
  if (info.size === 0) throw new Error("MIDI 文件为空");
  if (info.size > MIDI_LIMITS.bytes) throw new Error("MIDI 文件超过 4 MB");
  return readFile(source);
}

function markBreathProduct({ buffer, transpose }) {
  const { buffer: output, report } = markBreaths({
    buffer,
    // Batch mode has no per-file lyric sheet, so breaths come from long notes
    // and the phrase cap only. Octave fitting is a single-file decision.
    lyrics: [],
    transpose,
    fitRange: false,
  });
  return {
    output,
    detail: {
      notes: report.notes,
      seconds: report.duration_sec,
      gaps_before: report.before.n_gap,
      gaps_after: report.after.n_gap,
      transpose: report.transpose,
    },
    extra: "",
  };
}

function exportProduct({ buffer, title, fifths }) {
  const parsed = parseMidi(buffer);
  if (!parsed.notes.length) throw new Error("MIDI 里没有音符");
  if (parsed.notes.length > MUSICXML_LIMITS.notes) throw new Error("MIDI 音符过多，已停止导出");
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
  return {
    output: xml,
    encoding: "utf8",
    detail: {
      notes: report.notes,
      measures: report.measures,
      time_signature: report.time_signature,
      tempo_bpm: report.tempo_bpm,
      fifths: report.fifths,
    },
    extra: report.tied_segments ? `${report.tied_segments} 段延音线` : "",
  };
}

function importProduct({ buffer }) {
  const parsed = parseMusicXml(buffer);
  const tempoUs = Math.round(60_000_000 / parsed.meta.tempoBpm);
  const seconds = (tick) => (tick * 60) / parsed.meta.tempoBpm / parsed.meta.ticksPerBeat;
  const midi = writeMidi({
    notes: parsed.notes.map((note) => ({
      t0: seconds(note.tickStart),
      t1: seconds(note.tickEnd),
      pitch: note.pitch,
      lyric: note.lyric,
    })),
    meta: {
      ticksPerBeat: parsed.meta.ticksPerBeat,
      tempoUs,
      timeSignature: parsed.meta.timeSignature,
    },
  });
  return {
    output: midi,
    detail: {
      notes: parsed.report.notes,
      measures: parsed.report.measures,
      time_signature: parsed.report.time_signature,
      tempo_bpm: parsed.report.tempo_bpm,
    },
    extra: parsed.report.ties_merged ? `${parsed.report.ties_merged} 段延音线已合并` : "",
  };
}

export function createMusicBatchHandler({ sourceStore, artifactsDir } = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("音乐批量处理需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "music.batch": async ({ run, params }) => {
      const task = MUSIC_BATCH_TASKS[params.task ?? "breaths"];
      if (!task) throw new Error("批量任务无效");
      const requested = Number(params.maxFiles ?? 5);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > MUSIC_BATCH_LIMITS.files) {
        throw new Error(`文件数必须是 1 到 ${MUSIC_BATCH_LIMITS.files} 之间的整数`);
      }
      const fifths = Number(params.fifths ?? 0);
      if (!Number.isInteger(fifths) || fifths < -7 || fifths > 7) {
        throw new Error("调号必须是 -7 到 7 之间的整数");
      }
      const transpose = params.manualTranspose === true ? Number(params.transpose ?? 0) : undefined;
      if (transpose !== undefined && (!Number.isInteger(transpose) || Math.abs(transpose) > 24)) {
        throw new Error("移调必须是 -24 到 24 之间的整数");
      }

      const roots = (await sourceStore.list()).roots;
      const root = await resolveScoutRoot(params.root, roots);
      const { files, truncated } = await scanMusicDirectory(root, task.extensions, requested);
      if (!files.length) throw new Error("目录里没有可处理的音乐文件");

      const baseDirectory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(baseDirectory, { recursive: true });
      const startedAt = Date.now();
      const results = [];
      const artifacts = [];

      for (const name of files) {
        const source = await resolveAllowedFile(path.join(root, name), roots);
        // Number only the products that actually get written, so a failure
        // does not leave a gap that makes the folder look incomplete.
        const sequence = String(artifacts.length + 1).padStart(2, "0");
        const directory = path.join(baseDirectory, `${sequence}-${safeStem(name)}`);
        const stem = path.basename(name, path.extname(name));
        const productFile = path.join(directory, `${stem}${task.suffix}`);
        try {
          await mkdir(directory, { recursive: true });
          let product;
          if ((params.task ?? "breaths") === "breaths") {
            product = markBreathProduct({ buffer: await readMidi(source), transpose });
          } else if (params.task === "export") {
            product = exportProduct({ buffer: await readMidi(source), title: stem, fifths });
          } else {
            const info = await stat(source);
            if (info.size === 0) throw new Error("MusicXML 文件为空");
            if (info.size > MUSICXML_IMPORT_LIMITS.bytes) throw new Error("MusicXML 文件超过 2 MB");
            product = importProduct({ buffer: await readFile(source, "utf8") });
          }
          await writeFile(productFile, product.output, {
            ...(product.encoding ? { encoding: product.encoding } : {}),
            mode: 0o600,
          });
          const bytes = Buffer.byteLength(product.output);
          artifacts.push({
            slot: `product-${artifacts.length + 1}`,
            label: `${task.label}：${name}`,
            path: productFile,
            bytes,
          });
          results.push({
            name,
            path: name,
            status: "ok",
            out: path.relative(baseDirectory, productFile).split(path.sep).join("/"),
            bytes,
            ...product.detail,
          });
        } catch (error) {
          await rm(productFile, { force: true }).catch(() => {});
          await rm(directory, { recursive: true, force: true }).catch(() => {});
          results.push({
            name,
            path: name,
            status: "failed",
            error: String(error?.message ?? "未知错误").slice(0, 300),
          });
        }
      }

      const ok = results.filter((entry) => entry.status === "ok");
      if (!ok.length) {
        const detail = results.map((entry) => `${entry.name}：${entry.error}`).join("；").slice(0, 300);
        throw new Error(`没有任何文件处理成功（${detail}）`);
      }

      const summary = {
        root,
        task: params.task ?? "breaths",
        task_label: task.label,
        params: {
          fifths: params.task === "export" ? fifths : null,
          transpose: transpose ?? null,
        },
        truncated,
        files: results,
        counts: { ok: ok.length, failed: results.length - ok.length },
        total_bytes: ok.reduce((sum, entry) => sum + entry.bytes, 0),
        elapsed: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
      };
      const reportJson = path.join(baseDirectory, "batch-report.json");
      const reportMarkdown = path.join(baseDirectory, "batch-report.md");
      const jsonText = `${JSON.stringify(summary, null, 2)}\n`;
      const lines = [
        `# 音乐批量报告：${task.label}`,
        "",
        `- 目录：${root}`,
        `- 结果：成功 ${summary.counts.ok}、失败 ${summary.counts.failed}`,
        `- 合计产物：${summary.total_bytes} 字节；用时 ${summary.elapsed} 秒`,
        ...(truncated ? [`- 注意：只处理了按文件名排序的前 ${requested} 个文件`] : []),
        "",
        "| 文件 | 状态 | 结果 | 说明 |",
        "| --- | --- | --- | --- |",
        ...results.map((entry) => `| ${entry.path} | ${entry.status} | `
          + `${entry.status === "ok" ? (entry.out ?? "-") : "-"} | `
          + `${entry.error ?? entry.extra ?? ""} |`),
        "",
      ];
      const markdownText = lines.join("\n");
      try {
        await writeFile(reportJson, jsonText, { encoding: "utf8", mode: 0o600 });
        await writeFile(reportMarkdown, markdownText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await Promise.all([reportJson, reportMarkdown].map((file) => rm(file, { force: true }).catch(() => {})));
        throw new Error(`写入批量报告失败：${error.message}`);
      }
      artifacts.push(
        {
          slot: "report-json",
          label: "批量报告（JSON）",
          path: reportJson,
          bytes: Buffer.byteLength(jsonText, "utf8"),
        },
        {
          slot: "report-markdown",
          label: "批量报告（Markdown）",
          path: reportMarkdown,
          bytes: Buffer.byteLength(markdownText, "utf8"),
        },
      );

      return {
        artifacts,
        logs: [
          `目录：${root}，${task.label} ${results.length} 个文件`,
          `成功 ${summary.counts.ok}、失败 ${summary.counts.failed}`
          + (truncated ? `（只取前 ${requested} 个）` : ""),
          `用时 ${summary.elapsed} 秒`,
        ],
      };
    },
  });
}
