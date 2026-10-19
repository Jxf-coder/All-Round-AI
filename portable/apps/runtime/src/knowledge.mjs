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
export const MAX_REGRESSION_QUESTIONS = 60;
export const MAX_REGRESSION_RUNS = 20;
export const REGRESSION_HITS = 5;

const KIND_SET = new Set(CARD_KINDS);
const STATUS_SET = new Set(CARD_STATUSES);
const MAX_CARDS = 500;
const MAX_GAPS = 200;
const MAX_REGRESSION_QUESTION = 200;

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateRegression(regression) {
  // Regression questions arrived after cards and gaps; documents written before
  // that simply have no `regression` key and stay readable.
  if (regression === undefined) return;
  if (!regression || typeof regression !== "object"
    || !Array.isArray(regression.questions) || !Array.isArray(regression.runs)) {
    throw new Error("All Round AI knowledge store contains an invalid regression record");
  }
  for (const question of regression.questions) {
    if (!question || typeof question !== "object"
      || typeof question.id !== "string" || !question.id
      || typeof question.q !== "string" || !question.q
      || question.from !== "manual"
      || !isIsoTimestamp(question.addedAt)
      || (question.baseline !== undefined
        && (!Array.isArray(question.baseline)
          || !question.baseline.every((id) => typeof id === "string")))) {
      throw new Error("All Round AI knowledge store contains an invalid regression question");
    }
  }
  for (const run of regression.runs) {
    if (!run || typeof run !== "object"
      || typeof run.id !== "string" || !run.id
      || !isIsoTimestamp(run.at)
      || typeof run.reason !== "string"
      || !Number.isSafeInteger(run.total) || !Number.isSafeInteger(run.passed)
      || (run.retained !== null && typeof run.retained !== "number")
      || !Array.isArray(run.items)
      || !run.items.every((item) => item && typeof item === "object"
        && typeof item.id === "string"
        && typeof item.q === "string"
        && Array.isArray(item.hits)
        && item.hits.every((id) => typeof id === "string")
        && typeof item.pass === "boolean"
        && (item.retained === null || typeof item.retained === "number"))) {
      throw new Error("All Round AI knowledge store contains an invalid regression run");
    }
  }
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
    validateRegression(project.regression);
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

function emptyRegression() {
  return { questions: [], runs: [] };
}

function cloneRegressionQuestion(question) {
  return {
    id: question.id,
    q: question.q,
    from: question.from,
    addedAt: question.addedAt,
    baseline: question.baseline ? [...question.baseline] : null,
  };
}

function cloneRegressionRun(run) {
  return {
    id: run.id,
    at: run.at,
    reason: run.reason,
    total: run.total,
    passed: run.passed,
    retained: run.retained,
    items: run.items.map((item) => ({ ...item, hits: [...item.hits] })),
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
      project = { projectId, cards: [], gaps: [], regression: emptyRegression() };
      document.projects.push(project);
    }
    project.regression ??= emptyRegression();
    return project;
  }

  function summarize(project) {
    const cards = project.cards.map(cloneCard);
    const gaps = project.gaps.map(cloneGap);
    const regression = project.regression ?? emptyRegression();
    const questions = regression.questions.map(cloneRegressionQuestion);
    const runs = regression.runs.slice(-5).map(cloneRegressionRun);
    const lastRun = runs.at(-1) ?? null;
    return {
      projectId: project.projectId,
      cards: [...cards].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      gaps: [...gaps].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      regression: { questions, runs },
      stats: {
        cards: cards.length,
        pending: cards.filter((card) => card.status === "pending").length,
        confirmed: cards.filter((card) => card.status === "confirmed").length,
        dropped: cards.filter((card) => card.status === "dropped").length,
        gapsOpen: gaps.filter((gap) => gap.status === "open").length,
        gapsClosed: gaps.filter((gap) => gap.status === "closed").length,
        regressionQuestions: questions.length,
        regressionPassed: lastRun ? lastRun.passed : null,
        regressionTotal: lastRun ? lastRun.total : null,
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
    // Regression questions replay retrieval after an upgrade: the first run
    // records which cards answered each question, later runs report how many of
    // those baseline cards are still found. No model call is involved.
    async addRegressionQuestion(projectId, question) {
      requireProject(projectId);
      const value = text(question, "问题", MAX_REGRESSION_QUESTION);
      if (value.length < 4) throw new TypeError("问题太短");
      return store.update((document) => {
        const project = projectOf(document, projectId);
        const duplicate = project.regression.questions.find((item) => item.q === value);
        if (duplicate) return cloneRegressionQuestion(duplicate);
        if (project.regression.questions.length >= MAX_REGRESSION_QUESTIONS) {
          throw new Error(`回归题最多 ${MAX_REGRESSION_QUESTIONS} 道`);
        }
        const item = {
          id: randomUUID(),
          q: value,
          from: "manual",
          addedAt: new Date().toISOString(),
        };
        project.regression.questions.push(item);
        return cloneRegressionQuestion(item);
      });
    },
    async removeRegressionQuestion(projectId, id) {
      requireProject(projectId);
      return store.update((document) => {
        const project = document.projects.find((item) => item.projectId === projectId);
        const questions = project?.regression?.questions;
        if (!questions) return false;
        const index = questions.findIndex((item) => item.id === id);
        if (index === -1) return false;
        questions.splice(index, 1);
        return true;
      });
    },
    async runRegression(projectId, reason = "手动运行") {
      requireProject(projectId);
      const label = typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 120)
        : "手动运行";
      return store.update((document) => {
        const project = projectOf(document, projectId);
        const questions = project.regression.questions;
        if (questions.length === 0) return null;
        const confirmed = project.cards.filter((card) => card.status === "confirmed");
        const items = questions.map((question) => {
          const hits = rankCards(confirmed, question.q, REGRESSION_HITS).map((card) => card.id);
          const pass = hits.length > 0;
          let retained = null;
          if (question.baseline?.length) {
            retained = question.baseline.filter((id) => hits.includes(id)).length / question.baseline.length;
          } else if (pass) {
            // The first successful run becomes the baseline to compare against.
            question.baseline = hits.slice(0, REGRESSION_HITS);
          }
          return { id: question.id, q: question.q, hits, pass, retained };
        });
        const scored = items.filter((item) => item.retained !== null);
        const run = {
          id: randomUUID(),
          at: new Date().toISOString(),
          reason: label,
          total: items.length,
          passed: items.filter((item) => item.pass).length,
          retained: scored.length
            ? Math.round((scored.reduce((sum, item) => sum + item.retained, 0) / scored.length) * 100) / 100
            : null,
          items,
        };
        project.regression.runs.push(run);
        if (project.regression.runs.length > MAX_REGRESSION_RUNS) {
          project.regression.runs = project.regression.runs.slice(-MAX_REGRESSION_RUNS);
        }
        return cloneRegressionRun(run);
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
