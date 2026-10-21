import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Audit trail for privileged local actions.
//
// Entries are append-only JSON lines, one action per record, written with 0600
// permissions. The file rotates once it reaches its size cap so a busy device
// cannot fill the disk. Reading tolerates a torn last line but reports how many
// lines were skipped instead of silently pretending the log was clean.
// ---------------------------------------------------------------------------

export const AUDIT_MAX_LIMIT = 200;
const OUTCOMES = new Set(["ok", "error", "denied"]);
const MAX_FIELD_LENGTH = 500;

function field(value, label, { required = true, maxLength = MAX_FIELD_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${label} is required`);
    return null;
  }
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new TypeError(`${label} cannot be empty`);
    return null;
  }
  if (trimmed.length > maxLength) throw new TypeError(`${label} is too long`);
  return trimmed;
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.at === "string"
    && typeof value.actor === "string"
    && typeof value.action === "string"
    && OUTCOMES.has(value.outcome)
    && (value.target === null || typeof value.target === "string")
    && (value.detail === null || typeof value.detail === "string");
}

export function createAuditLog({ filePath, maxBytes = 512 * 1024, now = () => new Date() } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("审计文件必须是绝对路径");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024) {
    throw new TypeError("审计文件上限至少 1024 字节");
  }

  async function append({ actor, action, target = null, outcome, detail = null }) {
    if (!OUTCOMES.has(outcome)) throw new TypeError("outcome must be ok, error or denied");
    const record = {
      at: now().toISOString(),
      actor: field(actor, "actor", { maxLength: 200 }),
      action: field(action, "action", { maxLength: 80 }),
      target: field(target, "target", { required: false, maxLength: 4096 }),
      outcome,
      detail: field(detail, "detail", { required: false }),
    };
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    const info = await stat(filePath).catch(() => null);
    if (info && info.size + Buffer.byteLength(line) > maxBytes) {
      await rename(filePath, `${filePath}.1`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  async function list({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("审计条数必须是正整数");
    }
    const cap = Math.min(limit, AUDIT_MAX_LIMIT);
    const raw = await readFile(filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const entries = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) entries.push(parsed);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return {
      entries: entries.slice(-cap).reverse(),
      total: entries.length,
      skipped,
    };
  }

  return Object.freeze({ append, list });
}
