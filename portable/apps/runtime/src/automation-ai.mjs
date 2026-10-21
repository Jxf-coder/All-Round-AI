import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// AI-backed text steps for the automation engine.
//
// A handler owns its prompt and artifact; the model call is injected, so tests
// run without a provider and a local Ollama install swaps in without touching
// the pipeline definition. Only confirmed knowledge cards are quoted, and the
// model is told to say so when it has no fact to rely on.
// ---------------------------------------------------------------------------

const AUDIENCE_LABELS = { boss: "企业老板", switcher: "转型者", operator: "操盘手" };
const TONE_LABELS = { sincere: "真诚克制", sharp: "直接犀利", warm: "温和陪伴" };
const MAX_CARDS = 20;

const SCRIPT_SYSTEM_PROMPT = [
  "你是 All Round AI 工作台的口播脚本撰稿人。",
  "规则：",
  "1. 只使用用户提供的「已确认知识」讲公司事实；没有依据时明确提醒补充知识，不要编造数字、案例或承诺。",
  "2. 输出可直接口播的中文脚本，按镜头分行：每行以「镜头 N：」开头，后面是这一镜要说的话。",
  "3. 开头 3 秒要有钩子，结尾给出一个具体行动建议。",
  "4. 不要输出解释、标题以外的说明，也不要使用 Markdown 表格。",
].join("\n");

const TOPIC_SYSTEM_PROMPT = [
  "你是 All Round AI 工作台的内容策划。",
  "规则：",
  "1. 只依据用户提供的「已确认知识」提出选题；知识不足时把依据写成「待补知识」，不要编造产品、数字或案例。",
  "2. 每条选题严格按以下格式输出：",
  "## 选题 N：标题（不超过 20 字）",
  "- 受众：这条选题具体对谁说话",
  "- 角度：一句话说明这个受众为什么会在意",
  "- 依据：引用哪条已确认知识；没有依据就写「待补知识」",
  "3. 按指定数量输出，不要写脚本正文、解释或 Markdown 表格。",
].join("\n");

const REWRITE_SYSTEM_PROMPT = [
  "你是 All Round AI 工作台的口播改写编辑。",
  "规则：",
  "1. 保留原稿的事实与立场，不新增数字、案例或承诺；与已确认知识冲突时以知识为准，并在结尾列出「需人工核对」。",
  "2. 把原稿改写成可直接口播的中文，按「镜头 N：」分行，符合目标时长与语气。",
  "3. 不要输出解释、Markdown 表格，也不要整段复述原稿。",
].join("\n");

function safeRunId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function knowledgeBlock(cards, emptyHint) {
  if (!cards.length) return emptyHint;
  return cards.map((card) => `- [${card.kind}] ${card.title}：${card.body}`).join("\n");
}

async function confirmedCards(knowledgeStore, projectId, maxCards) {
  const knowledge = await knowledgeStore.list(projectId);
  const limit = Number.isSafeInteger(maxCards) ? Math.min(maxCards, MAX_CARDS) : 5;
  return knowledge.cards
    .filter((card) => card.status === "confirmed")
    .slice(0, limit)
    .map((card) => ({ kind: card.kind, title: card.title, body: card.body }));
}

function assertDependencies({ chat, knowledgeStore, artifactsDir }) {
  if (typeof chat !== "function") throw new TypeError("文本产线需要注入模型调用");
  if (!knowledgeStore || typeof knowledgeStore.list !== "function") {
    throw new TypeError("文本产线需要知识库存储");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
}

function replyText(reply, emptyMessage) {
  const content = typeof reply === "string" ? reply : reply?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error(emptyMessage);
  return content.trim();
}

async function writeArtifact(artifactsDir, runId, filename, lines) {
  const directory = path.join(artifactsDir, safeRunId(runId));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, filename);
  const text = lines.join("\n");
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return { path: file, bytes: Buffer.byteLength(text, "utf8") };
}

function modelName(reply) {
  return typeof reply?.model === "string" ? reply.model : "未知";
}

export function buildScriptPrompt(params, cards) {
  return [
    `主题：${params.topic}`,
    `受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
    `目标时长：约 ${params.durationSec} 秒`,
    `语气：${TONE_LABELS[params.tone] ?? params.tone}`,
    "",
    "已确认知识：",
    knowledgeBlock(cards, "（暂无已确认知识卡。请不要编造公司事实，并在脚本开头提醒使用者补充知识。）"),
    "",
    "请按规则写出脚本。",
  ].join("\n");
}

export function buildTopicPrompt(params, cards) {
  const focus = typeof params.focus === "string" && params.focus.trim() ? params.focus.trim() : "不限";
  return [
    `受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
    `需要 ${params.count} 条选题`,
    `聚焦方向：${focus}`,
    "",
    "已确认知识：",
    knowledgeBlock(cards, "（暂无已确认知识卡。每条选题的依据都必须写「待补知识」，不要编造公司事实。）"),
    "",
    `请按规则给出 ${params.count} 条选题。`,
  ].join("\n");
}

