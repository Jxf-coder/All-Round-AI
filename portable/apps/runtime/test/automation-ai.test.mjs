import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRewritePrompt,
  buildScriptPrompt,
  buildTopicPrompt,
  createRewriteHandler,
  createScriptDraftHandler,
  createTopicPackHandler,
} from "../src/automation-ai.mjs";

const PARAMS = {
  topic: "售后响应",
  audience: "boss",
  durationSec: 45,
  tone: "sharp",
  maxCards: 2,
};

function runLike() {
  return { id: "run_demo", projectId: "project-1", steps: {} };
}

async function withDir(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-automation-ai-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the prompt carries the task and only the confirmed cards", () => {
  const text = buildScriptPrompt(PARAMS, [
    { kind: "fact", title: "响应时效", body: "工作日 2 小时内响应。" },
  ]);
  assert.match(text, /主题：售后响应/u);
  assert.match(text, /受众：企业老板/u);
  assert.match(text, /目标时长：约 45 秒/u);
  assert.match(text, /语气：直接犀利/u);
  assert.match(text, /\[fact\] 响应时效：工作日 2 小时内响应。/u);

  const empty = buildScriptPrompt(PARAMS, []);
  assert.match(empty, /暂无已确认知识卡/u);
});

test("the handler quotes confirmed knowledge, writes the artifact and reports the model", async () => {
  await withDir(async (root) => {
    const calls = [];
    const handler = createScriptDraftHandler({
      chat: async ({ messages }) => {
        calls.push(messages);
        return { content: "镜头 1：先算一笔账。\n镜头 2：售后两小时响应。", model: "test-model" };
      },
      knowledgeStore: {
        list: async () => ({
          cards: [
            { kind: "fact", status: "confirmed", title: "响应时效", body: "工作日 2 小时内响应。" },
            { kind: "fact", status: "confirmed", title: "服务范围", body: "全国联保。" },
            { kind: "fact", status: "pending", title: "未确认", body: "不应出现。" },
            { kind: "faq", status: "dropped", title: "已丢弃", body: "也不应出现。" },
          ],
        }),
      },
      artifactsDir: root,
    });

    const outcome = await handler["ai.script-draft"]({ run: runLike(), params: PARAMS });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].role, "system");
    assert.equal(calls[0][1].role, "user");
    assert.match(calls[0][1].content, /响应时效/u);
    assert.match(calls[0][1].content, /服务范围/u);
    assert.equal(calls[0][1].content.includes("未确认"), false);
    assert.equal(calls[0][1].content.includes("已丢弃"), false);

    const artifact = outcome.artifacts[0];
    assert.equal(artifact.slot, "script");
    assert.match(artifact.path, /run_demo[\\/]script\.md$/u);
    assert.ok(artifact.bytes > 0);
    const text = await readFile(artifact.path, "utf8");
    assert.match(text, /^# 口播脚本草稿/u);
    assert.match(text, /镜头 1：先算一笔账。/u);
    assert.match(text, /引用知识卡：2 张/u);
    assert.deepEqual(outcome.logs, ["引用已确认知识卡 2 张", "模型：test-model"]);
  });
});

test("a card limit of zero sends no knowledge and an empty reply fails the step", async () => {
  await withDir(async (root) => {
    const prompts = [];
    const handler = createScriptDraftHandler({
      chat: async ({ messages }) => {
        prompts.push(messages[1].content);
        return { content: "   " };
      },
      knowledgeStore: {
        list: async () => ({
          cards: [{ kind: "fact", status: "confirmed", title: "响应时效", body: "两小时。" }],
        }),
      },
      artifactsDir: root,
    });

    await assert.rejects(
      handler["ai.script-draft"]({ run: runLike(), params: { ...PARAMS, maxCards: 0 } }),
      /模型没有返回脚本内容/u,
    );
    assert.match(prompts[0], /暂无已确认知识卡/u);
    assert.equal(prompts[0].includes("响应时效"), false);
  });
});

test("the handler refuses to be built without a model call", () => {
  assert.throws(
    () => createScriptDraftHandler({ chat: null, knowledgeStore: { list: async () => ({ cards: [] }) }, artifactsDir: os.tmpdir() }),
    /需要注入模型调用/u,
  );
  assert.throws(
    () => createScriptDraftHandler({ chat: async () => ({}), knowledgeStore: {}, artifactsDir: os.tmpdir() }),
    /知识库存储/u,
  );
  assert.throws(
    () => createScriptDraftHandler({ chat: async () => ({}), knowledgeStore: { list: async () => ({ cards: [] }) }, artifactsDir: "relative" }),
    /产物目录必须是绝对路径/u,
  );
});

