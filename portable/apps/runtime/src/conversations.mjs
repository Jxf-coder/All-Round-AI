import { randomUUID } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

const MAX_CONVERSATIONS_PER_USER = 200;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_CONTENT_LENGTH = 8_000;
const MAX_TITLE_LENGTH = 120;
const MESSAGE_ROLES = new Set(["user", "assistant"]);
const DEFAULT_TITLE = "新对话";

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.conversations)) {
    throw new Error("All Round AI conversation store format is unsupported or damaged");
  }
  for (const conversation of value.conversations) {
    if (!conversation || typeof conversation !== "object"
      || typeof conversation.id !== "string"
      || typeof conversation.ownerId !== "string"
      || typeof conversation.title !== "string"
      || !isIsoTimestamp(conversation.createdAt)
      || !isIsoTimestamp(conversation.updatedAt)
      // projectId arrived with project scoping; documents written before that
      // have none and are still readable (they count as unassigned).
      || (conversation.projectId !== undefined && conversation.projectId !== null
        && typeof conversation.projectId !== "string")
      || !Array.isArray(conversation.messages)) {
      throw new Error("All Round AI conversation store contains an invalid conversation");
    }
    for (const message of conversation.messages) {
      if (!message || typeof message !== "object"
        || typeof message.id !== "string"
        || !MESSAGE_ROLES.has(message.role)
        || typeof message.content !== "string"
        || !isIsoTimestamp(message.createdAt)) {
        throw new Error("All Round AI conversation store contains an invalid message");
      }
    }
  }
  return value;
}

export function conversationTitle(content) {
  const text = typeof content === "string" ? content : "";
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return DEFAULT_TITLE;
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : normalized;
}

function summarize(conversation) {
  return {
    id: conversation.id,
    projectId: conversation.projectId ?? null,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
  };
}

export async function createConversationStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, conversations: [] }),
    validate: validateDocument,
  });

  return Object.freeze({
    // Conversations belong to the project they were started in, so switching
    // projects switches the history. Records written before project scoping
    // existed carry no projectId; `unassignedProjectId` decides which project
    // they are shown under rather than hiding or rewriting them.
    async list(ownerId, { projectId, unassignedProjectId } = {}) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      const desired = typeof projectId === "string" && projectId ? projectId : null;
      const { conversations } = await store.read();
      return conversations
        .map((conversation, index) => ({ conversation, index }))
        .filter(({ conversation }) => conversation.ownerId === ownerId)
        .filter(({ conversation }) => {
          if (!desired) return true;
          const stored = conversation.projectId ?? unassignedProjectId ?? null;
          return stored === desired;
        })
        // Most recently updated first; equally-timestamped entries fall back to
        // insertion order so the listing stays deterministic.
        .sort((left, right) =>
          right.conversation.updatedAt.localeCompare(left.conversation.updatedAt)
          || right.index - left.index)
        .map(({ conversation }) => summarize(conversation));
    },
    async create(ownerId, options = {}) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      if (options.projectId !== undefined && options.projectId !== null
        && (typeof options.projectId !== "string" || !options.projectId)) {
        throw new TypeError("A conversation project must be a non-empty string");
      }
      const now = new Date().toISOString();
      return store.update((document) => {
        const owned = document.conversations.filter((item) => item.ownerId === ownerId);
        if (owned.length >= MAX_CONVERSATIONS_PER_USER) {
          throw new Error("已达对话数量上限，请先删除旧对话");
        }
        const conversation = {
          id: randomUUID(),
          ownerId,
          projectId: options.projectId ?? null,
          title: typeof options.title === "string" && options.title.trim()
            ? options.title.trim().slice(0, MAX_TITLE_LENGTH)
            : DEFAULT_TITLE,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        document.conversations.push(conversation);
        return summarize(conversation);
      });
    },
    async get(ownerId, conversationId) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      const { conversations } = await store.read();
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation || conversation.ownerId !== ownerId) return null;
      return {
        ...summarize(conversation),
        messages: conversation.messages.map((message) => ({ ...message })),
      };
    },
    async appendMessage(ownerId, conversationId, { role, content } = {}) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      if (!MESSAGE_ROLES.has(role)) throw new TypeError("Message role must be user or assistant");
      if (typeof content !== "string" || !content.trim()) throw new TypeError("Message content must not be empty");
      if (content.length > MAX_CONTENT_LENGTH) {
        throw new TypeError(`消息长度不能超过 ${MAX_CONTENT_LENGTH} 个字符`);
      }
      return store.update((document) => {
        const conversation = document.conversations.find((item) => item.id === conversationId);
        if (!conversation || conversation.ownerId !== ownerId) return null;
        if (conversation.messages.length >= MAX_MESSAGES_PER_CONVERSATION) {
          throw new Error("该对话消息数量已达上限");
        }
        const now = new Date().toISOString();
        const message = { id: randomUUID(), role, content, createdAt: now };
        conversation.messages.push(message);
        conversation.updatedAt = now;
        // The first user turn names the conversation, matching how the
        // reference workbench labels history entries.
        if (role === "user" && conversation.title === DEFAULT_TITLE) {
          conversation.title = conversationTitle(content);
        }
        return { ...message };
      });
    },
    // Used by "retry": the trailing answer is dropped so the same question can
    // be asked again without duplicating the user turn.
    async dropTrailingAssistant(ownerId, conversationId) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      return store.update((document) => {
        const conversation = document.conversations.find((item) => item.id === conversationId);
        if (!conversation || conversation.ownerId !== ownerId) return null;
        if (conversation.messages.at(-1)?.role !== "assistant") return false;
        conversation.messages.pop();
        conversation.updatedAt = new Date().toISOString();
        return true;
      });
    },
    async remove(ownerId, conversationId) {
      if (typeof ownerId !== "string" || !ownerId) throw new TypeError("A conversation owner is required");
      return store.update((document) => {
        const index = document.conversations.findIndex(
          (item) => item.id === conversationId && item.ownerId === ownerId,
        );
        if (index === -1) return false;
        document.conversations.splice(index, 1);
        return true;
      });
    },
  });
}
