import path from "node:path";
import { parseArgs } from "node:util";

import { resolveDataDirectory } from "../../../packages/platform/src/paths.mjs";
import { createBackup, restoreBackup, verifyBackup } from "./backup.mjs";

const USAGE = `用法：
  node backup-cli.mjs create  [--data-dir <绝对路径>] [--out <绝对路径>]
  node backup-cli.mjs verify  --backup <备份目录>
  node backup-cli.mjs restore --backup <备份目录> [--data-dir <绝对路径>] [--force]

不带 --data-dir 时使用 ALLROUND_AI_DATA_DIR / 平台默认数据目录。
create 默认写到 <data-dir>/backups；备份包含 config/、handover/、imports/ 等，
排除 logs/ 与 backups/。restore 默认只写入空目录；覆盖已有目录要加 --force。`;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      out: { type: "string" },
      backup: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const command = positionals[0];
  const dataDir = path.resolve(values["data-dir"] ?? resolveDataDirectory());

  if (command === "create") {
    const outDir = path.resolve(values.out ?? path.join(dataDir, "backups"));
    const { directory, manifest } = await createBackup({ dataDir, outDir });
    print({
      ok: true,
      directory,
      files: manifest.files.length,
      totalBytes: manifest.totalBytes,
    });
  } else if (command === "verify") {
    if (!values.backup) throw new Error("verify 需要 --backup");
    const result = await verifyBackup(path.resolve(values.backup));
    print({
      ok: result.ok,
      files: result.manifest.files.length,
      errors: result.errors,
    });
    if (!result.ok) process.exitCode = 1;
  } else if (command === "restore") {
    if (!values.backup) throw new Error("restore 需要 --backup");
    const result = await restoreBackup({
      backupDir: path.resolve(values.backup),
      dataDir,
      force: values.force === true,
    });
    print({ ok: true, ...result });
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`备份操作失败：${error.message}\n`);
  process.exitCode = 1;
}
