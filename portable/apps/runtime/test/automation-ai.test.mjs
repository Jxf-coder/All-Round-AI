import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildScriptPrompt, createScriptDraftHandler } from "../src/automation-ai.mjs";

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
