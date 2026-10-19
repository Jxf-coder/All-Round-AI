import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildKnowledgeBlock,
  createKnowledgeStore,
  MAX_CARD_TITLE,
  queryTerms,
  rankCards,
} from "../src/knowledge.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-knowledge-"));
  const filePath = path.join(root, "knowledge.json");
  try {
    await run({ filePath, store: await createKnowledgeStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a project with no knowledge reads as empty without being written", async () => {
  await withStore(async ({ filePath, store }) => {
    const empty = await store.list("project-1");
    assert.deepEqual(empty.cards, []);
    assert.deepEqual(empty.gaps, []);
    assert.deepEqual(empty.stats, {
      cards: 0,
      pending: 0,
      confirmed: 0,
      dropped: 0,
      gapsOpen: 0,
      gapsClosed: 0,
      regressionQuestions: 0,
      regressionPassed: null,
      regressionTotal: null,
    });
    assert.deepEqual(empty.regression, { questions: [], runs: [] });
    // Nothing exists on disk yet, so a read must not have created the file.
    await assert.rejects(readFile(filePath, "utf8"), /ENOENT/u);
    await assert.rejects(store.list(""), TypeError);
  });
});

test("cards start pending and carry validated fields", async () => {
  await withStore(async ({ store }) => {
    const card = await store.addCard("project-1", {
      kind: "fact",
      title: "主推产品",
      body: "主推产品是折叠彩虹琴。",
      source: "产品手册",
    });
    assert.equal(card.status, "pending", "a new card is proposed, not trusted");
    assert.equal(card.source, "产品手册");
    assert.equal(typeof card.id, "string");
    // A blank source is "not provided" rather than an error.
    assert.equal((await store.addCard("project-1", { kind: "fact", title: "空来源", body: "x", source: "" })).source, null);

    await assert.rejects(store.addCard("project-1", { kind: "rumour", title: "x", body: "y" }), /类型无效/u);
    await assert.rejects(store.addCard("project-1", { kind: "fact", title: "   ", body: "y" }), /标题不能为空/u);
    await assert.rejects(store.addCard("project-1", { kind: "fact", title: "x", body: "" }), /内容不能为空/u);
    await assert.rejects(
      store.addCard("project-1", { kind: "fact", title: "x".repeat(MAX_CARD_TITLE + 1), body: "y" }),
      /标题不能超过/u,
    );

    const confirmed = await store.setCardStatus("project-1", card.id, "confirmed");
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual((await store.list("project-1")).stats, {
      cards: 2,
      pending: 1,
      confirmed: 1,
      dropped: 0,
      gapsOpen: 0,
      gapsClosed: 0,
      regressionQuestions: 0,
      regressionPassed: null,
      regressionTotal: null,
    });
    await assert.rejects(store.setCardStatus("project-1", card.id, "trusted"), /状态无效/u);
    assert.equal(await store.setCardStatus("project-1", "missing", "confirmed"), null);
    assert.equal(await store.removeCard("project-1", "missing"), false);
    assert.equal(await store.removeCard("project-1", card.id), true);
    // Only the targeted card is gone.
    const remaining = await store.list("project-1");
    assert.equal(remaining.stats.cards, 1);
    assert.equal(remaining.cards[0].title, "空来源");
  });
});

test("gaps open, close and reopen with their note", async () => {
  await withStore(async ({ store }) => {
    const gap = await store.addGap("project-1", { question: "优惠券和会员价能否叠加？" });
    assert.equal(gap.status, "open");
    assert.equal(gap.closedAt, null);

    const closed = await store.setGapStatus("project-1", gap.id, "closed", "已在 9 月政策里写清");
    assert.equal(closed.status, "closed");
    assert.equal(closed.note, "已在 9 月政策里写清");
    assert.equal(typeof closed.closedAt, "string");

    const reopened = await store.setGapStatus("project-1", gap.id, "open");
    assert.equal(reopened.status, "open");
    assert.equal(reopened.closedAt, null);
    // Reopening without a note keeps the previous note.
    assert.equal(reopened.note, "已在 9 月政策里写清");

    assert.equal(await store.setGapStatus("project-1", "missing", "closed"), null);
    await assert.rejects(store.setGapStatus("project-1", gap.id, "resolved"), /缺口状态无效/u);
    await assert.rejects(store.addGap("project-1", { question: "  " }), /问题不能为空/u);
    // A blank or absent note means "not provided", so an empty input box is not
    // reported as a missing required field.
    assert.equal((await store.addGap("project-1", { question: "没有备注", note: "" })).note, "");
    assert.equal((await store.addGap("project-1", { question: "没有备注 2", note: "   " })).note, "");
    await assert.rejects(store.addGap("project-1", { question: "x", note: 7 }), /备注必须是字符串/u);

    const state = await store.list("project-1");
    // The reopened gap plus the two note-less gaps added above.
    assert.equal(state.stats.gapsOpen, 3);
    assert.equal(state.stats.gapsClosed, 0);
  });
});

test("knowledge is scoped to its project", async () => {
  await withStore(async ({ store }) => {
    await store.addCard("project-1", { kind: "fact", title: "A", body: "甲" });
    await store.addGap("project-2", { question: "乙" });
    assert.equal((await store.list("project-1")).stats.cards, 1);
    assert.equal((await store.list("project-1")).stats.gapsOpen, 0);
    assert.equal((await store.list("project-2")).stats.cards, 0);
    assert.equal((await store.list("project-2")).stats.gapsOpen, 1);
  });
});

test("retrieval ranks by relevance and only trusts confirmed cards", async () => {
  await withStore(async ({ store }) => {
    const primary = await store.addCard("project-1", {
      kind: "fact", title: "主推产品", body: "主推产品是折叠彩虹琴。",
    });
    const secondary = await store.addCard("project-1", {
      kind: "faq", title: "售后流程", body: "客户问产品问题时先查卖点文档，再回复。",
    });
    const unrelated = await store.addCard("project-1", {
      kind: "preference", title: "回复风格", body: "回答简短，先给结论。",
    });
    for (const card of [primary, secondary, unrelated]) {
      await store.setCardStatus("project-1", card.id, "confirmed");
    }

    // A pending card is never returned, even when it matches.
    const pending = await store.addCard("project-1", {
      kind: "fact",
      title: "产品颜色",
      body: "产品共有五种颜色，另有渐变与限定版，具体以色卡与库存表为准，下单前请再确认。",
    });
    const ranked = await store.retrieve("project-1", "产品卖点");
    assert.deepEqual(ranked.map((card) => card.id), [primary.id, secondary.id]);

    await store.setCardStatus("project-1", pending.id, "confirmed");
    const withPending = await store.retrieve("project-1", "产品");
    assert.equal(withPending.length, 3);
    // A short card that matches in its title outranks a long card that only
    // mentions the term somewhere in its body.
    assert.deepEqual(withPending.map((card) => card.id), [primary.id, pending.id, secondary.id]);

    // Dropping a card removes it from retrieval again.
    await store.setCardStatus("project-1", primary.id, "dropped");
    assert.equal((await store.retrieve("project-1", "产品")).some((card) => card.id === primary.id), false);

    // The limit is honoured and a question sharing no term retrieves nothing.
    assert.equal((await store.retrieve("project-1", "产品", 1)).length, 1);
    assert.deepEqual(await store.retrieve("project-1", "今天天气如何"), []);
    assert.deepEqual(await store.retrieve("project-1", ""), []);
  });
});

test("query terms cover latin words and CJK runs, and the block renders cards", () => {
  assert.deepEqual(queryTerms("SEO 优化").sort(), ["seo", "优化"].sort());
  // A CJK run is tokenised into overlapping bigrams, since it has no spaces.
  assert.deepEqual(queryTerms("产品卖点").sort(), ["产品", "品卖", "卖点"].sort());
  assert.deepEqual(queryTerms("a"), []);

  assert.deepEqual(rankCards([], "产品"), []);
  assert.equal(buildKnowledgeBlock([]), "");
  const block = buildKnowledgeBlock([{ kind: "fact", title: "主推产品", body: "折叠彩虹琴" }]);
  assert.match(block, /^## 与本轮相关的知识卡片/u);
  assert.match(block, /### \[fact\] 主推产品\n折叠彩虹琴/u);
});

test("knowledge survives a restart and damaged documents fail closed", async () => {
  await withStore(async ({ filePath, store }) => {
    await store.addCard("project-1", { kind: "fact", title: "保留", body: "内容" });
    const reopened = await createKnowledgeStore(filePath);
    assert.equal((await reopened.list("project-1")).cards[0].title, "保留");

    await writeFile(filePath, JSON.stringify({ version: 1, projects: [{ projectId: "p", cards: [{ id: "a" }], gaps: [] }] }), "utf8");
    await assert.rejects(reopened.list("project-1"), /invalid card/u);
    await writeFile(filePath, JSON.stringify({ version: 1, projects: [{ projectId: "p", cards: [], gaps: [{ id: "a", question: "q", status: "unknown" }] }] }), "utf8");
    await assert.rejects(reopened.list("project-1"), /invalid gap/u);
    await writeFile(filePath, JSON.stringify({ version: 2, projects: [] }), "utf8");
    await assert.rejects(reopened.list("project-1"), /unsupported or damaged/u);
  });
});
