import { lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { probeMediaFile, runMediaTool } from "./media-tools.mjs";
import { resolveAllowedFile, resolveScoutRoot } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Media inventory. This is the part of the media pipeline that needs no FFmpeg:
// walk an allowed source directory, keep video / audio / image files and write
// a reviewable list. Transcoding and rendering arrive later and can reuse the
// same allowed-root boundary instead of accepting arbitrary paths.
// ---------------------------------------------------------------------------

export const MEDIA_EXTENSIONS = Object.freeze({
  video: [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".ts"],
  audio: [".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic"],
});

export const MEDIA_KIND_LABELS = Object.freeze({
  all: "全部媒体",
  video: "视频",
  audio: "音频",
  image: "图片",
});

export const MEDIA_SCAN_LIMITS = Object.freeze({
  depth: 6,
  dirs: 500,
  entries: 5_000,
  maxFiles: 200,
});

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  "$RECYCLE.BIN",
  "System Volume Information",
]);
const KIND_SET = new Set(Object.keys(MEDIA_EXTENSIONS));
const EXTENSION_KIND = new Map();
for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
  for (const extension of extensions) EXTENSION_KIND.set(extension, kind);
}

export function mediaKindOf(name) {
  return EXTENSION_KIND.get(path.extname(String(name)).toLowerCase()) ?? null;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

export async function scanMediaDirectory({ root, kinds = "all", maxFiles = 50 } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("素材目录必须是绝对路径");
  }
  if (kinds !== "all" && !KIND_SET.has(kinds)) throw new TypeError("素材类型无效");
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MEDIA_SCAN_LIMITS.maxFiles) {
    throw new TypeError(`保留文件数必须是 1 到 ${MEDIA_SCAN_LIMITS.maxFiles} 之间的整数`);
  }

  const counts = { dirs: 0, files: 0, matched: 0 };
  const files = [];
  const queue = [{ absolute: root, relative: "", depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    if (counts.dirs >= MEDIA_SCAN_LIMITS.dirs || counts.files >= MEDIA_SCAN_LIMITS.entries) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    counts.dirs += 1;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (counts.files >= MEDIA_SCAN_LIMITS.entries) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || current.depth >= MEDIA_SCAN_LIMITS.depth) continue;
        queue.push({
          absolute: path.join(current.absolute, entry.name),
          relative: displayPath(current.relative, entry.name),
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      counts.files += 1;
      const kind = mediaKindOf(entry.name);
      if (!kind || (kinds !== "all" && kind !== kinds)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }
      let info;
      try {
        info = await lstat(path.join(current.absolute, entry.name));
      } catch {
        continue;
      }
      counts.matched += 1;
      files.push({
        path: displayPath(current.relative, entry.name),
        kind,
        size: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      });
    }
  }

  return {
    root,
    kinds,
    files,
    counts,
    truncated,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function tableSafe(value) {
  return String(value).replace(/\|/gu, "\\|");
}

export function createMediaInventoryHandler({ sourceStore, artifactsDir }) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("媒体清单需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "media.inventory": async ({ run, params }) => {
      const roots = (await sourceStore.list()).roots;
      const root = await resolveScoutRoot(params.root, roots);
      const scan = await scanMediaDirectory({
        root,
        kinds: params.kinds,
        maxFiles: params.maxFiles,
      });
      const lines = [
        "# 媒体素材清单",
        "",
        `- 目录：${root}`,
        `- 类型：${MEDIA_KIND_LABELS[scan.kinds] ?? scan.kinds}`,
        `- 找到：${scan.files.length} 个文件，共 ${formatSize(scan.totalBytes)}`,
        `- 扫描：${scan.counts.files} 个文件 / ${scan.counts.dirs} 个目录`,
        ...(scan.truncated ? ["- 注意：达到数量或深度上限，结果已截断"] : []),
        "",
      ];
      if (scan.files.length) {
        lines.push("| 类型 | 大小 | 修改时间 | 文件 |", "| --- | --- | --- | --- |");
        for (const file of scan.files) {
          lines.push(
            `| ${MEDIA_KIND_LABELS[file.kind]} | ${formatSize(file.size)} | `
            + `${file.modifiedAt.slice(0, 10)} | ${tableSafe(file.path)} |`,
          );
        }
      } else {
        lines.push("没有找到符合类型的素材。");
      }
      lines.push("", "");

      const directory = path.join(artifactsDir, String(run.id).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "media-inventory.md");
      const text = lines.join("\n");
      await writeFile(file, text, { encoding: "utf8", mode: 0o600 });

      return {
        artifacts: [{
          slot: "inventory",
          label: "素材清单",
          path: file,
          bytes: Buffer.byteLength(text, "utf8"),
        }],
        logs: [
          `扫描 ${scan.counts.files} 个文件，保留 ${scan.files.length} 个媒体文件`,
          `合计 ${formatSize(scan.totalBytes)}${scan.truncated ? "（结果已截断）" : ""}`,
        ],
      };
    },
  });
}

