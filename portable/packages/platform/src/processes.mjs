import { spawn } from "node:child_process";

import { buildSpawnOptions } from "./paths.mjs";

const processStates = new WeakMap();

export async function startManagedProcess(executable, args = [], options = {}) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new TypeError("A process executable is required");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Process arguments must be an array of strings");
  }

  const platform = options.platform ?? process.platform;
  if (options.shutdownMessage !== undefined && typeof options.shutdownMessage !== "string") {
    throw new TypeError("shutdownMessage must be a string");
  }
  if (
    options.shutdownMessage &&
    options.stdio !== undefined &&
    options.stdio !== "pipe" &&
    (!Array.isArray(options.stdio) || options.stdio[0] !== "pipe")
  ) {
    throw new TypeError("A shutdownMessage requires piped standard input");
  }
  const child = spawn(
    executable,
    args,
    buildSpawnOptions(platform, {
      cwd: options.cwd,
      env: options.env,
      stdio:
        options.stdio ??
        (options.shutdownMessage ? ["pipe", "ignore", "ignore"] : "ignore"),
    }),
  );

  let resolveExit;
  let rejectExit;
  const exit = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  exit.catch(() => {});
  const state = { exit, settled: false, shutdownMessage: options.shutdownMessage };
  processStates.set(child, state);
  child.once("error", (error) => {
    state.settled = true;
    rejectExit(error);
  });
  child.once("exit", (code, signal) => {
    state.settled = true;
    resolveExit({ code, signal });
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

export async function waitForManagedProcess(child) {
  const state = processStates.get(child);
  if (!state) throw new TypeError("Process was not started by this platform adapter");
  return state.exit;
}

export async function stopManagedProcess(child, options = {}) {
  const state = processStates.get(child);
  if (!state) throw new TypeError("Process was not started by this platform adapter");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a non-negative number");
  }
  if (state.settled) return state.exit;

  if (state.shutdownMessage && child.stdin?.writable) {
    child.stdin.end(state.shutdownMessage + "\n");
  } else {
    child.kill(options.signal ?? "SIGTERM");
  }
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([state.exit, timedOut]);
    if (result) return result;
    if (!state.settled) child.kill("SIGKILL");
    return await state.exit;
  } finally {
    clearTimeout(timer);
  }
}
