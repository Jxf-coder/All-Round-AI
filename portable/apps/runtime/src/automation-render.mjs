import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { probeMediaFile, runMediaTool } from "./media-tools.mjs";
import { resolveAllowedFile } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Final assembly: several clips become one MP4 on a fixed canvas.
//
// The clips may differ in size, frame rate and audio layout, so every one is
// normalised first (fit + pad, 30 fps, stereo 48 kHz, exact duration) and only
// then joined. Transitions are optional: with `crossfade` the chain uses xfade
// and acrossfade, otherwise the concat filter glues the normalised streams.
// A background track is optional and mixed under the clip audio.
// ---------------------------------------------------------------------------

export const RENDER_LIMITS = Object.freeze({
  clips: 12,
  lineChars: 400,
  totalSeconds: 900,
});

export const RENDER_HEIGHT = 720;

export const RENDER_ASPECTS = Object.freeze({
  landscape: { label: "横屏 16:9" },
  vertical: { label: "竖屏 9:16" },
  square: { label: "方屏 1:1" },
});

export const RENDER_TRANSITIONS = Object.freeze({
  none: { label: "直接拼接", duration: 0 },
  crossfade: { label: "淡入淡出", duration: 0.6 },
});

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function durationText(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One absolute path per line; `#` starts a comment so a playlist can be pasted
// with notes. Two clips are the minimum, because a single clip is a transcode.
export function parseClipList(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("片段列表不能为空");
  const clips = input
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (clips.length < 2) throw new Error("至少要两个片段才能合成");
  if (clips.length > RENDER_LIMITS.clips) {
    throw new Error(`一次最多合成 ${RENDER_LIMITS.clips} 个片段`);
  }
  for (const clip of clips) {
    if (clip.length > RENDER_LIMITS.lineChars) throw new Error("片段路径过长");
  }
  return clips;
}

export function renderCanvas(aspect) {
  if (aspect === "landscape") return { width: Math.round((RENDER_HEIGHT * 16) / 9), height: RENDER_HEIGHT };
  if (aspect === "vertical") return { width: RENDER_HEIGHT, height: Math.round((RENDER_HEIGHT * 16) / 9) };
  if (aspect === "square") return { width: RENDER_HEIGHT, height: RENDER_HEIGHT };
  throw new Error("画布规格无效");
}

// Pure filter builder: the handler probes the clips, this decides how they are
// fitted, joined and mixed. Kept separate so the graph can be asserted without
// spawning FFmpeg.
export function buildCompositeFilter({
  clips,
  canvas,
  transitionSeconds = 0,
  hasBgm = false,
  bgmVolume = 25,
}) {
  if (!Array.isArray(clips) || clips.length < 2) throw new Error("至少要两个片段才能合成");
  const lines = [];
  clips.forEach((clip, index) => {
    lines.push(
      `[${index}:v]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,`
      + `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,`
      + `fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
    );
    if (clip.hasAudio) {
      lines.push(
        `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`
        + `apad=whole_dur=${clip.duration.toFixed(3)},atrim=0:${clip.duration.toFixed(3)},`
        + `asetpts=PTS-STARTPTS[a${index}]`,
      );
    } else {
      // Silent clips still need a stream of the exact same length so concat and
      // acrossfade stay in sync with the picture.
      lines.push(
        `anullsrc=r=48000:cl=stereo,atrim=0:${clip.duration.toFixed(3)},`
        + `asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
  });

  let video = "v0";
  let audio = "a0";
  if (transitionSeconds > 0) {
    let offset = 0;
    for (let index = 1; index < clips.length; index += 1) {
      offset += clips[index - 1].duration - transitionSeconds;
      const last = index === clips.length - 1;
      const videoOut = last ? "vcat" : `vx${index}`;
      const audioOut = last ? "acat" : `ax${index}`;
      lines.push(
        `[${video}][v${index}]xfade=transition=fade:`
        + `duration=${transitionSeconds}:offset=${offset.toFixed(3)}[${videoOut}]`,
      );
      lines.push(`[${audio}][a${index}]acrossfade=d=${transitionSeconds}:c1=tri:c2=tri[${audioOut}]`);
      video = videoOut;
      audio = audioOut;
    }
  } else {
    const pairs = clips.map((_, index) => `[v${index}][a${index}]`).join("");
    lines.push(`${pairs}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
    video = "vcat";
    audio = "acat";
  }

  if (hasBgm) {
    const bgmIndex = clips.length;
    // The BGM input is looped by the handler, so amix can stop with the clips.
    lines.push(
      `[${bgmIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`
      + `volume=${(bgmVolume / 100).toFixed(2)}[bgm]`,
    );
    lines.push(`[${audio}][bgm]amix=inputs=2:duration=first:normalize=0[amix]`);
    audio = "amix";
  }

  return { filter: lines.join(";"), videoLabel: video, audioLabel: audio };
}

export function createRenderHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("影音成片需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("影音成片需要媒体工具探测");

  return Object.freeze({
    "media.render": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const aspect = params.aspect ?? "landscape";
      if (!RENDER_ASPECTS[aspect]) throw new Error("画布规格无效");
      const canvas = renderCanvas(aspect);
      const transition = RENDER_TRANSITIONS[params.transition ?? "none"];
      if (!transition) throw new Error("转场方式无效");
      const bgmVolume = Number(params.bgmVolume ?? 25);
      if (!Number.isFinite(bgmVolume) || bgmVolume < 0 || bgmVolume > 100) {
        throw new Error("背景音乐音量必须是 0 到 100 之间的数字");
      }

      const paths = parseClipList(params.clips);
      const roots = (await sourceStore.list()).roots;
      const clipFiles = [];
      for (const clip of paths) clipFiles.push(await resolveAllowedFile(clip, roots));
      const bgmPath = typeof params.bgm === "string" && params.bgm.trim()
        ? await resolveAllowedFile(params.bgm.trim(), roots)
        : null;

      const clips = [];
      for (const file of clipFiles) {
        let media;
        try {
          media = await probeMediaFile({ ffprobePath: tools.ffprobe.path, filePath: file, runner });
        } catch (error) {
          throw new Error(`无法读取媒体信息：${error.message}`);
        }
        if (!media.video) throw new Error(`片段没有视频轨：${path.basename(file)}`);
        if (!media.duration || media.duration <= 0.2) {
          throw new Error(`片段时长无效：${path.basename(file)}`);
        }
        clips.push({
          file,
          name: path.basename(file),
          duration: media.duration,
          hasAudio: Boolean(media.audio),
          width: media.video.width,
          height: media.video.height,
        });
      }

      const overlapped = transition.duration * (clips.length - 1);
      const total = clips.reduce((sum, clip) => sum + clip.duration, 0) - overlapped;
      if (total > RENDER_LIMITS.totalSeconds) {
        throw new Error(`成片总时长超过 ${RENDER_LIMITS.totalSeconds / 60} 分钟`);
      }
      if (transition.duration > 0) {
        const tooShort = clips.find((clip) => clip.duration <= transition.duration + 0.3);
        if (tooShort) {
          throw new Error(`片段太短，无法使用${transition.label}：${tooShort.name}`);
        }
      }

      let bgm = null;
      if (bgmPath) {
        let media;
        try {
          media = await probeMediaFile({ ffprobePath: tools.ffprobe.path, filePath: bgmPath, runner });
        } catch (error) {
          throw new Error(`无法读取背景音乐：${error.message}`);
        }
        if (!media.audio) throw new Error("背景音乐没有音频轨");
        bgm = { file: bgmPath, name: path.basename(bgmPath), duration: media.duration };
      }

      const { filter, videoLabel, audioLabel } = buildCompositeFilter({
        clips,
        canvas,
        transitionSeconds: transition.duration,
        hasBgm: Boolean(bgm),
        bgmVolume,
      });

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const videoFile = path.join(directory, "final.mp4");
      const reportFile = path.join(directory, "render-report.json");
      await rm(videoFile, { force: true }).catch(() => {});

      const args = ["-hide_banner", "-nostdin", "-y"];
      for (const clip of clips) args.push("-i", clip.file);
      if (bgm) args.push("-stream_loop", "-1", "-i", bgm.file);
      args.push(
        "-filter_complex", filter,
        "-map", `[${videoLabel}]`,
        "-map", `[${audioLabel}]`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "160k",
        videoFile,
      );

      const timeoutMs = Math.min(Math.max(Math.ceil(total * 4_000), 120_000), 1_800_000);
      try {
        await runMediaTool({ command: tools.ffmpeg.path, args, timeoutMs, runner });
      } catch (error) {
        await rm(videoFile, { force: true }).catch(() => {});
        const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
        throw new Error(`影音成片失败：${detail}`);
      }

      let output;
      try {
        output = await stat(videoFile);
      } catch {
        throw new Error("影音成片失败：没有生成输出文件");
      }
      if (!output.isFile() || output.size === 0) {
        await rm(videoFile, { force: true }).catch(() => {});
        throw new Error("影音成片失败：输出文件为空");
      }

      const report = {
        clips: clips.map((clip, index) => ({
          index: index + 1,
          name: clip.name,
          seconds: Number(clip.duration.toFixed(2)),
          has_audio: clip.hasAudio,
          width: clip.width,
          height: clip.height,
        })),
        canvas: { ...canvas, aspect },
        transition: { key: params.transition ?? "none", seconds: transition.duration },
        bgm: bgm
          ? { name: bgm.name, seconds: bgm.duration, volume: bgmVolume }
          : null,
        seconds: Number(total.toFixed(2)),
        bytes: output.size,
        out: videoFile,
      };
      const reportText = `${JSON.stringify(report, null, 2)}\n`;
      try {
        await writeFile(reportFile, reportText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await rm(videoFile, { force: true }).catch(() => {});
        throw new Error(`写入合成报告失败：${error.message}`);
      }

      return {
        artifacts: [
          { slot: "video", label: "成片（MP4 / H.264）", path: videoFile, bytes: output.size },
          {
            slot: "report",
            label: "合成报告（JSON）",
            path: reportFile,
            bytes: Buffer.byteLength(reportText, "utf8"),
          },
        ],
        logs: [
          `${clips.length} 个片段，合计 ${durationText(total)}；画布 ${canvas.width}×${canvas.height}`,
          `转场：${transition.label}${bgm ? `；背景音乐 ${bgm.name}（${bgmVolume}%）` : ""}`,
          `成片 ${formatSize(output.size)}`,
        ],
      };
    },
  });
}
