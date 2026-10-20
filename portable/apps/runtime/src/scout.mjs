import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// 巡读 (scout), local-only first pass. Reading every document and asking a
// model to distil it is a later stage; this pass does the part that can be
// trusted without a model: walk an allowed directory, apply the reference's
// file rules, and write a report of what would be read and what was excluded.
//
// It never writes to the scanned directory, never follows symlinks, and never
// returns file contents. A "kept" file is a candidate, not a knowledge card.
// ---------------------------------------------------------------------------

export const SCOUT_LIMITS = Object.freeze({
  dirs: 800,
  files: 5_000,
  depth: 8,
  maxBytes: 40 * 1024 * 1024,
  reportFiles: 200,
  detailsPerReason: 20,
  runsPerProject: 20,
});

const SKIP_DIRS = new Set([
  "@eaDir", "#recycle", "#snapshot", "$RECYCLE.BIN", "System Volume Information",
  "node_modules", "__MACOSX", "lost+found",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg",
]);
const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".mp3", ".wav", ".flac", ".m4a", ".aac",
]);
const ARCHIVE_EXTENSIONS = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
]);
const INSTALLER_EXTENSIONS = new Set([
  ".exe", ".msi", ".dmg", ".pkg", ".apk", ".deb", ".rpm", ".app",
]);
const DESIGN_EXTENSIONS = new Set([
  ".psd", ".ai", ".sketch", ".fig", ".xd", ".dwg", ".dxf",
]);
const OLD_OFFICE_EXTENSIONS = new Set([".xls", ".ppt"]);
export const READABLE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml",
]);

const DRAFT_PATTERN = /草稿|作废|备份|副本|copy/iu;
const TEMP_NAMES = new Set(["Thumbs.db", "desktop.ini", ".DS_Store"]);

function extensionOf(name) {
  return path.extname(name).toLowerCase();
}

function displayPath(relativePath, name) {
  return relativePath ? path.join(relativePath, name) : name;
}

// Pure classification of one already-listed file. Kept separate from the walk
// so the rules can be tested without touching a filesystem.
export function scoutDecision({ name, relativePath = "", size = 0, forbidden = [] }) {
  const fullPath = displayPath(relativePath, name);
  const extension = extensionOf(name);
  if (name.startsWith("~$") || TEMP_NAMES.has(name)
    || extension === ".tmp" || extension === ".temp") {
    return { keep: false, reason: "临时 / 系统文件" };
  }
  if (size === 0) return { keep: false, reason: "空文件" };
  if (IMAGE_EXTENSIONS.has(extension)) return { keep: false, reason: "图片：待 OCR（尚未接入）" };
  if (MEDIA_EXTENSIONS.has(extension)) return { keep: false, reason: "音视频不进知识库" };
  if (ARCHIVE_EXTENSIONS.has(extension)) return { keep: false, reason: "压缩包：先解压再巡读" };
  if (INSTALLER_EXTENSIONS.has(extension)) return { keep: false, reason: "安装包 / 程序文件" };
  if (DESIGN_EXTENSIONS.has(extension)) {
    return { keep: false, reason: "设计图纸 / 源文件，暂不读取" };
  }
  if (OLD_OFFICE_EXTENSIONS.has(extension)) {
    return { keep: false, reason: "老格式（.xls / .ppt）：另存为 xlsx / pptx 后再巡读" };
  }
  if (!READABLE_EXTENSIONS.has(extension)) {
    return { keep: false, reason: `格式不支持（${extension || "无后缀"}）` };
  }
  if (size > SCOUT_LIMITS.maxBytes) {
    return { keep: false, reason: "超过 40 MB" };
  }
  const haystack = fullPath.toLowerCase();
  for (const term of forbidden) {
    const needle = String(term).trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      return { keep: false, reason: `路径或文件名含禁入词「${term}」` };
    }
  }
  if (DRAFT_PATTERN.test(name)) {
    return { keep: false, reason: "草稿 / 作废 / 备份 / 副本" };
  }
  return { keep: true, reason: "" };
}

function addSkipped(skipped, reason, example) {
  let entry = skipped.get(reason);
  if (!entry) {
    entry = { reason, count: 0, examples: [] };
    skipped.set(reason, entry);
  }
  entry.count += 1;
  if (example && entry.examples.length < SCOUT_LIMITS.detailsPerReason) {
    entry.examples.push(example);
  }
}

