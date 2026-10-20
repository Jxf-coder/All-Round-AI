import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { writeJsonFile } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Release packages and version switching.
//
// A release package is a plain directory with a `release.json` manifest that
// lists every file with its size and sha256. Verification is fail-closed: a
// missing file, a changed file or a file that the manifest does not mention
// all reject the package. Installing copies only manifest entries; the copy is
// verified again in its destination, so a torn read cannot become a release.
//
// Activation swaps a `current` symlink (a junction on Windows) after the new
// release has been verified, and records the previous version so `rollback`
// can point the link back without touching application data.
// ---------------------------------------------------------------------------

export const RELEASE_SCHEMA = 1;
export const RELEASE_PRODUCT = "all-round-ai";
export const RELEASE_MANIFEST_NAME = "release.json";
const STATE_SCHEMA = 1;
const CLOSED_STATE_MISSING = "ENOENT";

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

export function parseVersion(value) {
  if (typeof value !== "string") throw new TypeError("版本号必须是字符串");
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`无法识别的版本号：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  // A release with no prerelease tag is newer than any prerelease of the
  // same numeric version.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  return path.normalize(value);
}

function relativeEntry(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("发布清单里有空路径");
  }
  if (path.isAbsolute(value)) throw new Error(`发布清单里的路径不能是绝对路径：${value}`);
  const normalized = value.split("\\").join("/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`发布清单里的路径不能包含空段或 ..：${value}`);
  }
  if (normalized === RELEASE_MANIFEST_NAME) {
    throw new Error(`发布清单不能把 ${RELEASE_MANIFEST_NAME} 列为内容文件`);
  }
  return parts.join(path.sep);
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

export async function readReleaseManifest(packageDir) {
  const root = assertAbsolute(packageDir, "发布包目录");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, RELEASE_MANIFEST_NAME), "utf8"));
  } catch {
    throw new Error(`没有可读的发布清单：${root}`);
  }
  if (!parsed || parsed.schema !== RELEASE_SCHEMA) {
    throw new Error("发布清单格式不支持或已损坏");
  }
  if (parsed.product !== RELEASE_PRODUCT) {
    throw new Error(`发布包不属于 ${RELEASE_PRODUCT}：${String(parsed.product)}`);
  }
  parseVersion(parsed.version);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("发布清单没有任何文件");
  }
  const seen = new Set();
  for (const file of parsed.files) {
    if (!file || typeof file !== "object" || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("发布清单包含无效文件记录");
    }
    const relative = relativeEntry(file.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`发布清单重复列出文件：${file.path}`);
    seen.add(key);
  }
  return parsed;
}

async function collectPackageFiles(root) {
  const files = new Set();
  const problems = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        problems.push({ path: relative, reason: "发布包不能包含符号链接" });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        if (!prefix && entry.name === RELEASE_MANIFEST_NAME) continue;
        files.add(relative);
      } else {
        problems.push({ path: relative, reason: "发布包只能包含普通文件" });
      }
    }
  }
  await walk(root, "");
  return { files, problems };
}

export async function verifyReleasePackage(packageDir) {
  const root = assertAbsolute(packageDir, "发布包目录");
  const manifest = await readReleaseManifest(root);
  const expected = new Map();
  for (const file of manifest.files) {
    expected.set(relativeEntry(file.path).split(path.sep).join("/"), file);
  }

  const { files: actual, problems } = await collectPackageFiles(root);
  const errors = [...problems];
  for (const [relative, file] of expected) {
    if (!actual.has(relative)) {
      errors.push({ path: relative, reason: "文件不存在" });
      continue;
    }
    const target = path.resolve(root, file.path.split("/").join(path.sep));
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      errors.push({ path: relative, reason: "文件不存在" });
      continue;
    }
    if (info.size !== file.size) {
      errors.push({ path: relative, reason: `大小不一致（清单 ${file.size}，实际 ${info.size}）` });
      continue;
    }
    const actualHash = await hashFile(target);
    if (actualHash.sha256 !== file.sha256) {
      errors.push({ path: relative, reason: "校验和不一致" });
    }
  }
  for (const relative of actual) {
    if (!expected.has(relative)) {
      errors.push({ path: relative, reason: "发布包包含清单之外的文件" });
    }
  }
  return { ok: errors.length === 0, manifest, errors };
}

function releaseDirectory(releasesRoot, version) {
  const parsed = parseVersion(version);
  const normalized = parsed.prerelease.length > 0
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.prerelease.join(".")}`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return path.join(releasesRoot, normalized);
}

