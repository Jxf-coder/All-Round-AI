import { execFile } from "node:child_process";
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

async function probeBinary(name, runner) {
  if (typeof runner !== "function") throw new TypeError("媒体工具探测需要命令执行器");
  try {
    // execFile rejects with stdout/stderr on a non-zero exit; --version should
    // exit 0 on every supported build, so a rejection really means unusable.
    const { stdout } = await runner(name, ["-version"], {
      timeout: MEDIA_PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: minimalEnv(),
    });
    const version = String(stdout ?? "").split(/\r?\n/u)[0].trim().slice(0, 200);
    return { available: true, path: name, version: version || null, reason: "" };
  } catch (error) {
    let reason;
    if (error?.code === "ENOENT") reason = "未安装，或不在 PATH 里";
    else if (error?.killed || error?.signal) reason = "检测超时";
    else reason = `检测失败：${String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 200)}`;
    return { available: false, path: null, version: null, reason };
  }
}

export async function detectMediaTools({ runner = defaultRunner } = {}) {
  const [ffmpeg, ffprobe] = await Promise.all([
    probeBinary("ffmpeg", runner),
    probeBinary("ffprobe", runner),
  ]);
  return { ffmpeg, ffprobe, checkedAt: new Date().toISOString() };
}

export function createMediaToolProbe(options = {}) {
  const runner = options.runner ?? defaultRunner;
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
    inflight = detectMediaTools({ runner })
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
