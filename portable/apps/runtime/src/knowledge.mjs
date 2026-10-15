import { randomUUID } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Per-project knowledge: 知识卡 (knowledge cards) and 缺口清单 (open gaps).
//
// The reference workbench also keeps 条目 (indexed source documents), a 问答来源
// log and a 交接包 export around these two. This module covers the part that can
// stand alone without the file-scanning pipeline: the cards an agent should be
// told about, the questions it could not answer, and a keyword search that puts
// the relevant cards in front of the model each turn.
// ---------------------------------------------------------------------------

export const CARD_KINDS = Object.freeze(["fact", "decision", "preference", "faq", "method"]);
export const CARD_STATUSES = Object.freeze(["pending", "confirmed", "dropped"]);
export const MAX_CARD_TITLE = 120;
export const MAX_CARD_BODY = 4_000;
export const MAX_GAP_TEXT = 500;
export const DEFAULT_RETRIEVAL_LIMIT = 3;

const KIND_SET = new Set(CARD_KINDS);
const STATUS_SET = new Set(CARD_STATUSES);
const MAX_CARDS = 500;
const MAX_GAPS = 200;

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("All Round AI knowledge store format is unsupported or damaged");
  }
  for (const project of value.projects) {
    if (!project || typeof project !== "object"
      || typeof project.projectId !== "string"
      || !project.projectId
      || !Array.isArray(project.cards)
      || !Array.isArray(project.gaps)) {
      throw new Error("All Round AI knowledge store contains an invalid project");
    }
    for (const card of project.cards) {
      if (!card || typeof card !== "object"
        || typeof card.id !== "string"
        || !KIND_SET.has(card.kind)
        || !STATUS_SET.has(card.status)
        || typeof card.title !== "string"
        || typeof card.body !== "string"
        || !isIsoTimestamp(card.createdAt)
        || !isIsoTimestamp(card.updatedAt)) {
        throw new Error("All Round AI knowledge store contains an invalid card");
      }
    }
    for (const gap of project.gaps) {
      if (!gap || typeof gap !== "object"
        || typeof gap.id !== "string"
        || typeof gap.question !== "string"
        || !isIsoTimestamp(gap.createdAt)
        || (gap.status !== "open" && gap.status !== "closed")) {
        throw new Error("All Round AI knowledge store contains an invalid gap");
      }
    }
  }
  return value;
}

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}不能为空`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new TypeError(`${label}不能超过 ${max} 个字符`);
  return trimmed;
}

// Optional free text: absent, null and blank all mean "not provided", so an
// empty input box is never mistaken for a validation failure.
function optionalText(value, label, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label}必须是字符串`);
  return value.trim() ? text(value, label, max) : undefined;
}

