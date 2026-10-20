import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { renderEnvFile, renderNginxConfig, renderSystemdUnit } from "./deploy.mjs";

const USAGE = `用法：
  node deploy-cli.mjs systemd --out <目录> --workdir <代码绝对路径> [--data-dir <数据绝对路径>]
    [--user allround] [--group allround] [--port 3141] [--server-name example.com]
    [--tls-cert /etc/letsencrypt/live/.../fullchain.pem --tls-key .../privkey.pem]
    [--allowed-origins https://example.com] [--ollama-url http://127.0.0.1:11434]
    [--secure-cookies]

生成 all-round-ai.service、all-round-ai.env、all-round-ai.nginx.conf 三个文件。
不安装、不重启服务；按文件头注释与部署文档复制到目标主机。`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      workdir: { type: "string" },
      "data-dir": { type: "string" },
      user: { type: "string" },
      group: { type: "string" },
      port: { type: "string" },
      "server-name": { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "allowed-origins": { type: "string" },
      "ollama-url": { type: "string" },
      "secure-cookies": { type: "boolean" },
    },
  });
  if (positionals[0] !== "systemd") {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  } else {
    if (!values.out) throw new Error("缺少 --out");
    if (!values.workdir) throw new Error("缺少 --workdir");
    if (!values["data-dir"]) throw new Error("缺少 --data-dir");
    const out = path.resolve(values.out);
    // The generated unit targets Linux, so work/data paths are POSIX even when
    // the command runs on Windows.
    const workDir = path.posix.normalize(values.workdir);
    const dataDir = path.posix.normalize(values["data-dir"]);
    const serverName = values["server-name"] ?? "_";
    const tlsCert = values["tls-cert"] ?? "";
    const tlsKey = values["tls-key"] ?? "";
    const secureCookies = values["secure-cookies"] === true || Boolean(tlsCert);
    const allowedOrigins = values["allowed-origins"]
      ?? (tlsCert && serverName !== "_" ? `https://${serverName}` : "");

    const unit = renderSystemdUnit({
      workDir,
      dataDir,
      user: values.user ?? "allround",
      group: values.group ?? values.user ?? "allround",
      nodePath: "/usr/bin/node",
      envFile: "/etc/all-round-ai/all-round-ai.env",
    });
    const env = renderEnvFile({
      dataDir,
      port: values.port ?? 3141,
      allowedOrigins,
      ollamaUrl: values["ollama-url"] ?? "",
      secureCookies,
    });
    const nginx = renderNginxConfig({
      serverName,
      upstream: `http://127.0.0.1:${Number(values.port ?? 3141)}`,
      tlsCert,
      tlsKey,
    });

    await mkdir(out, { recursive: true });
    const files = [
      ["all-round-ai.service", unit, 0o644],
      ["all-round-ai.env", env, 0o600],
      ["all-round-ai.nginx.conf", nginx, 0o644],
    ];
    for (const [name, content, mode] of files) {
      await writeFile(path.join(out, name), content, { encoding: "utf8", mode });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      out,
      files: files.map(([name]) => name),
      secureCookies,
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`部署文件生成失败：${error.message}\n`);
  process.exitCode = 1;
}