export const AUDIO_FORMATS = Object.freeze({
  m4a: {
    label: "M4A (AAC 192k)",
    extension: "m4a",
    codec: ["-c:a", "aac", "-b:a", "192k"],
  },
  mp3: {
    label: "MP3 (LAME 192k)",
    extension: "mp3",
    codec: ["-c:a", "libmp3lame", "-b:a", "192k"],
  },
  wav: {
    label: "WAV (PCM 16-bit)",
    extension: "wav",
    codec: ["-c:a", "pcm_s16le"],
  },
});

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

// Audio extraction is the first pipeline that really invokes FFmpeg. It probes
// the source first, refuses files without an audio track, and removes a partial
// output when the encoder fails so the run never points at a broken artifact.
export function createAudioExtractHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("音频提取需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("音频提取需要媒体工具探测");

  return Object.freeze({
    "media.extract-audio": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const format = AUDIO_FORMATS[params.format];
      if (!format) throw new Error("音频格式无效");
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);

      let media;
      try {
        media = await probeMediaFile({
          ffprobePath: tools.ffprobe.path,
          filePath: source,
          runner,
        });
      } catch (error) {
        throw new Error(`无法读取媒体信息：${error.message}`);
      }
      if (!media.audio) throw new Error("源文件没有音频轨");

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `audio.${format.extension}`);
      const timeoutMs = media.duration
        ? Math.min(Math.max(Math.ceil(media.duration * 3_000), 60_000), 900_000)
        : 300_000;
      const args = [
        "-hide_banner", "-nostdin", "-y",
        "-i", source,
        "-vn", "-map", "0:a:0",
        ...format.codec,
        file,
      ];
      try {
        await runMediaTool({
          command: tools.ffmpeg.path,
          args,
          timeoutMs,
          runner,
        });
      } catch (error) {
        await rm(file, { force: true }).catch(() => {});
        const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
        throw new Error(`音频提取失败：${detail}`);
      }

      let output;
      try {
        output = await stat(file);
      } catch {
        throw new Error("音频提取失败：没有生成输出文件");
      }
      if (!output.isFile() || output.size === 0) {
        await rm(file, { force: true }).catch(() => {});
        throw new Error("音频提取失败：输出文件为空");
      }

      const audio = media.audio;
      return {
        artifacts: [{
          slot: "audio",
          label: `音频（${format.label}）`,
          path: file,
          bytes: output.size,
        }],
        logs: [
          `源文件：${path.basename(source)}`,
          `时长：${durationText(media.duration)}；音频：${audio.codec || "未知"} / `
            + `${audio.sampleRate ?? "?"} Hz / ${audio.channels ?? "?"} 声道`,
          `${format.label}，${formatSize(output.size)}`,
        ],
      };
    },
  });
}
