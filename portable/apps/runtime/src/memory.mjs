import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Per-project Agent memory. The reference workbench keeps 人格 (SOUL.md) and
// 长期记忆 (MEMORY.md) per project and replays them into every chat turn, so the
// assistant keeps a role and a lasting set of facts. This module stores the same
// two documents per project and builds the block that is injected.
//
// Difference from the reference: it also has 组织记忆 (the shared root layer) and
// 待确认条目 (memory distilled from past conversations). Neither exists yet, so
// only SOUL and MEMORY are stored here.
// ---------------------------------------------------------------------------

export const MAX_MEMORY_LENGTH = 16_000;
const MAX_PROJECTS = 200;

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("All Round AI memory store format is unsupported or damaged");
  }
  for (const record of value.projects) {
    if (!record || typeof record !== "object"
      || typeof record.projectId !== "string"
      || !record.projectId
      || typeof record.soul !== "string"
      || typeof record.memory !== "string"
      || !isIsoTimestamp(record.updatedAt)) {
      throw new Error("All Round AI memory store contains an invalid record");
    }
  }
  return value;
}

function normalizeText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label}必须是字符串`);
  if (value.length > MAX_MEMORY_LENGTH) {
    throw new TypeError(`${label}不能超过 ${MAX_MEMORY_LENGTH} 个字符`);
  }
  return value;
}

// The block that is replayed to the provider. Empty memory injects nothing, so
// a project without memory behaves exactly as before.
export function buildMemoryBlock({ soul, memory } = {}) {
  const sections = [];
  if (typeof soul === "string" && soul.trim()) sections.push(`## 人格（SOUL.md）\n${soul.trim()}`);
  if (typeof memory === "string" && memory.trim()) sections.push(`## 长期记忆（MEMORY.md）\n${memory.trim()}`);
  if (!sections.length) return "";
  return ["[Agent 记忆 · 系统自动注入]", ...sections].join("\n\n");
}

export async function createMemoryStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, projects: [] }),
    validate: validateDocument,
  });

  function present(projectId, record) {
    return {
      projectId,
      soul: record?.soul ?? "",
      memory: record?.memory ?? "",
      updatedAt: record?.updatedAt ?? null,
    };
  }

  return Object.freeze({
    // Reading memory never writes: a project that was never edited simply has
    // empty documents.
    async get(projectId) {
      if (typeof projectId !== "string" || !projectId) {
        throw new TypeError("A memory project is required");
      }
      const { projects } = await store.read();
      return present(projectId, projects.find((record) => record.projectId === projectId));
    },
    async save(projectId, { soul, memory } = {}) {
      if (typeof projectId !== "string" || !projectId) {
        throw new TypeError("A memory project is required");
      }
      const nextSoul = soul === undefined ? undefined : normalizeText(soul, "人格");
      const nextMemory = memory === undefined ? undefined : normalizeText(memory, "长期记忆");
      return store.update((document) => {
        const existing = document.projects.find((record) => record.projectId === projectId);
        if (!existing) {
          if (document.projects.length >= MAX_PROJECTS) {
            throw new Error("记忆数量已达上限，请先清理旧项目");
          }
          const record = {
            projectId,
            soul: nextSoul ?? "",
            memory: nextMemory ?? "",
            updatedAt: new Date().toISOString(),
          };
          document.projects.push(record);
          return present(projectId, record);
        }
        if (nextSoul !== undefined) existing.soul = nextSoul;
        if (nextMemory !== undefined) existing.memory = nextMemory;
        existing.updatedAt = new Date().toISOString();
        return present(projectId, existing);
      });
    },
  });
}
