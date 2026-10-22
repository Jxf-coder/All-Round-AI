import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Media tool detection. FFmpeg is an external dependency, not an npm package:
// the runtime only checks whether it exists and reports a reason when it does
// not, so a missing install disables transcoding instead of breaking startup.
//
// The probe always runs a fixed command with no shell and a minimal environment
// and caches its answer briefly; the automation panel asks on every refresh.
// ---------------------------------------------------------------------------

export const MEDIA_PROBE_TIMEOUT_MS = 5_000;
export const MEDIA_PROBE_TTL_MS = 60_000;

const execFileAsync = promisify(execFile);

function minimalEnv() {
  const env = { PATH: process.env.PATH ?? "" };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return env;
}

async function defaultRunner(command, args, options) {
  return execFileAsync(command, args, options);
}

async function probeBinary(name, path, runner) {
  if (typeof runner !== "function") throw new TypeError("媒体工具探测需要命令执行器");
  const command = typeof path === "string" && path.trim() ? path.trim() : name;
  try {
    // execFile rejects with stdout/stderr on a non-zero exit; --version should
    // exit 0 on every supported build, so a rejection really means unusable.
    const { stdout } = await runner(command, ["-version"], {
      timeout: MEDIA_PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: minimalEnv(),
    });
    const version = String(stdout ?? "").split(/\r?\n/u)[0].trim().slice(0, 200);
    return { available: true, path: command, version: version || null, reason: "" };
  } catch (error) {
    let reason;
    if (error?.code === "ENOENT") reason = "未安装，或不在 PATH 里";
    else if (error?.killed || error?.signal) reason = "检测超时";
    else reason = `检测失败：${String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 200)}`;
    return { available: false, path: null, version: null, reason };
  }
}

// FFMPEG_PATH / FFPROBE_PATH let an install live outside PATH, which is how the
// reference project supports Homebrew and custom locations.
function toolPaths(env) {
  const source = env ?? process.env;
  const pick = (name) => (typeof source[name] === "string" && source[name].trim()
    ? source[name].trim()
    : undefined);
  return {
    ffmpeg: pick("FFMPEG_PATH"),
    ffprobe: pick("FFPROBE_PATH"),
  };
}

export async function detectMediaTools({ runner = defaultRunner, env = process.env } = {}) {
  const paths = toolPaths(env);
  const [ffmpeg, ffprobe] = await Promise.all([
    probeBinary("ffmpeg", paths.ffmpeg, runner),
    probeBinary("ffprobe", paths.ffprobe, runner),
  ]);
  return { ffmpeg, ffprobe, checkedAt: new Date().toISOString() };
}

export function createMediaToolProbe(options = {}) {
  const runner = options.runner ?? defaultRunner;
  const env = options.env ?? process.env;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : MEDIA_PROBE_TTL_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  return async function probe({ refresh = false } = {}) {
    if (!refresh && cached && now() - cachedAt < ttlMs) return cached;
    // Concurrent refreshes share one spawn per binary instead of racing.
    if (inflight) return inflight;
    inflight = detectMediaTools({ runner, env })
      .then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

// Run one fixed media command. The handler supplies the binary path and the
// full argument list; nothing here goes through a shell. `cwd` lets a handler
// reference a side file (an SRT for the subtitles filter) by plain file name,
// which avoids escaping drive letters and backslashes inside a filter string.
export async function runMediaTool({
  command,
  args = [],
  timeoutMs = 120_000,
  maxBuffer = 8 * 1024 * 1024,
  cwd,
  runner = defaultRunner,
} = {}) {
  if (typeof command !== "string" || !command.trim()) throw new TypeError("缺少媒体命令");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("媒体命令参数必须是字符串数组");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new TypeError("媒体命令超时无效");
  if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd))) {
    throw new TypeError("媒体命令工作目录必须是绝对路径");
  }
  const result = await runner(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer,
    env: minimalEnv(),
    ...(cwd ? { cwd } : {}),
  });
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
  };
}

export function parseFfprobeJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw ?? ""));
  } catch {
    throw new Error("ffprobe 返回了无法解析的内容");
  }
  if (!data || typeof data !== "object") throw new Error("ffprobe 返回格式无效");
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const audioStream = streams.find((stream) => stream?.codec_type === "audio") ?? null;
  const videoStream = streams.find((stream) => stream?.codec_type === "video") ?? null;
  const duration = Number(data.format?.duration ?? audioStream?.duration);
  const size = Number(data.format?.size);
  return {
    formatName: typeof data.format?.format_name === "string" ? data.format.format_name : "",
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    audio: audioStream ? {
      codec: typeof audioStream.codec_name === "string" ? audioStream.codec_name : "",
      sampleRate: Number(audioStream.sample_rate) || null,
      channels: Number(audioStream.channels) || null,
    } : null,
    video: videoStream ? {
      codec: typeof videoStream.codec_name === "string" ? videoStream.codec_name : "",
      width: Number(videoStream.width) || null,
      height: Number(videoStream.height) || null,
    } : null,
  };
}

export async function probeMediaFile({
  ffprobePath,
  filePath,
  runner,
  timeoutMs = 30_000,
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new TypeError("缺少要探测的媒体文件");
  const result = await runMediaTool({
    command: ffprobePath || "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", filePath],
    timeoutMs,
    runner,
  });
  return parseFfprobeJson(result.stdout);
}
