import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveDataDirectory } from "../../../packages/platform/src/paths.mjs";
import { writeJsonFile } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Desk agent: the machine-side half of device pairing.
//
// `pair` trades a one-time ticket for a device token and stores it in a 0600
// JSON file; `heartbeat` keeps the device online. The token is never printed
// and never logged. All requests go to the instance the operator names on the
// command line, so an agent cannot silently attach to a different server.
// ---------------------------------------------------------------------------

const CONFIG_NAME = "desk-agent.json";
const MIN_TOKEN_LENGTH = 20;

export function defaultAgentConfigPath(options = {}) {
  return path.join(resolveDataDirectory(options), CONFIG_NAME);
}

function normalizeServerUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("缺少服务器地址");
  }
  const trimmed = value.trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`服务器地址无效：${value}`);
  }
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("服务器地址必须是 http(s)");
  return parsed.origin + parsed.pathname.replace(/\/+$/u, "");
}

async function readError(response) {
  const body = await response.json().catch(() => null);
  return body?.error ? `${body.error}` : `HTTP ${response.status}`;
}

export async function pairDevice({
  serverUrl,
  ticket,
  name,
  platform = process.platform,
  version,
  capabilities = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const base = normalizeServerUrl(serverUrl);
  if (typeof ticket !== "string" || ticket.trim() === "") throw new Error("缺少配对票据");
  if (typeof name !== "string" || name.trim() === "") throw new Error("缺少设备名称");
  const response = await fetchImpl(`${base}/api/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ticket: ticket.trim(),
      name: name.trim(),
      platform,
      version,
      capabilities,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`配对失败（HTTP ${response.status}）：${await readError(response)}`);
  }
  const body = await response.json();
  if (!body?.device?.id || typeof body.token !== "string" || body.token.length < MIN_TOKEN_LENGTH) {
    throw new Error("服务器返回的配对结果不完整");
  }
  return { serverUrl: base, device: body.device, token: body.token };
}

export async function saveAgentConfig({ filePath, serverUrl, device, token }) {
  if (!path.isAbsolute(filePath)) throw new TypeError("配置文件必须是绝对路径");
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new Error("设备令牌无效");
  }
  await writeJsonFile(filePath, {
    schema: 1,
    serverUrl: normalizeServerUrl(serverUrl),
    deviceId: device.id,
    name: device.name,
    platform: device.platform,
    pairedAt: device.pairedAt,
    token,
  });
  return { filePath, deviceId: device.id, name: device.name };
}

export async function loadAgentConfig(filePath) {
  if (!path.isAbsolute(filePath)) throw new TypeError("配置文件必须是绝对路径");
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`还没有配对：${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("设备配置不可读或已损坏，请重新配对");
  }
  if (!parsed || parsed.schema !== 1) throw new Error("设备配置格式不支持，请重新配对");
  if (typeof parsed.token !== "string" || parsed.token.length < MIN_TOKEN_LENGTH) {
    throw new Error("设备配置缺少有效令牌，请重新配对");
  }
  if (typeof parsed.deviceId !== "string" || typeof parsed.name !== "string") {
    throw new Error("设备配置缺少设备信息，请重新配对");
  }
  return {
    schema: 1,
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    deviceId: parsed.deviceId,
    name: parsed.name,
    platform: typeof parsed.platform === "string" ? parsed.platform : null,
    pairedAt: typeof parsed.pairedAt === "string" ? parsed.pairedAt : null,
    token: parsed.token,
  };
}

export async function sendHeartbeat({
  config,
  version,
  capabilities,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const body = {};
  if (version !== undefined) body.version = version;
  if (capabilities !== undefined) body.capabilities = capabilities;
  const response = await fetchImpl(`${config.serverUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) throw new Error("设备凭据已失效，请重新配对");
  if (!response.ok) throw new Error(`心跳失败（HTTP ${response.status}）：${await readError(response)}`);
  const parsed = await response.json();
  if (!parsed?.device?.id) throw new Error("服务器返回的心跳结果不完整");
  return parsed.device;
}
