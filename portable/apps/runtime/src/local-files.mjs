import { randomBytes } from "node:crypto";
import { readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Local file boundary for desk capabilities.
//
// A desk may only touch paths inside the roots an operator configured. Every
// access resolves symlinks first and then re-checks containment, so a link or
// `..` segment cannot escape. Reads reject binary content and oversized files
// instead of streaming an unbounded document into the workbench.
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

export class LocalFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalFileError";
    this.code = code;
  }
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeRoots(roots, platform) {
  const api = pathApi(platform);
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new LocalFileError("NO_ROOTS", "没有配置允许访问的目录");
  }
  return roots.map((root) => {
    if (typeof root !== "string" || !api.isAbsolute(root)) {
      throw new LocalFileError("BAD_ROOT", "允许访问的目录必须是绝对路径");
    }
    return api.resolve(root);
  });
}

function isInside(rootPath, targetPath, platform) {
  const api = pathApi(platform);
  const relative = api.relative(rootPath, targetPath);
  if (relative === "") return true;
  return !relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative);
}

export async function resolveLocalPath({
  roots,
  target,
  platform = process.platform,
}) {
  const api = pathApi(platform);
  const normalizedRoots = normalizeRoots(roots, platform);
  if (typeof target !== "string" || !api.isAbsolute(target)) {
    throw new LocalFileError("BAD_PATH", "要访问的路径必须是绝对路径");
  }

  const realTarget = await realpath(target).catch(() => {
    throw new LocalFileError("NOT_FOUND", "路径不存在");
  });
  for (const root of normalizedRoots) {
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) continue;
    if (isInside(api.resolve(realRoot), api.resolve(realTarget), platform)) {
      return { realPath: api.resolve(realTarget), root: api.resolve(realRoot) };
    }
  }
  throw new LocalFileError("OUTSIDE_ROOT", "路径不在允许访问的目录里");
}

// Resolves the directory that will hold a new file. The directory itself must
// already exist inside a root, so `..` and symlinked folders cannot redirect a
// write somewhere else.
async function resolveWriteTarget({ roots, target, platform }) {
  const api = pathApi(platform);
  const normalizedRoots = normalizeRoots(roots, platform);
  if (typeof target !== "string" || !api.isAbsolute(target)) {
    throw new LocalFileError("BAD_PATH", "要访问的路径必须是绝对路径");
  }

  const existing = await stat(target).catch(() => null);
  if (existing) {
    const { realPath } = await resolveLocalPath({ roots, target, platform });
    if (!(await stat(realPath)).isFile()) {
      throw new LocalFileError("NOT_A_FILE", "目标不是文件");
    }
    return realPath;
  }

  const parent = api.dirname(target);
  const realParent = await realpath(parent).catch(() => {
    throw new LocalFileError("NOT_FOUND", "目标目录不存在");
  });
  if (!(await stat(realParent)).isDirectory()) {
    throw new LocalFileError("NOT_A_DIRECTORY", "目标目录不存在");
  }
  for (const root of normalizedRoots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot && isInside(api.resolve(realRoot), api.resolve(realParent), platform)) {
      return api.join(api.resolve(realParent), api.basename(target));
    }
  }
  throw new LocalFileError("OUTSIDE_ROOT", "路径不在允许访问的目录里");
}

export async function listDirectory({
  roots,
  target,
  platform = process.platform,
  limit = DEFAULT_LIST_LIMIT,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new LocalFileError("BAD_LIMIT", "列目录数量必须是正整数");
  }
  const cap = Math.min(limit, MAX_LIST_LIMIT);
  const { realPath } = await resolveLocalPath({ roots, target, platform });
  const info = await stat(realPath).catch(() => null);
  if (!info?.isDirectory()) throw new LocalFileError("NOT_A_DIRECTORY", "目标不是目录");

  const entries = await readdir(realPath, { withFileTypes: true });
  const items = entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }))
    .filter((entry) => entry.type !== "other")
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    path: realPath,
    entries: items.slice(0, cap),
    truncated: items.length > cap,
  };
}

export async function readTextFile({
  roots,
  target,
  platform = process.platform,
  maxBytes = DEFAULT_MAX_TEXT_BYTES,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new LocalFileError("BAD_LIMIT", "读取上限必须是正整数");
  }
  const { realPath } = await resolveLocalPath({ roots, target, platform });
  const info = await stat(realPath).catch(() => null);
  if (!info?.isFile()) throw new LocalFileError("NOT_A_FILE", "目标不是文件");
  if (info.size > maxBytes) {
    throw new LocalFileError("TOO_LARGE", `文件超过 ${maxBytes} 字节，拒绝读取`);
  }
  const buffer = await readFile(realPath);
  if (buffer.includes(0)) throw new LocalFileError("BINARY", "不是文本文件");
  return { path: realPath, size: buffer.length, text: buffer.toString("utf8") };
}

export async function writeTextFile({
  roots,
  target,
  text,
  platform = process.platform,
  maxBytes = DEFAULT_MAX_TEXT_BYTES,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new LocalFileError("BAD_LIMIT", "写入上限必须是正整数");
  }
  if (typeof text !== "string") throw new LocalFileError("BAD_TEXT", "写入内容必须是文本");
  const size = Buffer.byteLength(text, "utf8");
  if (size > maxBytes) {
    throw new LocalFileError("TOO_LARGE", `内容超过 ${maxBytes} 字节，拒绝写入`);
  }
  const finalPath = await resolveWriteTarget({ roots, target, platform });
  const temporary = `${finalPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, finalPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path: finalPath, size };
}