export function buildRewritePrompt(params, cards) {
  return [
    `受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
    `目标时长：约 ${params.durationSec} 秒`,
    `语气：${TONE_LABELS[params.tone] ?? params.tone}`,
    "",
    "原始草稿：",
    params.draft,
    "",
    "已确认知识：",
    knowledgeBlock(cards, "（暂无已确认知识卡。不要新增公司事实；原稿里的事实请标注「需人工核对」。）"),
    "",
    "请按规则改写。",
  ].join("\n");
}

export function createScriptDraftHandler(dependencies) {
  assertDependencies(dependencies);
  const { chat, knowledgeStore, artifactsDir } = dependencies;

  return Object.freeze({
    "ai.script-draft": async ({ run, params }) => {
      const cards = await confirmedCards(knowledgeStore, run.projectId, params.maxCards);
      const messages = [
        { role: "system", content: SCRIPT_SYSTEM_PROMPT },
        { role: "user", content: buildScriptPrompt(params, cards) },
      ];
      const reply = await chat({ messages });
      const content = replyText(reply, "模型没有返回脚本内容");
      const artifact = await writeArtifact(artifactsDir, run.id, "script.md", [
        "# 口播脚本草稿",
        "",
        `- 主题：${params.topic}`,
        `- 受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
        `- 目标时长：约 ${params.durationSec} 秒`,
        `- 语气：${TONE_LABELS[params.tone] ?? params.tone}`,
        `- 引用知识卡：${cards.length} 张`,
        "",
        content,
        "",
      ]);
      return {
        artifacts: [{ slot: "script", label: "脚本草稿", ...artifact }],
        logs: [
          `引用已确认知识卡 ${cards.length} 张`,
          `模型：${modelName(reply)}`,
        ],
      };
    },
  });
}

export function createTopicPackHandler(dependencies) {
  assertDependencies(dependencies);
  const { chat, knowledgeStore, artifactsDir } = dependencies;

  return Object.freeze({
    "ai.topic-pack": async ({ run, params }) => {
      const cards = await confirmedCards(knowledgeStore, run.projectId, params.maxCards);
      const focus = typeof params.focus === "string" && params.focus.trim() ? params.focus.trim() : "不限";
      const messages = [
        { role: "system", content: TOPIC_SYSTEM_PROMPT },
        { role: "user", content: buildTopicPrompt(params, cards) },
      ];
      const reply = await chat({ messages });
      const content = replyText(reply, "模型没有返回选题内容");
      const artifact = await writeArtifact(artifactsDir, run.id, "topics.md", [
        "# 选题提案",
        "",
        `- 受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
        `- 聚焦方向：${focus}`,
        `- 引用知识卡：${cards.length} 张`,
        "",
        content,
        "",
      ]);
      return {
        artifacts: [{ slot: "topics", label: "选题清单", ...artifact }],
        logs: [
          `引用已确认知识卡 ${cards.length} 张`,
          `模型：${modelName(reply)}`,
        ],
      };
    },
  });
}

export function createRewriteHandler(dependencies) {
  assertDependencies(dependencies);
  const { chat, knowledgeStore, artifactsDir } = dependencies;

  return Object.freeze({
    "ai.script-rewrite": async ({ run, params }) => {
      const cards = await confirmedCards(knowledgeStore, run.projectId, params.maxCards);
      const messages = [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        { role: "user", content: buildRewritePrompt(params, cards) },
      ];
      const reply = await chat({ messages });
      const content = replyText(reply, "模型没有返回改写内容");
      const artifact = await writeArtifact(artifactsDir, run.id, "rewrite.md", [
        "# 口播改写稿",
        "",
        `- 受众：${AUDIENCE_LABELS[params.audience] ?? params.audience}`,
        `- 目标时长：约 ${params.durationSec} 秒`,
        `- 语气：${TONE_LABELS[params.tone] ?? params.tone}`,
        `- 原稿字数：${params.draft.length}`,
        `- 引用知识卡：${cards.length} 张`,
        "",
        content,
        "",
      ]);
      return {
        artifacts: [{ slot: "rewrite", label: "改写稿", ...artifact }],
        logs: [
          `原稿 ${params.draft.length} 字，引用已确认知识卡 ${cards.length} 张`,
          `模型：${modelName(reply)}`,
        ],
      };
    },
  });
}
