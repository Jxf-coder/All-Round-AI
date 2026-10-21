import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// AI-backed script drafting for the automation engine.
//
// The handler owns the prompt and the artifact; the model call itself is
// injected, so tests run without a provider and a local Ollama install swaps in
// without touching the pipeline definition. Only confirmed knowledge cards are
// quoted, and the model is told to say so when it has no fact to rely on.
// ---------------------------------------------------------------------------

const AUDIENCE_LABELS = { boss: "企业老板", switcher: "转型者", operator: "操盘手" };
const TONE_LABELS = { sincere: "真诚克制", sharp: "直接犀利", warm: "温和陪伴" };
const MAX_CARDS = 20;

const SYSTEM_PROMPT = [
  "你是 All Round AI 工作台的口播脚本撰稿人。",
  "规则：",
  "1. 只使用用户提供的「已确认知识」讲公司事实；没有依据时明确提醒补充知识，不要编造数字、案例或承诺。",
  "2. 输出可直接口播的中文脚本，按镜头分行：每行以「镜头 N：」开头，后面是这一镜要说的话。",
  "3. 开头 3 秒要有钩子，结尾给出一个具体行动建议。",
  "4. 不要输出解释、标题以外的说明，也不要使用 Markdown 表格。",
].join("\n");

function safeRunId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function knowledgeBlock(cards) {
  if (!cards.length) return "（暂无已确认知识卡。请不要编造公司事实，并在脚本开头提醒使用者补充知识。）";
  return cards.map((card) => `- [${card.kind}] ${card.title}：${card.body}`).join("\n");
}

export function buildScriptPrompt(params, cards) {
  return [
    `主题：${params.topic}`,
    `受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
    `目标时长：约 ${params.durationSec} 秒`,
    `语气：${TONE_LABELS[params.tone] ?? params.tone}`,
    "",
    "已确认知识：",
    knowledgeBlock(cards),
    "",
    "请按规则写出脚本。",
  ].join("\n");
}

export function createScriptDraftHandler({ chat, knowledgeStore, artifactsDir }) {
  if (typeof chat !== "function") throw new TypeError("脚本产线需要注入模型调用");
  if (!knowledgeStore || typeof knowledgeStore.list !== "function") {
    throw new TypeError("脚本产线需要知识库存储");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "ai.script-draft": async ({ run, params }) => {
      const knowledge = await knowledgeStore.list(run.projectId);
      const limit = Number.isSafeInteger(params.maxCards) ? Math.min(params.maxCards, MAX_CARDS) : 5;
      const cards = knowledge.cards
        .filter((card) => card.status === "confirmed")
        .slice(0, limit)
        .map((card) => ({ kind: card.kind, title: card.title, body: card.body }));
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildScriptPrompt(params, cards) },
      ];
      const reply = await chat({ messages });
      const content = typeof reply === "string" ? reply : reply?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("模型没有返回脚本内容");
      }
      const lines = [
        "# 口播脚本草稿",
        "",
        `- 主题：${params.topic}`,
        `- 受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
        `- 目标时长：约 ${params.durationSec} 秒`,
        `- 语气：${TONE_LABELS[params.tone] ?? params.tone}`,
        `- 引用知识卡：${cards.length} 张`,
        "",
        content.trim(),
        "",
      ];
      const directory = path.join(artifactsDir, safeRunId(run.id));
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "script.md");
      const text = lines.join("\n");
      await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
      return {
        artifacts: [{
          slot: "script",
          label: "脚本草稿",
          path: file,
          bytes: Buffer.byteLength(text, "utf8"),
        }],
        logs: [
          `引用已确认知识卡 ${cards.length} 张`,
          `模型：${typeof reply?.model === "string" ? reply.model : "未知"}`,
        ],
      };
    },
  });
}
