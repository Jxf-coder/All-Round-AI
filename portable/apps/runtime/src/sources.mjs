import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// 来源配置. The workbench may only read directories an administrator explicitly
// allowed here. There are no NAS credentials in this build: the server scans
// local paths (mounted shares included), which keeps the feature usable in a
// single-machine install without storing any network password.
//
// The store is installation-wide, not per project: a mounted share is the same
// share for every project, and per-project copies would drift.
// ---------------------------------------------------------------------------

export const MAX_SOURCE_ROOTS = 12;
const MAX_ROOT_LENGTH = 300;

function hasTraversal(value) {
  return value.split(/[\\/]+/u).some((segment) => segment === "..");
}

export function normalizeRoots(value) {
  if (!Array.isArray(value)) throw new TypeError("来源目录必须是数组");
  const roots = [];
  for (const item of value) {
    if (typeof item !== "string") throw new TypeError("来源目录必须是字符串");
    const root = item.trim();
    if (!root) continue;
    if (root.length > MAX_ROOT_LENGTH) {
      throw new TypeError(`来源目录不能超过 ${MAX_ROOT_LENGTH} 个字符`);
    }
    if (!path.isAbsolute(root)) {
      throw new TypeError(`来源目录必须是绝对路径：${root}`);
    }
    if (hasTraversal(root)) {
      throw new TypeError(`来源目录不能包含 ..：${root}`);
    }
    const normalized = path.normalize(root);
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  if (roots.length > MAX_SOURCE_ROOTS) {
    throw new TypeError(`最多配置 ${MAX_SOURCE_ROOTS} 个来源目录`);
  }
  return roots;
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.roots)) {
    throw new Error("All Round AI source store format is unsupported or damaged");
  }
  if (value.roots.length > MAX_SOURCE_ROOTS) {
    throw new Error("All Round AI source store contains too many roots");
  }
  for (const root of value.roots) {
    if (typeof root !== "string" || !path.isAbsolute(root) || hasTraversal(root)) {
      throw new Error("All Round AI source store contains an invalid root");
    }
  }
  if (value.updatedAt !== null && value.updatedAt !== undefined
    && (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt)))) {
    throw new Error("All Round AI source store contains an invalid timestamp");
  }
  if (value.updatedBy !== undefined && typeof value.updatedBy !== "string") {
    throw new Error("All Round AI source store contains an invalid author");
  }
  return value;
}

export async function createSourceStore(filePath, { defaultRoots = [] } = {}) {
  const initialRoots = normalizeRoots(defaultRoots);
  const store = createJsonFileStore(filePath, {
    initial: () => ({
      version: 1,
      roots: [...initialRoots],
      updatedAt: null,
      updatedBy: "",
    }),
    validate: validateDocument,
  });

  return Object.freeze({
    async list() {
      const document = await store.read();
      return {
        roots: [...document.roots],
        updatedAt: document.updatedAt ?? null,
        updatedBy: document.updatedBy ?? "",
      };
    },
    async save(roots, by) {
      const normalized = normalizeRoots(roots);
      const author = typeof by === "string" ? by.trim().slice(0, 100) : "";
      return store.update((document) => {
        document.roots = normalized;
        document.updatedAt = new Date().toISOString();
        document.updatedBy = author;
        return {
          roots: [...document.roots],
          updatedAt: document.updatedAt,
          updatedBy: document.updatedBy,
        };
      });
    },
  });
}

// Resolve the requested directory and prove it is inside one of the allowed
// roots. `realpath` on both sides makes symlinks and `..` segments harmless:
// the comparison happens between canonical paths, never the raw input.
export async function resolveScoutRoot(requested, roots) {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new TypeError("请填写要巡读的目录");
  }
  const value = requested.trim();
  if (!path.isAbsolute(value)) {
    throw new TypeError("要巡读的目录必须是绝对路径");
  }
  if (hasTraversal(value)) {
    throw new TypeError("要巡读的目录不能包含 ..");
  }
  let target;
  try {
    target = await realpath(value);
  } catch {
    throw new Error(`目录不存在或无法访问：${value}`);
  }
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`不是文件夹：${value}`);

  for (const root of roots) {
    let allowed;
    try {
      allowed = await realpath(root);
    } catch {
      continue;
    }
    const relative = path.relative(allowed, target);
    if (relative === ""
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return target;
    }
  }
  throw new Error(`目录不在白名单里：${value}。请先在「来源配置」里加入可巡读目录`);
}
