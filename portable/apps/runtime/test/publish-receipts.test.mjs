import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_NOTE_LENGTH,
  MAX_URL_LENGTH,
  createPublishReceiptStore,
  normalizeReceiptUrl,
} from "../src/publish-receipts.mjs";

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-receipts-"));
  const file = path.join(root, "publish-receipts.json");
  try {
    await callback({ root, file });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a receipt is saved, updated in place and survives a restart", async () => {
  await fixture(async ({ file }) => {
    const store = await createPublishReceiptStore(file);
    assert.deepEqual(await store.list(), []);

    const saved = await store.save({
      runId: "run_1",
      platformId: "douyin",
      status: "published",
      url: "https://www.douyin.com/video/123",
      note: "首条",
      by: "admin",
    });
    assert.equal(saved.runId, "run_1");
    assert.equal(saved.status, "published");
    assert.equal(saved.updatedBy, "admin");
    assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));

    await store.save({
      runId: "run_1",
      platformId: "wechat",
      status: "failed",
      url: "",
      by: "admin",
    });
    assert.equal((await store.list("run_1")).length, 2);
    assert.deepEqual(await store.list("run_other"), []);

    const updated = await store.save({
      runId: "run_1",
      platformId: "douyin",
      status: "failed",
      url: "",
      note: "被平台驳回",
      by: "operator",
    });
    assert.equal(updated.status, "failed");
    assert.equal(updated.note, "被平台驳回");
    const listed = await store.list("run_1");
    assert.equal(listed.length, 2);
    assert.equal(listed.find((row) => row.platformId === "douyin").updatedBy, "operator");

    const reopened = await createPublishReceiptStore(file);
    const persisted = await reopened.list("run_1");
    assert.equal(persisted.length, 2);
    assert.equal(persisted.find((row) => row.platformId === "wechat").status, "failed");
  });
});

test("URLs and receipt fields are validated before anything is written", async () => {
  assert.equal(normalizeReceiptUrl("https://example.com/a", "published"), "https://example.com/a");
  assert.equal(normalizeReceiptUrl("  ", "failed"), "");
  assert.throws(() => normalizeReceiptUrl("", "published"), /必须填写作品链接/u);
  assert.throws(() => normalizeReceiptUrl("ftp://example.com/a", "published"), /http\(s\)/u);
  assert.throws(() => normalizeReceiptUrl("not a url", "published"), /http\(s\)/u);
  assert.throws(
    () => normalizeReceiptUrl(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`, "published"),
    /不能超过 500 个字符/u,
  );

  await fixture(async ({ file }) => {
    const store = await createPublishReceiptStore(file);
    await assert.rejects(
      store.save({ runId: "", platformId: "douyin", status: "published", url: "https://example.com" }),
      /运行号不能为空/u,
    );
    await assert.rejects(
      store.save({ runId: "run_1", platformId: "", status: "published", url: "https://example.com" }),
      /平台不能为空/u,
    );
    await assert.rejects(
      store.save({ runId: "run_1", platformId: "douyin", status: "done", url: "https://example.com" }),
      /回执状态无效/u,
    );
    await assert.rejects(
      store.save({
        runId: "run_1",
        platformId: "douyin",
        status: "published",
        url: "https://example.com",
        note: "字".repeat(MAX_NOTE_LENGTH + 1),
      }),
      /备注不能超过 500 个字符/u,
    );
    assert.deepEqual(await store.list(), []);
  });
});

test("a damaged receipt document fails closed", async () => {
  await fixture(async ({ file }) => {
    const store = await createPublishReceiptStore(file);
    await writeFile(file, '{"version":1,"receipts":[{"runId":"r","platformId":"douyin","status":"done","url":"","note":"","updatedAt":"2026-10-21T00:00:00.000Z"}]}\n');
    await assert.rejects(store.list(), /unsupported or damaged|invalid status/u);
    await writeFile(file, '{"version":2,"receipts":[]}\n');
    await assert.rejects(store.list(), /unsupported or damaged/u);
  });
});
