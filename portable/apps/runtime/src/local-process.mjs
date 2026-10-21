import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Local process execution for the desk agent.
//
// Only executables an operator named at pairing time may run, matched on their
// resolved real path. Spawning never uses a shell, arguments stay literal, the
// environment is reduced to what a process needs to start, and both output
// streams are capped so a chatty program cannot exhaust the agent.
// ---------------------------------------------------------------------------

export const DEFAULT_PROCESS_TIMEOUT_MS = 10_000;
export const MAX_PROCESS_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_PROCESS_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 4_096;

export class LocalProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalProcessError";
    this.code = code;
  }
}

function samePath(left, right, platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export async function resolveAllowedProgram({ allow, command, platform = process.platform }) {
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new LocalProcessError("NO_ALLOWLIST", "设备没有配置允许运行的程序，请重新配对并添加 --allow");
  }
  if (typeof command !== "string" || command.trim() === "" || !path.isAbsolute(command)) {
    throw new LocalProcessError("BAD_COMMAND", "程序路径必须是绝对路径");
  }
  const real = await realpath(command).catch(() => {
    throw new LocalProcessError("NOT_FOUND", "程序不存在");
  });
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new LocalProcessError("NOT_A_FILE", "程序路径不是文件");
  for (const entry of allow) {
    if (typeof entry !== "string" || !path.isAbsolute(entry)) continue;
    const realEntry = await realpath(entry).catch(() => null);
    if (realEntry && samePath(realEntry, real, platform)) return real;
  }
  throw new LocalProcessError("NOT_ALLOWED", "程序不在允许清单里");
}

function minimalEnvironment(platform) {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (platform === "win32") {
    // Windows needs these to resolve system DLLs; they carry no credentials.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
    if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  }
  return env;
}

function validateArguments(args) {
  if (!Array.isArray(args)) throw new LocalProcessError("BAD_ARGS", "参数必须是数组");
  if (args.length > MAX_PROCESS_ARGUMENTS) {
    throw new LocalProcessError("BAD_ARGS", `参数不能超过 ${MAX_PROCESS_ARGUMENTS} 个`);
  }
  for (const argument of args) {
    if (typeof argument !== "string") throw new LocalProcessError("BAD_ARGS", "参数必须是字符串");
    if (argument.length > MAX_ARGUMENT_LENGTH) throw new LocalProcessError("BAD_ARGS", "单个参数过长");
    if (argument.includes("\0")) throw new LocalProcessError("BAD_ARGS", "参数不能包含空字符");
  }
  return args;
}

export function runProcess({
  program,
  args = [],
  cwd,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  platform = process.platform,
  spawnImpl = spawn,
}) {
  if (typeof program !== "string" || !path.isAbsolute(program)) {
    throw new LocalProcessError("BAD_COMMAND", "程序路径必须是绝对路径");
  }
  validateArguments(args);
  if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd))) {
    throw new LocalProcessError("BAD_CWD", "工作目录必须是绝对路径");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new LocalProcessError("BAD_TIMEOUT", `超时必须在 1000 到 ${MAX_PROCESS_TIMEOUT_MS} 毫秒之间`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new LocalProcessError("BAD_LIMIT", "输出上限必须是正整数");
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(program, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalEnvironment(platform),
      });
    } catch (error) {
      reject(new LocalProcessError("SPAWN_FAILED", error.message));
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    function collect(stream, chunk) {
      if (sizes[stream] >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - sizes[stream];
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      sizes[stream] += slice.length;
      chunks[stream].push(slice);
    }

    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Some programs ignore SIGTERM; make sure the agent is not held hostage.
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LocalProcessError("SPAWN_FAILED", error.message));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        program,
        code,
        signal,
        timedOut,
        truncated,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });
  });
}
