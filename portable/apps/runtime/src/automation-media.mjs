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

export const VIDEO_HEIGHTS = Object.freeze([1080, 720, 540, 360]);

// Normalising is the step every distribution target needs: one H.264/AAC MP4
// at a known height, plus an optional poster frame. The source is never
// upscaled, and a failed encode leaves neither a broken video nor a cover.
export function createVideoNormalizeHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("视频规格化需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("视频规格化需要媒体工具探测");

  return Object.freeze({
    "media.normalize-video": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const requestedHeight = Number(params.height ?? 1080);
      if (!VIDEO_HEIGHTS.includes(requestedHeight)) throw new Error("目标高度无效");
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
      if (!media.video) throw new Error("源文件没有视频轨");

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const videoFile = path.join(directory, "video.mp4");
      const coverFile = path.join(directory, "cover.jpg");
      const wantedCover = params.cover !== false;
      await rm(coverFile, { force: true }).catch(() => {});

      // Never upscale: a 480p source stays 480p even when 1080p is requested.
      const sourceHeight = Number(media.video.height) || 0;
      const scaled = sourceHeight > 0 ? Math.min(requestedHeight, sourceHeight) : requestedHeight;
      const evenHeight = scaled % 2 === 0 ? scaled : scaled - 1;
      const timeoutMs = media.duration
        ? Math.min(Math.max(Math.ceil(media.duration * 4_000), 120_000), 1_800_000)
        : 600_000;
      const encodeArgs = [
        "-hide_banner", "-nostdin", "-y",
        "-i", source,
        "-vf", `scale=-2:${evenHeight}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "160k",
        videoFile,
      ];

      try {
        await runMediaTool({
          command: tools.ffmpeg.path,
          args: encodeArgs,
          timeoutMs,
          runner,
        });
      } catch (error) {
        await rm(videoFile, { force: true }).catch(() => {});
        const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
        throw new Error(`视频规格化失败：${detail}`);
      }

      let output;
      try {
        output = await stat(videoFile);
      } catch {
        throw new Error("视频规格化失败：没有生成输出文件");
      }
      if (!output.isFile() || output.size === 0) {
        await rm(videoFile, { force: true }).catch(() => {});
        throw new Error("视频规格化失败：输出文件为空");
      }

      const artifacts = [{
        slot: "video",
        label: "规格化视频（H.264 / AAC）",
        path: videoFile,
        bytes: output.size,
      }];
      let coverBytes = 0;
      if (wantedCover) {
        const at = media.duration ? Math.min(1, Math.max(0.1, media.duration / 3)) : 0.5;
        try {
          await runMediaTool({
            command: tools.ffmpeg.path,
            args: [
              "-hide_banner", "-nostdin", "-y",
              "-ss", at.toFixed(2),
              "-i", videoFile,
              "-frames:v", "1",
              "-q:v", "2",
              coverFile,
            ],
            timeoutMs: 60_000,
            runner,
          });
          const cover = await stat(coverFile);
          if (!cover.isFile() || cover.size === 0) throw new Error("封面为空");
          coverBytes = cover.size;
          artifacts.push({
            slot: "cover",
            label: "封面图（JPEG）",
            path: coverFile,
            bytes: cover.size,
          });
        } catch (error) {
          await rm(videoFile, { force: true }).catch(() => {});
          await rm(coverFile, { force: true }).catch(() => {});
          const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
          throw new Error(`封面抽取失败：${detail}`);
        }
      }

      const resolution = media.video.width && media.video.height
        ? `${media.video.width}×${media.video.height}`
        : "未知分辨率";
      return {
        artifacts,
        logs: [
          `源文件：${path.basename(source)}；${resolution}，时长 ${durationText(media.duration)}`,
          `目标高度 ${evenHeight}p，${media.video.codec || "未知编码"} → H.264 / AAC`,
          `视频 ${formatSize(output.size)}${coverBytes ? `；封面 ${formatSize(coverBytes)}` : "；未抽取封面"}`,
        ],
      };
    },
  });
}

export const VIDEO_SPECS = Object.freeze({
  landscape: { ratio: "16:9", label: "横屏 16:9", file: "landscape.mp4", default: true },
  vertical: { ratio: "9:16", label: "竖屏 9:16", file: "vertical.mp4", default: true },
  square: { ratio: "1:1", label: "方屏 1:1", file: "square.mp4", default: false },
});

export const VIDEO_QUALITIES = Object.freeze([1080, 720, 540]);

function specDimensions(ratio, base) {
  if (ratio === "16:9") return { width: Math.round((base * 16) / 9), height: base };
  if (ratio === "9:16") return { width: base, height: Math.round((base * 16) / 9) };
  return { width: base, height: base };
}

// Distribution needs exact canvases, so this pipeline fits the source inside
// each platform frame and pads the remainder instead of cropping content. It is
// the only media step allowed to upscale, because a platform spec is fixed.
export function createVideoReframeHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("多规格转码需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("多规格转码需要媒体工具探测");

  return Object.freeze({
    "media.reframe-video": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const quality = Number(params.quality ?? 720);
      if (!VIDEO_QUALITIES.includes(quality)) throw new Error("目标规格无效");
      const targets = Object.entries(VIDEO_SPECS)
        .filter(([slot, spec]) => (params[slot] ?? spec.default) === true);
      if (!targets.length) throw new Error("至少要选择一种输出规格");
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
      if (!media.video) throw new Error("源文件没有视频轨");

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const timeoutMs = media.duration
        ? Math.min(Math.max(Math.ceil(media.duration * 4_000), 120_000), 1_800_000)
        : 600_000;
      const artifacts = [];
      const produced = [];
      try {
        for (const [slot, spec] of targets) {
          const { width, height } = specDimensions(spec.ratio, quality);
          const file = path.join(directory, spec.file);
          produced.push(file);
          await rm(file, { force: true }).catch(() => {});
          const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
            + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
          await runMediaTool({
            command: tools.ffmpeg.path,
            args: [
              "-hide_banner", "-nostdin", "-y",
              "-i", source,
              "-vf", filter,
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
              "-pix_fmt", "yuv420p", "-movflags", "+faststart",
              "-c:a", "aac", "-b:a", "160k",
              file,
            ],
            timeoutMs,
            runner,
          });
          let output;
          try {
            output = await stat(file);
          } catch {
            throw new Error(`${spec.label} 没有生成输出文件`);
          }
          if (!output.isFile() || output.size === 0) throw new Error(`${spec.label} 输出文件为空`);
          artifacts.push({
            slot,
            label: `${spec.label}（${width}×${height}）`,
            path: file,
            bytes: output.size,
          });
        }
      } catch (error) {
        await Promise.all(produced.map((file) => rm(file, { force: true }).catch(() => {})));
        const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
        throw new Error(`多规格转码失败：${detail}`);
      }

      const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
      const resolution = media.video.width && media.video.height
        ? `${media.video.width}×${media.video.height}`
        : "未知分辨率";
      return {
        artifacts,
        logs: [
          `源文件：${path.basename(source)}；${resolution}，时长 ${durationText(media.duration)}`,
          `规格：${artifacts.map((artifact) => artifact.label).join("；")}`,
          `输出 ${artifacts.length} 个文件，共 ${formatSize(total)}`,
        ],
      };
    },
  });
}

export const SRT_LIMITS = Object.freeze({ cues: 500, cueText: 500 });

function parseTimestamp(value) {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d),(\d{3})$/u.exec(String(value).trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return (((Number(hours) * 60) + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis);
}

function formatTimestamp(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:`
    + `${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

// Subtitles arrive as pasted SRT. Parsing and re-emitting normalises indexes
// and line endings, so a later cue edit cannot silently shift the track.
export function parseSrt(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("字幕内容不能为空");
  const blocks = input.replace(/\r\n?/gu, "\n").trim().split(/\n{2,}/u);
  if (blocks.length > SRT_LIMITS.cues) throw new Error(`字幕最多 ${SRT_LIMITS.cues} 条`);
  const cues = [];
  blocks.forEach((block, index) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timeIndex = /^\d+$/u.test(lines[0]?.trim() ?? "") ? 1 : 0;
    const timing = /^(\d{1,2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2},\d{3})/u
      .exec(lines[timeIndex]?.trim() ?? "");
    if (!timing) {
      throw new Error(`第 ${index + 1} 条字幕缺少时间码（HH:MM:SS,mmm --> HH:MM:SS,mmm）`);
    }
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (start === null || end === null || end <= start) {
      throw new Error(`第 ${index + 1} 条字幕的时间范围无效`);
    }
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!text) throw new Error(`第 ${index + 1} 条字幕没有文字`);
    if (text.length > SRT_LIMITS.cueText) {
      throw new Error(`第 ${index + 1} 条字幕超过 ${SRT_LIMITS.cueText} 个字符`);
    }
    if (cues.length && start < cues[cues.length - 1].start) {
      throw new Error("字幕时间码必须按从前到后排列");
    }
    cues.push({ start, end, text });
  });
  return cues;
}

export function formatSrt(cues) {
  if (!Array.isArray(cues) || !cues.length) throw new Error("字幕内容不能为空");
  return `${cues.map((cue, index) => `${index + 1}\n`
    + `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`).join("\n\n")}\n`;
}

// Soft subtitles keep the picture untouched: the video and audio streams are
// copied, and only the new subtitle track is encoded to mov_text.
export function createSubtitleMuxHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("字幕封装需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("字幕封装需要媒体工具探测");

  return Object.freeze({
    "media.mux-subtitles": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const cues = parseSrt(params.subtitles);
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
      if (!media.video) throw new Error("源文件没有视频轨");
      const lastEnd = cues[cues.length - 1].end;
      if (media.duration && lastEnd > Math.ceil(media.duration * 1_000) + 1_000) {
        throw new Error(`字幕超出视频时长（最后一条结束于 ${(lastEnd / 1_000).toFixed(1)} 秒）`);
      }

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const srtFile = path.join(directory, "subtitles.srt");
      const videoFile = path.join(directory, "subtitled.mp4");
      const text = formatSrt(cues);
      await writeFile(srtFile, text, { encoding: "utf8", mode: 0o600 });
      await rm(videoFile, { force: true }).catch(() => {});

      const timeoutMs = media.duration
        ? Math.min(Math.max(Math.ceil(media.duration * 1_000), 60_000), 600_000)
        : 180_000;
      try {
        await runMediaTool({
          command: tools.ffmpeg.path,
          args: [
            "-hide_banner", "-nostdin", "-y",
            "-i", source,
            "-i", srtFile,
            "-map", "0", "-map", "1:0",
            "-c", "copy", "-c:s", "mov_text",
            "-metadata:s:s:0", "language=chi",
            videoFile,
          ],
          timeoutMs,
          runner,
        });
      } catch (error) {
        await rm(videoFile, { force: true }).catch(() => {});
        await rm(srtFile, { force: true }).catch(() => {});
        const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
        throw new Error(`字幕封装失败：${detail}`);
      }

      let output;
      try {
        output = await stat(videoFile);
      } catch {
        await rm(srtFile, { force: true }).catch(() => {});
        throw new Error("字幕封装失败：没有生成输出文件");
      }
      if (!output.isFile() || output.size === 0) {
        await rm(videoFile, { force: true }).catch(() => {});
        await rm(srtFile, { force: true }).catch(() => {});
        throw new Error("字幕封装失败：输出文件为空");
      }

      const srtBytes = Buffer.byteLength(text, "utf8");
      return {
        artifacts: [
          { slot: "video", label: "字幕视频（MP4 / mov_text）", path: videoFile, bytes: output.size },
          { slot: "subtitles", label: "字幕文件（SRT）", path: srtFile, bytes: srtBytes },
        ],
        logs: [
          `源文件：${path.basename(source)}，时长 ${durationText(media.duration)}`,
          `字幕 ${cues.length} 条，最后一条结束于 ${(lastEnd / 1_000).toFixed(1)} 秒`,
          `视频 ${formatSize(output.size)}；SRT ${formatSize(srtBytes)}`,
        ],
      };
    },
  });
}

// Audio extraction probes the source first, refuses files without an audio
// track, and removes a partial output when the encoder fails so the run never
// points at a broken artifact.
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
