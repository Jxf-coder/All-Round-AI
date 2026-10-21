import { setTimeout as wait } from "node:timers/promises";

import { listDirectory, readTextFile } from "./local-files.mjs";

// ---------------------------------------------------------------------------
// Desk side of the command channel.
//
// The agent long-polls the runtime, executes one read-only command against its
// configured roots and posts the result back. It never opens an inbound port,
// so a workstation behind NAT can still serve the workbench.
// ---------------------------------------------------------------------------

const COMMAND_TYPES = new Set(["files.list", "files.read"]);

function unauthorized() {
  const error = new Error("设备凭据已失效，请重新配对");
  error.code = "DEVICE_UNAUTHORIZED";
  return error;
}

export async function fetchNextCommand({
  config,
  waitMs = 10_000,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
}) {
  const response = await fetchImpl(
    `${config.serverUrl}/api/devices/commands?wait=${Math.max(1_000, Math.round(waitMs))}`,
    {
      headers: { accept: "application/json", authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(waitMs + timeoutMs),
    },
  );
  if (response.status === 401) throw unauthorized();
  if (!response.ok) throw new Error(`读取设备命令失败（HTTP ${response.status}）`);
  const body = await response.json();
  return body?.command ?? null;
}

export async function executeCommand({ config, command }) {
  if (!command || typeof command.type !== "string") throw new Error("设备命令格式无效");
  if (!COMMAND_TYPES.has(command.type)) throw new Error(`不支持的设备命令：${command.type}`);
  if (!Array.isArray(config.roots) || config.roots.length === 0) {
    throw new Error("设备没有配置允许访问的目录，请重新配对并添加 --root");
  }
  const target = command.payload?.path;
  if (typeof target !== "string" || target.trim() === "") throw new Error("设备命令缺少路径");
  if (command.type === "files.list") {
    return listDirectory({ roots: config.roots, target });
  }
  return readTextFile({ roots: config.roots, target });
}

export async function submitResult({
  config,
  commandId,
  ok,
  result,
  error,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  const response = await fetchImpl(
    `${config.serverUrl}/api/devices/commands/${encodeURIComponent(commandId)}/result`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ ok, result: result ?? null, error: error ?? null }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (response.status === 401) throw unauthorized();
  if (!response.ok) throw new Error(`回传设备结果失败（HTTP ${response.status}）`);
  return true;
}

export async function pollOnce({ config, waitMs = 10_000, fetchImpl = globalThis.fetch }) {
  const command = await fetchNextCommand({ config, waitMs, fetchImpl });
  if (!command) return { executed: false, command: null };
  try {
    const result = await executeCommand({ config, command });
    await submitResult({ config, commandId: command.id, ok: true, result, fetchImpl });
    return { executed: true, command, ok: true };
  } catch (error) {
    const message = error.message || "设备执行失败";
    await submitResult({ config, commandId: command.id, ok: false, error: message, fetchImpl })
      .catch(() => {});
    return { executed: true, command, ok: false, error: message };
  }
}

export async function runCommandLoop({
  config,
  signal,
  waitMs = 10_000,
  retryMs = 5_000,
  fetchImpl = globalThis.fetch,
  onCommand = () => {},
  onError = () => {},
}) {
  let handled = 0;
  while (!signal?.aborted) {
    try {
      const outcome = await pollOnce({ config, waitMs, fetchImpl });
      if (outcome.executed) {
        handled += 1;
        onCommand(outcome);
      }
    } catch (error) {
      if (error.code === "DEVICE_UNAUTHORIZED") throw error;
      onError(error);
      try {
        await wait(retryMs, undefined, signal ? { signal } : undefined);
      } catch {
        break;
      }
    }
  }
  return { handled };
}
