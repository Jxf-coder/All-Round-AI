import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { mediaKindOf } from "./automation-media.mjs";
import { resolveAllowedFile } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Publishing preparation. No platform API is called: accounts, login state and
// upload endpoints differ per platform and would need real credentials to
// verify. This step produces the two things a manual publish actually needs —
// a checked plan and a machine-readable manifest — and leaves the receipt to
// the audited manual confirmation step.
// ---------------------------------------------------------------------------

export const PUBLISH_PLATFORMS = Object.freeze([
  {
    id: "douyin",
    label: "抖音",
    canvas: "竖屏 9:16",
    checks: ["标题、封面与话题标签已在平台内确认", "字幕轨已加载且可关闭", "发布后回填作品链接"],
  },
  {
    id: "wechat",
    label: "视频号",
    canvas: "竖屏 9:16 或横屏 16:9",
    checks: ["标题、封面与话题标签已在平台内确认", "字幕轨已加载且可关闭", "发布后回填作品链接"],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    canvas: "竖屏 9:16",
    checks: ["标题、封面与话题标签已在平台内确认", "字幕轨已加载且可关闭", "发布后回填笔记链接"],
  },
]);

const PLATFORM_IDS = new Set(PUBLISH_PLATFORMS.map((platform) => platform.id));

export const PUBLISH_LIMITS = Object.freeze({ title: 120, description: 2000 });

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tableSafe(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export function buildPublishPlan({ run, source, sourceInfo, title, description, platforms, createdAt }) {
  const lines = [
    `# 发布清单 · ${title}`,
    "",
    `- 项目：${run.projectId}`,
    `- 运行：${run.id}`,
    `- 生成时间：${createdAt}`,
    `- 源文件：${path.basename(source)}（${formatSize(sourceInfo.size)}）`,
    `- 标题字数：${[...title].length}`,
    `- 文案字数：${[...description].length}`,
    `- 平台：${platforms.map((platform) => platform.label).join("、")}`,
    "",
    "## 文案",
    "",
    tableSafe(title),
    "",
    ...(description ? [description, ""] : []),
    "## 平台检查项",
    "",
  ];
  for (const platform of platforms) {
    lines.push(`### ${platform.label}`, "", `- 建议画布：${platform.canvas}（可由「多规格转码」生成）`);
    for (const check of platform.checks) lines.push(`- [ ] ${check}`);
    lines.push("");
  }
  lines.push(
    "> 本清单只做发布前核对，不会自动上传到任何平台；",
    "> 发布完成后在自动化面板点「我做完了」，确认人、时间与运行号即为回执。",
    "",
  );
  return lines.join("\n");
}

export function createPublishPackHandler({ sourceStore, artifactsDir } = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("发布包需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }

  return Object.freeze({
    "publish.package": async ({ run, params }) => {
      const title = typeof params.title === "string" ? params.title.trim() : "";
      if (!title) throw new Error("标题不能为空");
      if ([...title].length > PUBLISH_LIMITS.title) {
        throw new Error(`标题不能超过 ${PUBLISH_LIMITS.title} 个字符`);
      }
      const description = typeof params.description === "string" ? params.description.trim() : "";
      if ([...description].length > PUBLISH_LIMITS.description) {
        throw new Error(`文案不能超过 ${PUBLISH_LIMITS.description} 个字符`);
      }
      for (const key of Object.keys(params)) {
        if (PLATFORM_IDS.has(key) && typeof params[key] !== "boolean") {
          throw new Error("平台开关必须是布尔值");
        }
      }
      const selected = PUBLISH_PLATFORMS.filter((platform) => params[platform.id] === true);
      if (!selected.length) throw new Error("至少要选择一个发布平台");
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);
      if (mediaKindOf(source) !== "video") throw new Error("发布源必须是视频文件");
      const sourceInfo = await lstat(source);

      const createdAt = new Date().toISOString();
      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const planFile = path.join(directory, "publish-plan.md");
      const manifestFile = path.join(directory, "publish-manifest.json");

      const plan = buildPublishPlan({
        run,
        source,
        sourceInfo,
        title,
        description,
        platforms: selected,
        createdAt,
      });
      const manifest = {
        version: 1,
        runId: run.id,
        projectId: run.projectId,
        createdAt,
        source: {
          path: source,
          name: path.basename(source),
          bytes: sourceInfo.size,
        },
        content: {
          title,
          description,
          titleLength: [...title].length,
          descriptionLength: [...description].length,
        },
        platforms: selected.map((platform) => ({
          id: platform.id,
          label: platform.label,
          canvas: platform.canvas,
          uploaded: false,
        })),
      };
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(planFile, plan, { encoding: "utf8", mode: 0o600 });
      await writeFile(manifestFile, manifestText, { encoding: "utf8", mode: 0o600 });

      return {
        artifacts: [
          { slot: "plan", label: "发布清单", path: planFile, bytes: Buffer.byteLength(plan, "utf8") },
          {
            slot: "manifest",
            label: "发布清单（JSON）",
            path: manifestFile,
            bytes: Buffer.byteLength(manifestText, "utf8"),
          },
        ],
        logs: [
          `源文件：${path.basename(source)}（${formatSize(sourceInfo.size)}）`,
          `平台：${selected.map((platform) => platform.label).join("、")}`,
          `标题 ${[...title].length} 字；文案 ${[...description].length} 字`,
        ],
      };
    },
  });
}
