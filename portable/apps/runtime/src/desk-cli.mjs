import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  defaultAgentConfigPath,
  loadAgentConfig,
  pairDevice,
  runHeartbeatLoop,
  saveAgentConfig,
  sendHeartbeat,
} from "./desk-agent.mjs";

const USAGE = `用法：
  node desk-cli.mjs pair      --server <实例地址> --ticket <配对票据> --name <设备名称> [--version <版本>] [--platform <平台>] [--capabilities a,b] [--config <文件>]
  node desk-cli.mjs heartbeat [--config <文件>] [--version <版本>]
  node desk-cli.mjs run       [--config <文件>] [--interval <秒>] [--max-backoff <秒>]
  node desk-cli.mjs status    [--config <文件>]

票据由管理员在工作台签发，十分钟内有效且只能使用一次。pair 会把设备令牌写入
配置文件（默认位于本机数据目录的 desk-agent.json，权限 0600），之后 heartbeat
用该令牌上报在线状态。run 常驻上报，网络失败按指数退避（默认 30 秒起、最长
300 秒），令牌失效则立即停止。status 只显示配对摘要，不会输出令牌。`;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printEvent(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function packageVersion() {
  try {
    const parsed = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      ticket: { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
      platform: { type: "string" },
      capabilities: { type: "string" },
      config: { type: "string" },
      interval: { type: "string" },
      "max-backoff": { type: "string" },
    },
  });
  const command = positionals[0];
  const configPath = values.config ? path.resolve(values.config) : defaultAgentConfigPath();

  if (command === "pair") {
    if (!values.server) throw new Error("pair 需要 --server");
    if (!values.ticket) throw new Error("pair 需要 --ticket");
    if (!values.name) throw new Error("pair 需要 --name");
    const capabilities = values.capabilities
      ? values.capabilities.split(",").map((entry) => entry.trim()).filter(Boolean)
      : [];
    const paired = await pairDevice({
      serverUrl: values.server,
      ticket: values.ticket,
      name: values.name,
      platform: values.platform,
      version: values.version ?? await packageVersion(),
      capabilities,
    });
    await saveAgentConfig({
      filePath: configPath,
      serverUrl: paired.serverUrl,
      device: paired.device,
      token: paired.token,
    });
    print({
      ok: true,
      config: configPath,
      serverUrl: paired.serverUrl,
      device: paired.device,
    });
  } else if (command === "heartbeat") {
    const config = await loadAgentConfig(configPath);
    const device = await sendHeartbeat({
      config,
      version: values.version ?? await packageVersion(),
    });
    print({ ok: true, device });
  } else if (command === "run") {
    const config = await loadAgentConfig(configPath);
    const intervalSeconds = values.interval === undefined ? 30 : Number(values.interval);
    const maxBackoffSeconds = values["max-backoff"] === undefined ? 300 : Number(values["max-backoff"]);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    printEvent({ ok: true, event: "started", name: config.name, intervalSeconds });
    const summary = await runHeartbeatLoop({
      config,
      intervalMs: Math.round(intervalSeconds * 1000),
      maxBackoffMs: Math.round(maxBackoffSeconds * 1000),
      signal: controller.signal,
      onBeat: (device) => printEvent({
        ok: true,
        event: "beat",
        status: device.status,
        lastSeenAt: device.lastSeenAt,
      }),
      onError: (error) => printEvent({ ok: false, event: "retry", error: error.message }),
    });
    printEvent({ ok: true, event: "stopped", ...summary });
  } else if (command === "status") {
    const config = await loadAgentConfig(configPath);
    print({
      ok: true,
      paired: true,
      config: configPath,
      serverUrl: config.serverUrl,
      deviceId: config.deviceId,
      name: config.name,
      platform: config.platform,
      pairedAt: config.pairedAt,
    });
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`设备操作失败：${error.message}\n`);
  process.exitCode = 1;
}
