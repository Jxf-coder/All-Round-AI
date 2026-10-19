import { randomUUID } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Per-project Agent memory. The reference workbench keeps 人格 (SOUL.md) and
// 长期记忆 (MEMORY.md) per project and replays them into every chat turn, so the
// assistant keeps a role and a lasting set of facts.
//
// Memory distilled from conversations never lands in MEMORY.md directly: it
// waits in `pending` until a person confirms or discards it, which is the
// reference's 自动沉淀（待确认） section. Only confirmed entries are injected.
// ---------------------------------------------------------------------------

export const MAX_MEMORY_LENGTH = 16_000;
export const MAX_PENDING_ITEMS = 30;
export const MAX_PENDING_TEXT = 200;
export const MEMORY_KINDS = Object.freeze(["事实", "决策", "偏好"]);

const MAX_PROJECTS = 200;
const MIN_PENDING_TEXT = 4;
const KIND_SET = new Set(MEMORY_KINDS);

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validatePendingItem(value) {
  return Boolean(value) && typeof value === "object"
    && typeof value.id === "string" && value.id.length > 0
    && typeof value.text === "string"
    && value.text.length >= MIN_PENDING_TEXT
    && value.text.length <= MAX_PENDING_TEXT
    && KIND_SET.has(value.kind)
    && isIsoTimestamp(value.createdAt);
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
      // `pending` arrived with memory distillation; older records have none.
      || (record.pending !== undefined
        && (!Array.isArray(record.pending) || !record.pending.every(validatePendingItem)))
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

function normalizeKind(value, fallback = "事实") {
  return KIND_SET.has(value) ? value : fallback;
}

// Distilled entries may arrive as plain text or as "[决策] 文本"; both forms are
// accepted so the provider prompt can stay simple.
function normalizePending(value) {
  const raw = typeof value === "string" ? value : value?.text;
  if (typeof raw !== "string") throw new TypeError("记忆条目必须是字符串");
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  const prefixed = collapsed.match(/^\[(事实|决策|偏好)\]\s*(.+)$/u);
  const text = (prefixed ? prefixed[2] : collapsed).trim();
  if (text.length < MIN_PENDING_TEXT) throw new TypeError("记忆条目太短");
  if (text.length > MAX_PENDING_TEXT) throw new TypeError(`记忆条目不能超过 ${MAX_PENDING_TEXT} 个字符`);
  return {
    text,
    kind: normalizeKind(prefixed ? prefixed[1] : value?.kind),
  };
}

// Two entries count as the same when one contains the other or they share most
// characters. This mirrors the reference's dedupe so repeated distillation does
// not fill the pending list with paraphrases.
export function memorySimilar(a, b) {
  const normalize = (value) => String(value ?? "")
    .replace(/^-\s*/u, "")
    .replace(/^\[(事实|决策|偏好)\]\s*/u, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  // Character overlap is only meaningful for longer sentences; on short
  // entries it would merge unrelated facts such as "第一条记忆" and "第二条记忆".
  if (Math.max(left.length, right.length) < 12) return false;
  const characters = new Set(left);
  let hits = 0;
  for (const character of right) if (characters.has(character)) hits += 1;
  return hits / Math.max(left.length, right.length) >= 0.72;
}

function memoryBullets(memory) {
  return memory
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function appendMemoryItem(memory, kind, text) {
  const heading = `## ${kind}`;
  const lines = memory.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    const base = memory.trimEnd();
    return `${base ? `${base}\n\n` : ""}${heading}\n\n- ${text}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  const hadTrailingBlank = insertAt < end;
  lines.splice(insertAt, 0, `- ${text}`);
  if (!hadTrailingBlank && end < lines.length) lines.splice(insertAt + 1, 0, "");
  return lines.join("\n");
}

// The block that is replayed to the provider. Pending entries are deliberately
// absent: nothing reaches the model before a person confirms it.
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
      pending: (record?.pending ?? []).map((item) => ({ ...item })),
      updatedAt: record?.updatedAt ?? null,
    };
  }

  function requireProjectId(projectId) {
    if (typeof projectId !== "string" || !projectId) {
      throw new TypeError("A memory project is required");
    }
  }

  return Object.freeze({
    // Reading memory never writes: a project that was never edited simply has
    // empty documents.
    async get(projectId) {
      requireProjectId(projectId);
      const { projects } = await store.read();
      return present(projectId, projects.find((record) => record.projectId === projectId));
    },
    async save(projectId, { soul, memory } = {}) {
      requireProjectId(projectId);
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
            pending: [],
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

    // Adds distilled candidates to the confirmation queue. Duplicates against
    // the queue and against confirmed memory are dropped instead of stored.
    async addPending(projectId, items) {
      requireProjectId(projectId);
      if (!Array.isArray(items) || items.length === 0) {
        throw new TypeError("至少需要一条记忆条目");
      }
      const candidates = items.map(normalizePending);
      return store.update((document) => {
        const existing = document.projects.find((record) => record.projectId === projectId);
        if (!existing) {
          if (document.projects.length >= MAX_PROJECTS) {
            throw new Error("记忆数量已达上限，请先清理旧项目");
          }
          document.projects.push({
            projectId,
            soul: "",
            memory: "",
            pending: [],
            updatedAt: new Date().toISOString(),
          });
        }
        const record = document.projects.find((entry) => entry.projectId === projectId);
        record.pending ??= [];
        const catalog = [
          ...memoryBullets(record.memory),
          ...record.pending.map((item) => item.text),
        ];
        const accepted = [];
        for (const candidate of candidates) {
          if (catalog.some((known) => memorySimilar(known, candidate.text))) continue;
          accepted.push(candidate);
          catalog.push(candidate.text);
        }
        if (accepted.length === 0) return present(projectId, record);
        const createdAt = new Date().toISOString();
        record.pending.push(...accepted.map((candidate) => ({
          id: randomUUID(),
          text: candidate.text,
          kind: candidate.kind,
          createdAt,
        })));
        // Keep the newest entries when the queue is full instead of refusing
        // the write, so distillation never fails because of an old backlog.
        if (record.pending.length > MAX_PENDING_ITEMS) {
          record.pending = record.pending.slice(-MAX_PENDING_ITEMS);
        }
        record.updatedAt = createdAt;
        return present(projectId, record);
      });
    },

    // Confirming moves one entry into MEMORY.md under its kind's heading. The
    // id is what the UI holds, so an edit to the text cannot target another
    // entry by accident.
    async confirmPending(projectId, id, { kind, text } = {}) {
      requireProjectId(projectId);
      if (typeof id !== "string" || !id) throw new TypeError("记忆条目 id 无效");
      const nextKind = kind === undefined ? null : normalizeKind(kind, null);
      const nextText = text === undefined ? null : normalizePending({ text, kind: nextKind ?? undefined }).text;
      return store.update((document) => {
        const record = document.projects.find((entry) => entry.projectId === projectId);
        const item = record?.pending?.find((entry) => entry.id === id);
        if (!item) return null;
        const resolvedKind = nextKind ?? item.kind;
        const resolvedText = nextText ?? item.text;
        if (!memoryBullets(record.memory).some((known) => memorySimilar(known, resolvedText))) {
          record.memory = appendMemoryItem(record.memory, resolvedKind, resolvedText);
        }
        record.pending = record.pending.filter((entry) => entry.id !== id);
        record.updatedAt = new Date().toISOString();
        return present(projectId, record);
      });
    },

    async discardPending(projectId, id) {
      requireProjectId(projectId);
      if (typeof id !== "string" || !id) throw new TypeError("记忆条目 id 无效");
      return store.update((document) => {
        const record = document.projects.find((entry) => entry.projectId === projectId);
        if (!record?.pending?.some((entry) => entry.id === id)) return null;
        record.pending = record.pending.filter((entry) => entry.id !== id);
        record.updatedAt = new Date().toISOString();
        return present(projectId, record);
      });
    },
  });
}