// Breadth-first walk with fixed ceilings. Subdirectories that cannot be read
// are reported and skipped instead of aborting the whole run.
export async function scanDirectory({ root, forbidden = [] }) {
  const counts = { dirs: 0, files: 0, rule: 0, keep: 0, errors: 0 };
  const kept = [];
  const skipped = new Map();
  const seen = new Map();
  const queue = [{ absolute: root, relative: "", depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    if (counts.dirs >= SCOUT_LIMITS.dirs || counts.files >= SCOUT_LIMITS.files) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      counts.errors += 1;
      addSkipped(skipped, `无法读取目录（${error.code ?? "错误"}）`, current.relative || ".");
      continue;
    }
    counts.dirs += 1;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (counts.files >= SCOUT_LIMITS.files) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".")) continue;
      const relativePath = displayPath(current.relative, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (current.depth >= SCOUT_LIMITS.depth) continue;
        queue.push({
          absolute: path.join(current.absolute, entry.name),
          relative: relativePath,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      counts.files += 1;
      let info;
      try {
        info = await lstat(path.join(current.absolute, entry.name));
      } catch (error) {
        counts.errors += 1;
        addSkipped(skipped, `无法读取文件（${error.code ?? "错误"}）`, relativePath);
        continue;
      }
      const decision = scoutDecision({
        name: entry.name,
        relativePath: current.relative,
        size: info.size,
        forbidden,
      });
      if (!decision.keep) {
        counts.rule += 1;
        addSkipped(skipped, decision.reason, relativePath);
        continue;
      }
      const key = `${entry.name}\u0000${info.size}`;
      const first = seen.get(key);
      if (first) {
        counts.rule += 1;
        addSkipped(skipped, `重复：与「${first}」同名同大小`, relativePath);
        continue;
      }
      seen.set(key, relativePath);
      counts.keep += 1;
      kept.push({ path: relativePath, size: info.size });
    }
  }

  return {
    counts,
    kept,
    skipped: [...skipped.values()],
    truncated,
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildScoutReport({ label, goal, root, counts, kept, skipped, truncated }) {
  const lines = [
    `# 巡读报告 · ${label}`,
    "",
    `目标：${goal || "未填写（按文件名与禁入词筛选）"}`,
    `来源：服务器目录 · ${root}`,
    `扫了 ${counts.files} 个文件 / ${counts.dirs} 个文件夹；规则筛掉 ${counts.rule}，留下 ${counts.keep} 个候选。`,
    "本批只做本地规则筛选；点「提炼候选」才会调用 AI 生成待确认卡。",
  ];
  if (counts.errors > 0) lines.push(`有 ${counts.errors} 个目录或文件读不了，已跳过。`);
  if (truncated) lines.push("目录太大，只列了前面一部分（上限 800 个文件夹 / 5000 个文件）。");

  lines.push("", "## 留下的");
  if (kept.length === 0) {
    lines.push("这次没有留下候选文件。检查目录、目标或禁入词。");
  } else {
    for (const file of kept.slice(0, SCOUT_LIMITS.reportFiles)) {
      lines.push(`- ${file.path} · ${formatSize(file.size)}`);
    }
    if (kept.length > SCOUT_LIMITS.reportFiles) {
      lines.push(`- 只列出前 ${SCOUT_LIMITS.reportFiles} 个；共 ${kept.length} 个。`);
    }
  }

  lines.push("", "## 没留的（按原因）");
  if (skipped.length === 0) {
    lines.push("没有被规则筛掉的文件。");
  } else {
    for (const group of skipped) {
      lines.push(`### ${group.reason}（${group.count}）`);
      for (const example of group.examples) lines.push(`- ${example}`);
      if (group.count > group.examples.length) {
        lines.push(`- 另有 ${group.count - group.examples.length} 个同类文件`);
      }
    }
  }

  lines.push(
    "",
    "下一步：先按报告核对留下的来源；AI 提炼与生成待确认卡尚未接入。",
  );
  return lines.join("\n");
}

export const SCOUT_TEXT_MAX_BYTES = 1024 * 1024;

const SECRET_RE = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|cursor_[A-Za-z0-9_-]{20,}|key_[A-Za-z0-9]{24,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,}|eyJhbGciOi[A-Za-z0-9_-]{30,})\b/u;
const PII_RE = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/gu;

// Content-level gates run before any model call. They are deliberately blunt:
// refusing a document is cheaper than sending credentials or an employee list
// through a model, and the person can still open the file and add a card.
export function detectSensitive(text) {
  const value = String(text ?? "");
  if (SECRET_RE.test(value)) return "正文疑似含密钥或密码，已拒绝";
  const ids = value.match(PII_RE);
  if (ids && ids.length >= 3) return "正文含多个身份证号，像人员或财务资料";
  return null;
}

// Reads one kept candidate. The path is re-proven inside the run root and the
// file must still be a regular file: a candidate may have been replaced by a
// symlink between the scan and the distillation run.
export async function readCandidateText(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    throw new TypeError("文件路径为空");
  }
  if (path.isAbsolute(relativePath)) throw new TypeError("文件路径不能是绝对路径");
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error("文件不在巡读目录里");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("不是普通文件");
  if (info.size > SCOUT_TEXT_MAX_BYTES) {
    throw new Error("文件超过 1 MB，暂不提炼");
  }
  const raw = await readFile(absolute, "utf8");
  return { text: raw.replace(/^\uFEFF/u, ""), size: info.size };
}