const TOPIC_PARAMS = { count: 3, audience: "switcher", focus: "售后", maxCards: 1 };
const REWRITE_PARAMS = {
  draft: "旧稿第一段。\n旧稿第二段。",
  audience: "operator",
  durationSec: 30,
  tone: "warm",
  maxCards: 1,
};

test("topic and rewrite prompts carry their own task and the confirmed knowledge", () => {
  const cards = [{ kind: "fact", title: "响应时效", body: "工作日 2 小时内响应。" }];
  const topic = buildTopicPrompt(TOPIC_PARAMS, cards);
  assert.match(topic, /受众：转型者/u);
  assert.match(topic, /需要 3 条选题/u);
  assert.match(topic, /聚焦方向：售后/u);
  assert.match(topic, /\[fact\] 响应时效：工作日 2 小时内响应。/u);
  assert.match(buildTopicPrompt(TOPIC_PARAMS, []), /待补知识/u);

  const rewrite = buildRewritePrompt(REWRITE_PARAMS, cards);
  assert.match(rewrite, /受众：操盘手/u);
  assert.match(rewrite, /目标时长：约 30 秒/u);
  assert.match(rewrite, /语气：温和陪伴/u);
  assert.match(rewrite, /原始草稿：\n旧稿第一段。\n旧稿第二段。/u);
  assert.match(rewrite, /响应时效/u);
  assert.match(buildRewritePrompt(REWRITE_PARAMS, []), /需人工核对/u);
});

test("topic and rewrite handlers write their artifacts and only quote confirmed cards", async () => {
  await withDir(async (root) => {
    const prompts = [];
    const knowledgeStore = {
      list: async () => ({
        cards: [
          { kind: "fact", status: "confirmed", title: "响应时效", body: "两小时响应。" },
          { kind: "fact", status: "pending", title: "未确认", body: "不应出现。" },
        ],
      }),
    };
    const chat = async ({ messages }) => {
      prompts.push(messages[1].content);
      if (messages[0].content.includes("改写")) {
        return { content: "镜头 1：旧稿第一段。\n需人工核对：无。", model: "test-model" };
      }
      return { content: "## 选题 1：售后不是成本\n- 依据：响应时效", model: "test-model" };
    };

    const topics = await createTopicPackHandler({ chat, knowledgeStore, artifactsDir: root })
      ["ai.topic-pack"]({ run: runLike(), params: TOPIC_PARAMS });
    assert.equal(topics.artifacts[0].slot, "topics");
    assert.match(topics.artifacts[0].path, /run_demo[\\/]topics\.md$/u);
    const topicText = await readFile(topics.artifacts[0].path, "utf8");
    assert.match(topicText, /^# 选题提案/u);
    assert.match(topicText, /- 受众：转型者/u);
    assert.match(topicText, /- 聚焦方向：售后/u);
    assert.match(topicText, /- 引用知识卡：1 张/u);
    assert.match(topicText, /## 选题 1：售后不是成本/u);
    assert.deepEqual(topics.logs, ["引用已确认知识卡 1 张", "模型：test-model"]);

    const rewrite = await createRewriteHandler({ chat, knowledgeStore, artifactsDir: root })
      ["ai.script-rewrite"]({ run: runLike(), params: REWRITE_PARAMS });
    assert.equal(rewrite.artifacts[0].slot, "rewrite");
    const rewriteText = await readFile(rewrite.artifacts[0].path, "utf8");
    assert.match(rewriteText, /^# 口播改写稿/u);
    assert.match(rewriteText, /- 原稿字数：13/u);
    assert.match(rewriteText, /- 引用知识卡：1 张/u);
    assert.match(rewriteText, /镜头 1：/u);

    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.match(prompt, /响应时效/u);
      assert.equal(prompt.includes("未确认"), false);
    }
  });
});

test("an empty reply fails the topic step instead of writing an empty artifact", async () => {
  await withDir(async (root) => {
    const handler = createTopicPackHandler({
      chat: async () => ({ content: "   " }),
      knowledgeStore: { list: async () => ({ cards: [] }) },
      artifactsDir: root,
    });
    await assert.rejects(
      handler["ai.topic-pack"]({ run: runLike(), params: TOPIC_PARAMS }),
      /模型没有返回选题内容/u,
    );
  });
});
