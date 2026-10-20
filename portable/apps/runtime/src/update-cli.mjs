import path from "node:path";
import { parseArgs } from "node:util";

import {
  activateRelease,
  checkHealth,
  defaultCurrentPath,
  defaultStateFile,
  installRelease,
  packRelease,
  releaseStatus,
  rollbackRelease,
  verifyReleasePackage,
} from "./updater.mjs";

const USAGE = `用法：
  node update-cli.mjs pack     --source <源码目录> --out <输出目录> [--version <版本>]
  node update-cli.mjs verify   --package <发布包目录>
  node update-cli.mjs install  --package <发布包目录> --releases <发布目录>
  node update-cli.mjs activate --releases <发布目录> --version <版本> [--current <入口路径>] [--state <状态文件>]
  node update-cli.mjs rollback --releases <发布目录> [--current <入口路径>] [--state <状态文件>]
  node update-cli.mjs status   --releases <发布目录> [--current <入口路径>] [--state <状态文件>]
  node update-cli.mjs health   --url <健康检查地址> [--attempts <次数>] [--delay-ms <毫秒>]

--current 默认 <发布目录>/../current，--state 默认 <发布目录>/../state/releases.json。
pack 复制源码树（跳过 .git、node_modules 与根目录的 reference/backups/logs/data）
并生成 release.json，输出目录不能位于源码目录内。
install 只复制清单内的文件并再次校验，不会覆盖已存在的版本；activate 只切换 current 链接，
不改动应用数据；rollback 切回上一个版本，同样不改动数据。`;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function required(values, key, label) {
  const value = values[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label}需要 --${key}`);
  return path.resolve(value);
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      package: { type: "string" },
      source: { type: "string" },
      out: { type: "string" },
      releases: { type: "string" },
      current: { type: "string" },
      state: { type: "string" },
      version: { type: "string" },
      url: { type: "string" },
      attempts: { type: "string" },
      "delay-ms": { type: "string" },
    },
  });
  const command = positionals[0];

  if (command === "pack") {
    const result = await packRelease({
      sourceDir: required(values, "source", "pack"),
      outDir: required(values, "out", "pack"),
      version: typeof values.version === "string" && values.version.trim() !== ""
        ? values.version.trim()
        : undefined,
    });
    print({ ok: true, ...result });
  } else if (command === "verify") {
    const result = await verifyReleasePackage(required(values, "package", "verify"));
    print({
      ok: result.ok,
      version: result.manifest.version,
      files: result.manifest.files.length,
      errors: result.errors,
    });
    if (!result.ok) process.exitCode = 1;
  } else if (command === "install") {
    const result = await installRelease({
      packageDir: required(values, "package", "install"),
      releasesRoot: required(values, "releases", "install"),
    });
    print({ ok: true, ...result });
  } else if (command === "activate") {
    const releasesRoot = required(values, "releases", "activate");
    if (typeof values.version !== "string" || values.version.trim() === "") {
      throw new Error("activate 需要 --version");
    }
    const result = await activateRelease({
      releasesRoot,
      currentPath: values.current ? path.resolve(values.current) : defaultCurrentPath(releasesRoot),
      stateFile: values.state ? path.resolve(values.state) : defaultStateFile(releasesRoot),
      version: values.version.trim(),
    });
    print({ ok: true, ...result });
  } else if (command === "rollback") {
    const releasesRoot = required(values, "releases", "rollback");
    const result = await rollbackRelease({
      releasesRoot,
      currentPath: values.current ? path.resolve(values.current) : defaultCurrentPath(releasesRoot),
      stateFile: values.state ? path.resolve(values.state) : defaultStateFile(releasesRoot),
    });
    print({ ok: true, ...result });
  } else if (command === "status") {
    const releasesRoot = required(values, "releases", "status");
    const result = await releaseStatus({
      releasesRoot,
      currentPath: values.current ? path.resolve(values.current) : defaultCurrentPath(releasesRoot),
      stateFile: values.state ? path.resolve(values.state) : defaultStateFile(releasesRoot),
    });
    print({ ok: true, ...result });
  } else if (command === "health") {
    const attempts = values.attempts === undefined ? 5 : Number(values.attempts);
    const delayMs = values["delay-ms"] === undefined ? 1000 : Number(values["delay-ms"]);
    const result = await checkHealth({
      url: values.url ?? "",
      attempts,
      delayMs,
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`升级操作失败：${error.message}\n`);
  process.exitCode = 1;
}
