import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeJsonFile } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Data directory backup and restore.
//
// A backup is a plain directory plus a manifest of file hashes: no archive tool,
// no compression dependency, and every file can be inspected with normal tools.
// `logs/` and `backups/` are excluded because they are regenerable and would
// make a backup include its own history.
//
// Restore is deliberately conservative: by default it only writes into an empty
// directory, and it verifies every hash before copying anything.
// ---------------------------------------------------------------------------

export const BACKUP_VERSION = 1;
const EXCLUDED_TOP_LEVEL = new Set(["logs", "backups"]);
const MANIFEST_NAME = "manifest.json";

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  return path.normalize(value);
}

function timestamp(now) {
  const iso = now().toISOString();
  return `${iso.slice(0, 10).replace(/-/gu, "")}-${iso.slice(11, 19).replace(/:/gu, "")}`;
}

function manifestPath(value) {
  if (typeof value !== "string" || !value) throw new Error("备份清单里有空路径");
  if (path.isAbsolute(value)) throw new Error(`备份清单里的路径不能是绝对路径：${value}`);
  const normalized = value.split("/").join(path.sep);
  if (normalized.split(path.sep).includes("..")) {
    throw new Error(`备份清单里的路径不能包含 ..：${value}`);
  }
  return normalized;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function copyHashed(source, destination, relative) {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    meter,
    createWriteStream(destination, { mode: 0o600 }),
  );
  return { path: relative, size, sha256: hash.digest("hex") };
}

async function copyTree(sourceDir, destinationDir, relativePrefix, files) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!relativePrefix && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    // A symlink can point outside the data directory; a backup must not follow
    // it. Regular files and directories only.
    if (entry.isSymbolicLink()) continue;
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await copyTree(source, destination, relative, files);
    } else if (entry.isFile()) {
      files.push(await copyHashed(source, destination, relative));
    }
  }
}

export async function createBackup({ dataDir, outDir, now = () => new Date() }) {
  const source = assertAbsolute(dataDir, "数据目录");
  const output = assertAbsolute(outDir, "备份目录");
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`数据目录不存在：${source}`);

  const destination = path.join(output, `allround-backup-${timestamp(now)}`);
  const existing = await stat(destination).catch(() => null);
  if (existing) throw new Error(`备份目录已存在：${destination}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const files = [];
  try {
    await copyTree(source, destination, "", files);
    const manifest = {
      version: BACKUP_VERSION,
      createdAt: now().toISOString(),
      source,
      excluded: [...EXCLUDED_TOP_LEVEL].sort(),
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    };
    await writeJsonFile(path.join(destination, MANIFEST_NAME), manifest);
    return { directory: destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readManifest(backupDir) {
  const root = assertAbsolute(backupDir, "备份目录");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, MANIFEST_NAME), "utf8"));
  } catch {
    throw new Error(`没有可读的备份清单：${root}`);
  }
  if (!parsed || parsed.version !== BACKUP_VERSION || !Array.isArray(parsed.files)) {
    throw new Error("备份清单格式不支持或已损坏");
  }
  for (const file of parsed.files) {
    if (!file || typeof file !== "object" || typeof file.sha256 !== "string"
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("备份清单包含无效文件记录");
    }
    manifestPath(file.path);
  }
  return parsed;
}

export async function verifyBackup(backupDir) {
  const root = assertAbsolute(backupDir, "备份目录");
  const manifest = await readManifest(root);
  const errors = [];
  for (const file of manifest.files) {
    const relative = manifestPath(file.path);
    const target = path.resolve(root, relative);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      errors.push({ path: file.path, reason: "文件不存在" });
      continue;
    }
    if (info.size !== file.size) {
      errors.push({ path: file.path, reason: `大小不一致（清单 ${file.size}，实际 ${info.size}）` });
      continue;
    }
    const actual = await hashFile(target);
    if (actual.sha256 !== file.sha256) {
      errors.push({ path: file.path, reason: "校验和不一致" });
    }
  }
  return { ok: errors.length === 0, manifest, errors };
}

export async function restoreBackup({ backupDir, dataDir, force = false }) {
  const backupRoot = assertAbsolute(backupDir, "备份目录");
  const targetRoot = assertAbsolute(dataDir, "数据目录");
  const verification = await verifyBackup(backupRoot);
  if (!verification.ok) {
    const first = verification.errors[0];
    throw new Error(`备份校验失败：${first.path}（${first.reason}）`);
  }
  const existing = await readdir(targetRoot).catch(() => null);
  if (existing && existing.length > 0 && !force) {
    throw new Error(`目标数据目录不是空的：${targetRoot}。确认要覆盖时加 --force`);
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  let restored = 0;
  for (const file of verification.manifest.files) {
    const relative = manifestPath(file.path);
    const source = path.resolve(backupRoot, relative);
    const destination = path.resolve(targetRoot, relative);
    const parent = path.relative(targetRoot, path.dirname(destination));
    if (parent === ".." || parent.startsWith(`..${path.sep}`) || path.isAbsolute(parent)) {
      throw new Error(`备份清单里的路径越界：${file.path}`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    restored += 1;
  }
  return {
    restored,
    dataDir: targetRoot,
    createdAt: verification.manifest.createdAt,
  };
}
