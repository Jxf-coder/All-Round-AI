import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Publish receipts. A receipt records what a human actually did on a platform:
// the link, when it was saved, and whether it succeeded. It is deliberately
// separate from the automation run snapshot, because a receipt arrives after
// the run has already produced its plan.
// ---------------------------------------------------------------------------

export const RECEIPT_DOCUMENT_VERSION = 1;
export const MAX_RECEIPTS = 500;
export const MAX_URL_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
export const RECEIPT_STATUSES = Object.freeze(["published", "failed"]);

function assertText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}不能为空`);
  const text = value.trim();
  if ([...text].length > maxLength) throw new TypeError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

export function normalizeReceiptUrl(value, status) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    if (status === "failed") return "";
    throw new TypeError("发布成功必须填写作品链接");
  }
  if (raw.length > MAX_URL_LENGTH) throw new TypeError(`作品链接不能超过 ${MAX_URL_LENGTH} 个字符`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("作品链接必须是完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("作品链接必须是完整的 http(s) 地址");
  }
  return raw;
}

function assertDocument(value) {
  if (!value || value.version !== RECEIPT_DOCUMENT_VERSION || !Array.isArray(value.receipts)) {
    throw new Error("All Round AI receipt store format is unsupported or damaged");
  }
  if (value.receipts.length > MAX_RECEIPTS) throw new Error("All Round AI receipt store contains too many rows");
  for (const receipt of value.receipts) {
    if (!receipt || typeof receipt.runId !== "string" || typeof receipt.platformId !== "string") {
      throw new Error("All Round AI receipt store contains an invalid row");
    }
    if (!RECEIPT_STATUSES.includes(receipt.status)) {
      throw new Error("All Round AI receipt store contains an invalid status");
    }
    if (typeof receipt.url !== "string" || typeof receipt.note !== "string") {
      throw new Error("All Round AI receipt store contains invalid text");
    }
    if (typeof receipt.updatedAt !== "string" || Number.isNaN(Date.parse(receipt.updatedAt))) {
      throw new Error("All Round AI receipt store contains an invalid timestamp");
    }
  }
  return value;
}

function copyReceipt(receipt) {
  return {
    runId: receipt.runId,
    platformId: receipt.platformId,
    status: receipt.status,
    url: receipt.url,
    note: receipt.note,
    updatedAt: receipt.updatedAt,
    updatedBy: receipt.updatedBy,
  };
}

export async function createPublishReceiptStore(filePath) {
  if (typeof filePath !== "string") throw new TypeError("A receipt store path is required");
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: RECEIPT_DOCUMENT_VERSION, receipts: [] }),
    validate: assertDocument,
  });

  return Object.freeze({
    path: store.path,
    async list(runId) {
      const document = await store.read();
      return document.receipts
        .filter((receipt) => !runId || receipt.runId === runId)
        .map(copyReceipt);
    },
    async save({ runId, platformId, status, url, note, by } = {}) {
      const run = assertText(runId, "运行号", 120);
      const platform = assertText(platformId, "平台", 60);
      if (!RECEIPT_STATUSES.includes(status)) throw new TypeError("回执状态无效");
      const normalizedUrl = normalizeReceiptUrl(url, status);
      const cleanedNote = typeof note === "string" ? note.trim() : "";
      if ([...cleanedNote].length > MAX_NOTE_LENGTH) {
        throw new TypeError(`备注不能超过 ${MAX_NOTE_LENGTH} 个字符`);
      }
      const author = typeof by === "string" ? by.trim().slice(0, 100) : "";
      return store.update((document) => {
        const updatedAt = new Date().toISOString();
        const row = {
          runId: run,
          platformId: platform,
          status,
          url: normalizedUrl,
          note: cleanedNote,
          updatedAt,
          updatedBy: author,
        };
        const index = document.receipts.findIndex(
          (receipt) => receipt.runId === run && receipt.platformId === platform,
        );
        if (index >= 0) {
          document.receipts[index] = row;
        } else {
          document.receipts.push(row);
          if (document.receipts.length > MAX_RECEIPTS) {
            document.receipts.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
            document.receipts.length = MAX_RECEIPTS;
          }
        }
        return copyReceipt(row);
      });
    },
  });
}
