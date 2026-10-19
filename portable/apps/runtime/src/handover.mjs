import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonFile } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Knowledge handover bundle. The reference workbench exports cards, gaps and
// memory so another instance (or a person) can take over. This is the local
// equivalent: one JSON file under <data>/handover, never uploaded anywhere.
//
// Secrets must not leave the instance even by accident, so the serialized
// bundle is scanned for common key shapes before anything is written. A hit
// refuses the export instead of redacting silently — a handover that silently
// drops fields is worse than one that fails loudly.
// ---------------------------------------------------------------------------

const HANDOVER_FILE = /^handover-[a-z0-9_-]+-\d{14}\.json$/u;
const LATEST_FILE = "latest.json";
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bcursor_[A-Za-z0-9_-]{20,}/gu,
  /\bkey_[A-Za-z0-9]{24,}/gu,
  /\beyJhbGciOi[A-Za-z0-9_-]{30,}/gu,
  /\bAKID[A-Za-z0-9]{20,}/gu,
  /\bLTAI[A-Za-z0-9]{12,}/gu,
];

export function findSecretShapes(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of String(text ?? "").matchAll(pattern)) hits.push(match[0]);
  }
  return hits;
}

function timestamp(now) {
  return now().toISOString().replace(/[-:T]/gu, "").slice(0, 14);
}

export function safeProjectSlug(projectId) {
  return String(projectId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "project";
}

export function buildHandoverBundle({ project, memory, knowledge, generatedBy, now = () => new Date() }) {
  if (!project || typeof project.id !== "string" || !project.id) {
    throw new TypeError("交接包需要项目");
  }
  const cards = (knowledge?.cards ?? []).filter((card) => card.status !== "dropped");
  const gaps = knowledge?.gaps ?? [];
  const regression = knowledge?.regression ?? { questions: [], runs: [] };
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    generatedBy: String(generatedBy ?? ""),
    project: { id: project.id, name: project.name ?? "", type: project.type ?? "" },
    stats: knowledge?.stats ?? null,
    memory: {
      soul: memory?.soul ?? "",
      memory: memory?.memory ?? "",
      pending: memory?.pending ?? [],
    },
    knowledge: { cards, gaps },
    regression,
  };
}

export async function createHandover({
  directory,
  project,
  memory,
  knowledge,
  generatedBy,
  now = () => new Date(),
}) {
  const bundle = buildHandoverBundle({ project, memory, knowledge, generatedBy, now });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const secrets = findSecretShapes(text);
  if (secrets.length > 0) {
    const error = new Error(
      `交接包里发现 ${secrets.length} 处形似密钥的字符串`
      + `（${secrets.slice(0, 2).map((hit) => `${hit.slice(0, 8)}…`).join("，")}），请先清理知识卡或记忆再导出`,
    );
    error.code = "SECRET_DETECTED";
    throw error;
  }
  const at = now().toISOString();
  const file = `handover-${safeProjectSlug(project.id)}-${timestamp(now)}.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, file), text, { encoding: "utf8", mode: 0o600 });
  const info = {
    at,
    file,
    projectId: project.id,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    by: String(generatedBy ?? ""),
    counts: {
      cards: bundle.knowledge.cards.length,
      gaps: bundle.knowledge.gaps.length,
      pendingMemory: bundle.memory.pending.length,
      regressionQuestions: bundle.regression.questions.length,
    },
  };
  await writeJsonFile(path.join(directory, LATEST_FILE), info);
  return info;
}

export async function latestHandover(directory) {
  let info;
  try {
    info = JSON.parse(await readFile(path.join(directory, LATEST_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!info || typeof info.file !== "string" || !HANDOVER_FILE.test(info.file)) return null;
  try {
    await stat(path.join(directory, info.file));
  } catch {
    return null;
  }
  return info;
}

export async function readHandover(directory, file) {
  if (typeof file !== "string" || !HANDOVER_FILE.test(file)) return null;
  try {
    return await readFile(path.join(directory, file));
  } catch {
    return null;
  }
}

export const HANDOVER_FILE_PATTERN = HANDOVER_FILE;
