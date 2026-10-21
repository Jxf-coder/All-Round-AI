import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuditLog } from "../src/audit.mjs";

test("audit entries are appended as JSON lines and read newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-audit-"));
  try {
    let current = new Date("2026-10-21T01:00:00.000Z");
    const log = createAuditLog({
      filePath: path.join(root, "logs", "audit.jsonl"),
      now: () => new Date(current.getTime()),
    });

    await log.append({ actor: "admin@example.test", action: "device.command", target: "dev-1", outcome: "ok", detail: "files.list /tmp" });
    current = new Date(current.getTime() + 1_000);
    await log.append({ actor: "admin@example.test", action: "device.command", target: "dev-1", outcome: "error", detail: "设备没有在限定时间内响应" });
    current = new Date(current.getTime() + 1_000);
    await log.append({ actor: "member@example.test", action: "device.command", target: "dev-1", outcome: "denied", detail: "没有管理员权限" });

    const result = await log.list({ limit: 10 });
    assert.equal(result.total, 3);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.entries.map((entry) => entry.outcome), ["denied", "error", "ok"]);
    assert.equal(result.entries[0].actor, "member@example.test");
    assert.equal(result.entries[2].at, "2026-10-21T01:00:00.000Z");

    const limited = await log.list({ limit: 2 });
    assert.equal(limited.entries.length, 2);
    assert.equal(limited.total, 3);

    const raw = await readFile(path.join(root, "logs", "audit.jsonl"), "utf8");
    assert.equal(raw.trim().split("\n").length, 3);
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(root, "logs", "audit.jsonl"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a full audit file rotates once instead of growing forever", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-audit-rotate-"));
  try {
    const filePath = path.join(root, "audit.jsonl");
    const log = createAuditLog({ filePath, maxBytes: 1_024 });
    const detail = "x".repeat(300);
    await log.append({ actor: "admin", action: "device.command", target: "dev-1", outcome: "ok", detail });
    await log.append({ actor: "admin", action: "device.command", target: "dev-1", outcome: "ok", detail });
    await log.append({ actor: "admin", action: "device.command", target: "dev-1", outcome: "ok", detail });

    const previous = await readFile(`${filePath}.1`, "utf8");
    assert.equal(previous.trim().split("\n").length, 2);
    const current = await readFile(filePath, "utf8");
    assert.equal(current.trim().split("\n").length, 1);
    assert.equal((await log.list({ limit: 10 })).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing audit file reads as empty and a torn line is reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-audit-torn-"));
  try {
    const filePath = path.join(root, "audit.jsonl");
    const log = createAuditLog({ filePath });
    assert.deepEqual(await log.list(), { entries: [], total: 0, skipped: 0 });

    await writeFile(filePath, `${JSON.stringify({
      at: "2026-10-21T01:00:00.000Z",
      actor: "admin",
      action: "device.command",
      target: "dev-1",
      outcome: "ok",
      detail: null,
    })}\n{"at":`);
    const result = await log.list({ limit: 5 });
    assert.equal(result.total, 1);
    assert.equal(result.skipped, 1);

    await writeFile(filePath, `{"at":"2026-10-21T01:00:00.000Z","actor":"admin","action":"x","target":null,"outcome":"maybe","detail":null}\n`);
    assert.equal((await log.list()).skipped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid audit input is rejected before touching the disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-audit-invalid-"));
  try {
    assert.throws(() => createAuditLog({ filePath: "relative.jsonl" }), /绝对路径/u);
    assert.throws(() => createAuditLog({ filePath: path.join(root, "a.jsonl"), maxBytes: 10 }), /至少 1024/u);
    const log = createAuditLog({ filePath: path.join(root, "audit.jsonl") });

    await assert.rejects(log.append({ action: "x", outcome: "ok" }), /actor/u);
    await assert.rejects(log.append({ actor: "admin", action: "", outcome: "ok" }), /action/u);
    await assert.rejects(log.append({ actor: "admin", action: "x", outcome: "maybe" }), /outcome/u);
    await assert.rejects(log.append({ actor: "admin", action: "x", outcome: "ok", detail: "y".repeat(501) }), /too long/u);
    await assert.rejects(log.list({ limit: 0 }), /正整数/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
