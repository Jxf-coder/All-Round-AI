import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  defaultAgentConfigPath,
  loadAgentConfig,
  pairDevice,
  runHeartbeatLoop,
  saveAgentConfig,
  sendHeartbeat,
} from "./desk-agent.mjs";
import { listDirectory, readTextFile, writeTextFile } from "./local-files.mjs";
import { runCommandLoop } from "./desk-channel.mjs";
import { writeDeskService } from "./desk-service.mjs";

const USAGE = `用法：
  node desk-cli.mjs pair      --server <实例地址> --ticket <配对票据> --name <设备名称> [--root <允许目录> ...] [--version <版本>] [--platform <平台>] [--capabilities a,b] [--config <文件>]
  node desk-cli.mjs heartbeat [--config <文件>] [--version <版本>]
  node desk-cli.mjs run       [--config <文件>] [--interval <秒>] [--max-backoff <秒>]
  node desk-cli.mjs service   --out <输出目录> [--config <文件>]
  node desk-cli.mjs files     --root <允许目录> [--root ...] (--list <目录> | --read <文件> | --write <文件> --text <内容>)
  node desk-cli.mjs status    [--config <文件>]

票据由管理员在工作台签发，十分钟内有效且只能使用一次。pair 会把设备令牌写入
配置文件（默认位于本机数据目录的 desk-agent.json，权限 0600），--root 记录允许
工作台访问的绝对目录。run 常驻上报心跳并长轮询执行命令（files.list / files.read），
网络失败按指数退避（默认 30 秒起、最长 300 秒），令牌失效则立即停止。service 只
生成当前平台的用户级服务文件（Linux systemd user、macOS LaunchAgent、Windows 登录
计划任务），安装仍需手动执行。files 只访问 --root 指定目录内的路径：先解析符号
链接再校验边界，拒绝越界、二进制与超过 256 KB 的文件。--write 先写同目录临时
文件再原子替换，目标目录必须已存在。status 只显示配对摘要，不会输出令牌。`;

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
      out: { type: "string" },
      root: { type: "string", multiple: true },
      list: { type: "string" },
      read: { type: "string" },
      write: { type: "string" },
      text: { type: "string" },
    },
  });
  const command = positionals[0];
  const configPath = values.config ? path.resolve(values.config) : defaultAgentConfigPath();

  if (command === "pair") {
    if (!values.server) throw new Error("pair 需要 --server");
    if (!values.ticket) throw new Error("pair 需要 --ticket");
    if (!values.name) throw new Error("pair 需要 --name");
    const roots = values.root ?? [];
    const capabilities = values.capabilities
      ? values.capabilities.split(",").map((entry) => entry.trim()).filter(Boolean)
      // A desk that exposes roots can serve file commands, so advertise that
      // instead of showing "未声明能力" for a fully usable device.
      : roots.length ? ["files"] : [];
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
      roots,
    });
    print({
      ok: true,
      config: configPath,
      serverUrl: paired.serverUrl,
      device: paired.device,
      roots,
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
    printEvent({
      ok: true,
      event: "started",
      name: config.name,
      intervalSeconds,
      roots: config.roots,
    });
    // Heartbeat and command polling share one abort signal: a revoked token
    // has to take both loops down, not leave half the agent retrying.
    const haltOnUnauthorized = (error) => {
      if (error?.code === "DEVICE_UNAUTHORIZED") controller.abort();
      throw error;
    };
    const settled = await Promise.allSettled([
      runHeartbeatLoop({
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
      }).catch(haltOnUnauthorized),
      runCommandLoop({
        config,
        signal: controller.signal,
        onCommand: (outcome) => printEvent({
          ok: outcome.ok,
          event: "command",
          type: outcome.command.type,
          path: outcome.command.payload?.path,
          ...(outcome.ok ? {} : { error: outcome.error }),
        }),
        onError: (error) => printEvent({ ok: false, event: "command-retry", error: error.message }),
      }).catch(haltOnUnauthorized),
    ]);
    const failure = settled.find((entry) => entry.status === "rejected");
    if (failure) throw failure.reason;
    printEvent({
      ok: true,
      event: "stopped",
      beats: settled[0].value.beats,
      failures: settled[0].value.failures,
      commands: settled[1].value.handled,
    });
  } else if (command === "service") {
    if (!values.out) throw new Error("service 需要 --out");
    await loadAgentConfig(configPath);
    const result = await writeDeskService({
      outDir: path.resolve(values.out),
      nodePath: process.execPath,
      mainPath: fileURLToPath(new URL("./desk-cli.mjs", import.meta.url)),
      configPath,
    });
    const install = {
      linux: "mkdir -p ~/.config/systemd/user && cp all-round-ai-desk.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now all-round-ai-desk",
      darwin: "cp com.allroundai.desk.plist ~/Library/LaunchAgents/ && launchctl load -w ~/Library/LaunchAgents/com.allroundai.desk.plist",
      win32: "powershell -ExecutionPolicy Bypass -File install-desk-task.ps1",
    }[result.platform];
    print({ ok: true, ...result, install });
  } else if (command === "files") {
    const roots = values.root ?? [];
    if (values.list) {
      const result = await listDirectory({ roots, target: path.resolve(values.list) });
      print({ ok: true, ...result });
    } else if (values.read) {
      const result = await readTextFile({ roots, target: path.resolve(values.read) });
      print({ ok: true, ...result });
    } else if (values.write) {
      if (values.text === undefined) throw new Error("写入需要 --text");
      const result = await writeTextFile({
        roots,
        target: path.resolve(values.write),
        text: values.text,
      });
      print({ ok: true, ...result });
    } else {
      throw new Error("files 需要 --list、--read 或 --write");
    }
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
      roots: config.roots,
    });
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`设备操作失败：${error.message}\n`);
  process.exitCode = 1;
}