function buildDistillSection(summary) {
  const lines = [
    `## 提炼结果（${summary.at}）`,
    `读了 ${summary.read} 份正文，新增待确认卡 ${summary.cards} 张，合并重复 ${summary.merged} 张，丢弃未核对 ${summary.dropped} 条。`,
  ];
  for (const item of summary.skipped) lines.push(`- 跳过 ${item.path}：${item.reason}`);
  for (const item of summary.errors) lines.push(`- 出错 ${item.path}：${item.message}`);
  return lines.join("\n");
}

function validateCounts(counts) {
  if (!counts || typeof counts !== "object") return false;
  return ["dirs", "files", "rule", "keep", "errors"]
    .every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
}

function validateRun(run) {
  return run && typeof run === "object"
    && typeof run.id === "string" && run.id
    && typeof run.projectId === "string" && run.projectId
    && typeof run.root === "string" && run.root
    && typeof run.label === "string"
    && typeof run.goal === "string"
    && run.status === "done"
    && typeof run.createdAt === "string" && !Number.isNaN(Date.parse(run.createdAt))
    && validateCounts(run.counts)
    && Array.isArray(run.kept)
    && run.kept.every((file) => file && typeof file.path === "string"
      && Number.isSafeInteger(file.size) && file.size >= 0)
    && Array.isArray(run.skipped)
    && run.skipped.every((group) => group && typeof group.reason === "string"
      && Number.isSafeInteger(group.count)
      && Array.isArray(group.examples)
      && group.examples.every((example) => typeof example === "string"))
    && typeof run.truncated === "boolean"
    && (run.distill === undefined || validateDistill(run.distill))
    && typeof run.report === "string";
}

function validateDistill(summary) {
  return summary && typeof summary === "object"
    && typeof summary.at === "string" && !Number.isNaN(Date.parse(summary.at))
    && ["files", "read", "cards", "merged", "dropped"]
      .every((key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    && Array.isArray(summary.skipped)
    && summary.skipped.every((item) => item && typeof item.path === "string"
      && typeof item.reason === "string")
    && Array.isArray(summary.errors)
    && summary.errors.every((item) => item && typeof item.path === "string"
      && typeof item.message === "string");
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("All Round AI scout store format is unsupported or damaged");
  }
  for (const project of value.projects) {
    if (!project || typeof project.projectId !== "string" || !Array.isArray(project.runs)) {
      throw new Error("All Round AI scout store contains an invalid project");
    }
    if (!project.runs.every(validateRun)) {
      throw new Error("All Round AI scout store contains an invalid run");
    }
  }
  return value;
}

export async function createScoutStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, projects: [] }),
    validate: validateDocument,
  });

  function projectOf(document, projectId) {
    let project = document.projects.find((item) => item.projectId === projectId);
    if (!project) {
      project = { projectId, runs: [] };
      document.projects.push(project);
    }
    return project;
  }

  return Object.freeze({
    async run({ projectId, root, goal, label, forbidden, now = () => new Date() }) {
      if (typeof projectId !== "string" || !projectId) {
        throw new TypeError("A scout project is required");
      }
      const scan = await scanDirectory({ root, forbidden });
      const at = now().toISOString();
      const runLabel = (typeof label === "string" && label.trim()
        ? label.trim()
        : path.basename(root) || "服务器目录").slice(0, 40);
      const runGoal = typeof goal === "string" ? goal.trim().slice(0, 500) : "";
      const kept = scan.kept.slice(0, SCOUT_LIMITS.reportFiles);
      const report = buildScoutReport({
        label: runLabel,
        goal: runGoal,
        root,
        counts: scan.counts,
        kept: scan.kept,
        skipped: scan.skipped,
        truncated: scan.truncated,
      });
      const run = {
        id: `sr-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        projectId,
        root,
        label: runLabel,
        goal: runGoal,
        status: "done",
        createdAt: at,
        counts: scan.counts,
        kept,
        skipped: scan.skipped,
        truncated: scan.truncated,
        report,
      };
      await store.update((document) => {
        const project = projectOf(document, projectId);
        project.runs.unshift(run);
        project.runs = project.runs.slice(0, SCOUT_LIMITS.runsPerProject);
      });
      return run;
    },
    async list(projectId, limit = 10) {
      const { projects } = await store.read();
      const project = projects.find((item) => item.projectId === projectId);
      if (!project) return [];
      return project.runs.slice(0, limit).map(({ report, ...summary }) => summary);
    },
    async get(projectId, id) {
      const { projects } = await store.read();
      const project = projects.find((item) => item.projectId === projectId);
      return project?.runs.find((item) => item.id === id) ?? null;
    },
    // Distillation happens after the scan, so its result is attached to the
    // same run instead of creating a second history entry. The report keeps the
    // scan and the extraction side by side for later review.
    async attachDistill(projectId, id, summary) {
      return store.update((document) => {
        const project = document.projects.find((item) => item.projectId === projectId);
        const run = project?.runs.find((item) => item.id === id);
        if (!run) return null;
        run.distill = summary;
        run.report = `${run.report}\n\n${buildDistillSection(summary)}`;
        return run;
      });
    },
  });
}