export async function installRelease({ packageDir, releasesRoot, now = () => new Date() }) {
  const source = assertAbsolute(packageDir, "发布包目录");
  const root = assertAbsolute(releasesRoot, "发布目录");

  const verification = await verifyReleasePackage(source);
  if (!verification.ok) {
    const first = verification.errors[0];
    throw new Error(`发布包校验失败：${first.path}（${first.reason}）`);
  }
  const version = verification.manifest.version;
  const destination = releaseDirectory(root, version);
  const existing = await stat(destination).catch(() => null);
  if (existing) throw new Error(`版本已存在，不能覆盖：${version}`);

  await mkdir(root, { recursive: true, mode: 0o755 });
  await mkdir(destination, { recursive: false, mode: 0o755 });
  let totalBytes = 0;
  try {
    for (const file of verification.manifest.files) {
      const relative = relativeEntry(file.path);
      const target = path.resolve(destination, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(path.resolve(source, relative), target);
      totalBytes += file.size;
    }
    await copyFile(
      path.join(source, RELEASE_MANIFEST_NAME),
      path.join(destination, RELEASE_MANIFEST_NAME),
    );
    const installed = await verifyReleasePackage(destination);
    if (!installed.ok) {
      const first = installed.errors[0];
      throw new Error(`安装后校验失败：${first.path}（${first.reason}）`);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    version,
    directory: destination,
    files: verification.manifest.files.length,
    totalBytes,
    installedAt: now().toISOString(),
  };
}

async function readState(stateFile) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === CLOSED_STATE_MISSING) {
      return { schema: STATE_SCHEMA, active: null, previous: null, history: [] };
    }
    throw new Error(`启动状态文件不可读：${stateFile}`);
  }
  if (!parsed || parsed.schema !== STATE_SCHEMA || !Array.isArray(parsed.history)) {
    throw new Error("启动状态文件格式不支持或已损坏");
  }
  for (const key of ["active", "previous"]) {
    if (parsed[key] !== null && parsed[key] !== undefined) parseVersion(parsed[key]);
  }
  return {
    schema: STATE_SCHEMA,
    active: parsed.active ?? null,
    previous: parsed.previous ?? null,
    history: parsed.history,
  };
}

async function removeLink(link) {
  // A junction is reported as a symbolic link by lstat but unlink cannot always
  // remove it on Windows; rmdir removes the link itself without touching the
  // release directory it points at.
  try {
    await unlink(link);
  } catch (error) {
    if (!["EPERM", "EISDIR", "ENOTDIR", "EINVAL"].includes(error.code)) throw error;
    await rmdir(link);
  }
}

async function replaceCurrentLink(currentPath, target, now) {
  const type = process.platform === "win32" ? "junction" : "dir";
  const temporary = `${currentPath}.next`;
  await rm(temporary, { recursive: true, force: true });
  await symlink(target, temporary, type);
  const existing = await lstat(currentPath).catch(() => null);
  if (existing) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      throw new Error(`${currentPath} 是真实目录，不能自动替换；请先人工确认`);
    }
    await removeLink(currentPath);
  }
  await rename(temporary, currentPath);
  return now().toISOString();
}

export function defaultStateFile(releasesRoot) {
  return path.join(path.dirname(assertAbsolute(releasesRoot, "发布目录")), "state", "releases.json");
}