function cloneCard(card) {
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    body: card.body,
    status: card.status,
    source: card.source ?? null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function cloneGap(gap) {
  return {
    id: gap.id,
    question: gap.question,
    note: gap.note ?? "",
    status: gap.status,
    createdAt: gap.createdAt,
    closedAt: gap.closedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Retrieval. The reference ranks cards with TF-IDF cosine over the query plus a
// one-hop wikilink expansion. No dependency is allowed here, so this is a plain
// term-frequency score: a query term in the title counts double, a term in the
// body counts once, and the score is normalised by the card's own length so long
// cards do not win automatically. CJK text has no spaces, so it is tokenised
// into bigrams the same way the reference's tokenizer does.
// ---------------------------------------------------------------------------
export function queryTerms(query) {
  const text_ = typeof query === "string" ? query.toLowerCase() : "";
  const terms = new Set();
  for (const word of text_.match(/[a-z0-9]{2,}/gu) ?? []) terms.add(word);
  const cjk = text_.replace(/[^\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/gu, " ");
  for (const run of cjk.split(/\s+/u)) {
    if (run.length === 1) terms.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return [...terms];
}

function scoreCard(card, terms) {
  if (!terms.length) return 0;
  const title = card.title.toLowerCase();
  const body = card.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
  }
  if (!score) return 0;
  // Normalise by size so a card that merely mentions one term in a very long
  // body does not outrank a short, precise card.
  return score / Math.sqrt(title.length + body.length + 1);
}

export function rankCards(cards, query, limit = DEFAULT_RETRIEVAL_LIMIT) {
  const terms = queryTerms(query);
  return cards
    .map((card) => ({ card, score: scoreCard(card, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.card.createdAt.localeCompare(right.card.createdAt))
    .slice(0, limit)
    .map((entry) => entry.card);
}

export function buildKnowledgeBlock(cards) {
  if (!Array.isArray(cards) || !cards.length) return "";
  const sections = cards.map((card) => `### [${card.kind}] ${card.title}\n${card.body}`);
  return ["## 与本轮相关的知识卡片", ...sections].join("\n\n");
}

export async function createKnowledgeStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, projects: [] }),
    validate: validateDocument,
  });

  function projectOf(document, projectId) {
    let project = document.projects.find((item) => item.projectId === projectId);
    if (!project) {
      project = { projectId, cards: [], gaps: [] };
      document.projects.push(project);
    }
    return project;
  }

  function summarize(project) {
    const cards = project.cards.map(cloneCard);
    const gaps = project.gaps.map(cloneGap);
    return {
      projectId: project.projectId,
      cards: [...cards].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      gaps: [...gaps].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      stats: {
        cards: cards.length,
        pending: cards.filter((card) => card.status === "pending").length,
        confirmed: cards.filter((card) => card.status === "confirmed").length,
        dropped: cards.filter((card) => card.status === "dropped").length,
        gapsOpen: gaps.filter((gap) => gap.status === "open").length,
        gapsClosed: gaps.filter((gap) => gap.status === "closed").length,
      },
    };
  }

  function requireProject(projectId) {
    if (typeof projectId !== "string" || !projectId) {
      throw new TypeError("A knowledge project is required");
    }
  }

  return Object.freeze({
    // Reading never creates a project record, so a project with no knowledge
    // stays absent from the file until something is added.
    async list(projectId) {
      requireProject(projectId);
      const { projects } = await store.read();
      const project = projects.find((item) => item.projectId === projectId);
      return summarize(project ?? { projectId, cards: [], gaps: [] });
    },
    async addCard(projectId, { kind, title, body, source } = {}) {
      requireProject(projectId);
      if (!KIND_SET.has(kind)) throw new TypeError("知识卡类型无效");
      const cardTitle = text(title, "标题", MAX_CARD_TITLE);
      const cardBody = text(body, "内容", MAX_CARD_BODY);
      const cardSource = optionalText(source, "来源", MAX_CARD_TITLE) ?? null;
      return store.update((document) => {
        const project = projectOf(document, projectId);
        if (project.cards.length >= MAX_CARDS) throw new Error("知识卡数量已达上限，请先清理旧卡片");
        const now = new Date().toISOString();
        const card = {
          id: randomUUID(),
          kind,
          title: cardTitle,
          body: cardBody,
          // Cards start pending, exactly like the reference: an agent may propose
          // a fact, but only a confirmation puts it into the retrieval pool.
          status: "pending",
          source: cardSource,
          createdAt: now,
          updatedAt: now,
        };
        project.cards.push(card);
        return cloneCard(card);
      });
    },
    async setCardStatus(projectId, cardId, status) {
      requireProject(projectId);
      if (!STATUS_SET.has(status)) throw new TypeError("知识卡状态无效");
      return store.update((document) => {
        const project = document.projects.find((item) => item.projectId === projectId);
        const card = project?.cards.find((item) => item.id === cardId);
        if (!card) return null;
        card.status = status;
        card.updatedAt = new Date().toISOString();
        return cloneCard(card);
      });
    },
    async removeCard(projectId, cardId) {
      requireProject(projectId);
      return store.update((document) => {
        const project = document.projects.find((item) => item.projectId === projectId);
        if (!project) return false;
        const index = project.cards.findIndex((item) => item.id === cardId);
        if (index === -1) return false;
        project.cards.splice(index, 1);
        return true;
      });
    },
    async addGap(projectId, { question, note } = {}) {
      requireProject(projectId);
      const gapQuestion = text(question, "问题", MAX_GAP_TEXT);
      const gapNote = optionalText(note, "备注", MAX_GAP_TEXT) ?? "";
      return store.update((document) => {
        const project = projectOf(document, projectId);
        if (project.gaps.length >= MAX_GAPS) throw new Error("缺口数量已达上限，请先关闭旧缺口");
        const gap = {
          id: randomUUID(),
          question: gapQuestion,
          note: gapNote,
          status: "open",
          createdAt: new Date().toISOString(),
          closedAt: null,
        };
        project.gaps.push(gap);
        return cloneGap(gap);
      });
    },
    async setGapStatus(projectId, gapId, status, note) {
      requireProject(projectId);
      if (status !== "open" && status !== "closed") throw new TypeError("缺口状态无效");
      const gapNote = optionalText(note, "备注", MAX_GAP_TEXT);
      return store.update((document) => {
        const project = document.projects.find((item) => item.projectId === projectId);
        const gap = project?.gaps.find((item) => item.id === gapId);
        if (!gap) return null;
        gap.status = status;
        gap.closedAt = status === "closed" ? new Date().toISOString() : null;
        if (gapNote !== undefined) gap.note = gapNote;
        return cloneGap(gap);
      });
    },
    // Only confirmed cards are searchable: a pending proposal must not silently
    // become context for the model.
    async retrieve(projectId, query, limit = DEFAULT_RETRIEVAL_LIMIT) {
      requireProject(projectId);
      const { projects } = await store.read();
      const project = projects.find((item) => item.projectId === projectId);
      if (!project) return [];
      return rankCards(project.cards.filter((card) => card.status === "confirmed"), query, limit);
    },
  });
}
