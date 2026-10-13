import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAppLogger } from "../src/logging.mjs";

test("logger creates its directory and appends structured JSON lines", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-logger-"));
  const logPath = path.join(temporaryRoot, "nested", "app.jsonl");
  try {
    const logger = createAppLogger(logPath, {
      now: () => new Date("2026-10-13T12:00:00.000Z"),
    });
    await logger.info("Started", {
      platform: "win32",
      attempt: 2,
      level: "forged-level",
      message: "forged-message",
      timestamp: "not-a-time",
    });
    await logger.warn("Retry", { attempt: 3 });
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [
      {
        timestamp: "2026-10-13T12:00:00.000Z",
        level: "info",
        message: "Started",
        platform: "win32",
        attempt: 2,
      },
      {
        timestamp: "2026-10-13T12:00:00.000Z",
        level: "warn",
        message: "Retry",
        attempt: 3,
      },
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("logger redacts common secret fields recursively", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-logger-"));
  const logPath = path.join(temporaryRoot, "app.jsonl");
  try {
    const logger = createAppLogger(logPath);
    await logger.error("Request failed", {
      accessToken: "never-write-this",
      nested: { api_key: "also-secret", reason: "timeout" },
      details: [{ password: "hidden" }],
    });
    const contents = await readFile(logPath, "utf8");
    assert.doesNotMatch(contents, /never-write-this|also-secret|hidden/);
    assert.match(contents, /\[REDACTED\]/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent log writes are serialized without losing records", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-logger-"));
  const logPath = path.join(temporaryRoot, "app.jsonl");
  try {
    const logger = createAppLogger(logPath);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => logger.info("item", { index })),
    );
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.index), Array.from({ length: 40 }, (_, i) => i));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("logger rejects invalid inputs and protects record metadata", async () => {
  assert.throws(() => createAppLogger(""), /log file path is required/);
  const logger = createAppLogger("unused.log");
  await assert.rejects(logger.info({ message: "not a string" }), /messages must be strings/);
  await assert.rejects(logger.info("bad fields", []), /fields must be an object/);
});
