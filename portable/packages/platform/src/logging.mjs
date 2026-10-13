import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_FIELD = /(api.?key|private.?key|token|password|secret|authorization|cookie|credential)/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return value;
}

export function createAppLogger(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("A log file path is required");
  }
  const now = options.now ?? (() => new Date());
  let pendingWrites = Promise.resolve();

  async function write(level, message, fields = {}) {
    if (typeof message !== "string") {
      throw new TypeError("Log messages must be strings");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new TypeError("Log fields must be an object");
    }
    const operation = pendingWrites.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const record = {
        ...redact(fields),
        timestamp: now().toISOString(),
        level,
        message,
      };
      await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
    });
    pendingWrites = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  });
}
