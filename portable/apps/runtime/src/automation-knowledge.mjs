import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Step handlers for the built-in knowledge pipeline.
//
// Handlers only read the project's knowledge store and write artifacts under
// the runtime's artifacts directory. They never call an external service, so a
// failed step is reproducible and a resumed run produces the same output.
// ---------------------------------------------------------------------------

const CARD_KIND_LABELS = { fact: "事实", decision: "决策", preference: "偏好", faq: "问答", method: "方法" };
const PREVIEW_LIMIT = 10;

function safeRunId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

export function createKnowledgeBriefHandlers({ knowledgeStore, artifactsDir }) {
  if (!knowledgeStore || typeof knowledgeStore.list !== "function") {
    throw new TypeError("知识简报需要知识库存储");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  async function writeArtifact(runId, name, text) {
    const directory = path.join(artifactsDir, safeRunId(runId));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
    return { path: file, bytes: Buffer.byteLength(text, "utf8") };
  }

  async function readSnapshot(run) {
    const artifact = (run.steps.snapshot?.artifacts ?? []).find((entry) => entry.slot === "snapshot");
    if (!artifact) throw new Error("上一步没有生成知识快照，无法继续");
    const parsed = JSON.parse(await readFile(artifact.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.stats) {
      throw new Error("知识快照格式无效");
    }
    return parsed;
  }

  return Object.freeze({
    "knowledge.snapshot": async ({ run, params }) => {
      const data = await knowledgeStore.list(run.projectId);
      const maxCards = Number.isSafeInteger(params.maxCards) ? params.maxCards : 20;
      const includeGaps = params.includeGaps !== false;
      const snapshot = {
        projectId: run.projectId,
        at: new Date().toISOString(),
        includeGaps,
        stats: data.stats,
        cards: data.cards
          .filter((card) => card.status !== "dropped")
          .slice(0, maxCards)
          .map((card) => ({ id: card.id, kind: card.kind, status: card.status, title: card.title })),
        gaps: includeGaps
          ? data.gaps
            .filter((gap) => gap.status === "open")
            .map((gap) => ({ id: gap.id, text: gap.text, createdAt: gap.createdAt }))
          : [],
      };
      const file = await writeArtifact(run.id, "snapshot.json", `${JSON.stringify(snapshot, null, 2)}\n`);
      return {
        artifacts: [{ slot: "snapshot", label: "知识快照", ...file }],
        logs: [
          `知识卡 ${data.stats.cards} 张（已确认 ${data.stats.confirmed}、待确认 ${data.stats.pending}），本次纳入 ${snapshot.cards.length} 张`,
          includeGaps ? `未关闭缺口 ${data.stats.gapsOpen} 个` : "按参数跳过未关闭缺口",
        ],
      };
    },

    "knowledge.brief": async ({ run, params }) => {
      const snapshot = await readSnapshot(run);
      const heading = typeof params.title === "string" && params.title !== "" ? params.title : run.projectId;
      const confirmed = snapshot.cards.filter((card) => card.status === "confirmed");
      const pending = snapshot.cards.filter((card) => card.status === "pending");
      const lines = [
        `# 知识简报 · ${heading}`,
        "",
        `生成时间：${new Date().toISOString()}`,
        "",
        "## 概览",
        "",
        `- 知识卡：${snapshot.stats.cards} 张（已确认 ${snapshot.stats.confirmed}，待确认 ${snapshot.stats.pending}，已丢弃 ${snapshot.stats.dropped}）`,
        `- 本次纳入：${snapshot.cards.length} 张`,
        `- 缺口：未关闭 ${snapshot.stats.gapsOpen} 个，已关闭 ${snapshot.stats.gapsClosed} 个`,
        `- 回归问题：${snapshot.stats.regressionQuestions} 个`,
      ];
      if (snapshot.stats.regressionTotal !== null && snapshot.stats.regressionTotal !== undefined) {
        lines.push(`- 最近一次回归：保留 ${snapshot.stats.regressionPassed}/${snapshot.stats.regressionTotal}`);
      }
      lines.push(
        "",
        "## 已确认知识",
        "",
        ...(confirmed.length
          ? confirmed.slice(0, PREVIEW_LIMIT).map((card) => `- [${CARD_KIND_LABELS[card.kind] ?? card.kind}] ${card.title}`)
          : ["- 暂无已确认的知识卡"]),
      );
      if (confirmed.length > PREVIEW_LIMIT) lines.push(`- 其余 ${confirmed.length - PREVIEW_LIMIT} 张见知识库`);
      lines.push(
        "",
        "## 待确认知识",
        "",
        ...(pending.length
          ? pending.slice(0, PREVIEW_LIMIT).map((card) => `- [${CARD_KIND_LABELS[card.kind] ?? card.kind}] ${card.title}`)
          : ["- 没有待确认的知识卡"]),
      );
      if (pending.length > PREVIEW_LIMIT) lines.push(`- 其余 ${pending.length - PREVIEW_LIMIT} 张见知识库`);
      lines.push(
        "",
        "## 未关闭缺口",
        "",
        ...(snapshot.includeGaps === false
          ? ["- 本次运行未纳入缺口（可在启动参数里打开）"]
          : snapshot.gaps.length
            ? snapshot.gaps.slice(0, PREVIEW_LIMIT).map((gap) => `- ${gap.text}`)
            : ["- 没有未关闭的缺口"]),
      );
      if (snapshot.gaps.length > PREVIEW_LIMIT) lines.push(`- 其余 ${snapshot.gaps.length - PREVIEW_LIMIT} 个缺口见知识库`);
      lines.push("");
      const file = await writeArtifact(run.id, "brief.md", lines.join("\n"));
      return {
        artifacts: [{ slot: "brief", label: "知识简报", ...file }],
        logs: [`已生成 Markdown 简报，共 ${confirmed.length} 张已确认知识`],
      };
    },
  });
}