export function defaultCurrentPath(releasesRoot) {
  return path.join(path.dirname(assertAbsolute(releasesRoot, "发布目录")), "current");
}

export async function activateRelease({
  releasesRoot,
  currentPath = defaultCurrentPath(releasesRoot),
  stateFile = defaultStateFile(releasesRoot),
  version,
  now = () => new Date(),
}) {
  const root = assertAbsolute(releasesRoot, "发布目录");
  const link = assertAbsolute(currentPath, "当前版本入口");
  const statePath = assertAbsolute(stateFile, "启动状态文件");
  const target = releaseDirectory(root, version);

  const state = await readState(statePath);
  if (state.active === version) {
    return { changed: false, version, previous: state.previous, currentPath: link };
  }
  const verification = await verifyReleasePackage(target).catch(() => null);
  if (!verification?.ok) {
    throw new Error(`版本未安装或已损坏：${version}`);
  }

  const at = await replaceCurrentLink(link, target, now);
  const history = [...state.history, { from: state.active, to: version, at }].slice(-20);
  await writeJsonFile(statePath, {
    schema: STATE_SCHEMA,
    active: version,
    previous: state.active,
    updatedAt: at,
    history,
  });
  return { changed: true, version, previous: state.active, currentPath: link, activatedAt: at };
}

export async function rollbackRelease({
  releasesRoot,
  currentPath = defaultCurrentPath(releasesRoot),
  stateFile = defaultStateFile(releasesRoot),
  now = () => new Date(),
}) {
  const root = assertAbsolute(releasesRoot, "发布目录");
  const link = assertAbsolute(currentPath, "当前版本入口");
  const statePath = assertAbsolute(stateFile, "启动状态文件");
  const state = await readState(statePath);
  if (!state.previous) throw new Error("没有可回滚的版本");
  const target = releaseDirectory(root, state.previous);
  const verification = await verifyReleasePackage(target).catch(() => null);
  if (!verification?.ok) {
    throw new Error(`上一版本未安装或已损坏：${state.previous}`);
  }

  const at = await replaceCurrentLink(link, target, now);
  const history = [...state.history, { from: state.active, to: state.previous, at, rollback: true }].slice(-20);
  await writeJsonFile(statePath, {
    schema: STATE_SCHEMA,
    active: state.previous,
    previous: state.active,
    updatedAt: at,
    history,
  });
  return { version: state.previous, previous: state.active, currentPath: link, rolledBackAt: at };
}

export async function releaseStatus({
  releasesRoot,
  currentPath = defaultCurrentPath(releasesRoot),
  stateFile = defaultStateFile(releasesRoot),
}) {
  const root = assertAbsolute(releasesRoot, "发布目录");
  const link = assertAbsolute(currentPath, "当前版本入口");
  const state = await readState(assertAbsolute(stateFile, "启动状态文件"));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const installed = entries
    .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
  const activeTarget = await realpath(link).catch(() => null);
  return {
    installed,
    active: state.active,
    previous: state.previous,
    currentTarget: activeTarget,
    linkExists: activeTarget !== null,
    history: state.history,
  };
}

export async function checkHealth({
  url,
  fetchImpl = globalThis.fetch,
  attempts = 30,
  delayMs = 1000,
  timeoutMs = 5000,
  waitImpl = wait,
}) {
  if (typeof url !== "string" || !/^https?:\/\//u.test(url)) {
    throw new TypeError("健康检查地址必须是 http(s) URL");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("健康检查次数必须是正整数");
  }
  let lastError = "未执行";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body = await response.json().catch(() => null);
        if (body?.status === "ok") {
          return { ok: true, attempts: attempt, url, service: body.service ?? null };
        }
        lastError = "健康检查响应缺少 status=ok";
      }
    } catch (error) {
      lastError = error.message;
    }
    if (attempt < attempts) await waitImpl(delayMs);
  }
  return { ok: false, attempts, url, error: lastError };
}
