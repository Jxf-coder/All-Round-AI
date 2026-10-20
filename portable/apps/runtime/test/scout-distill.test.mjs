import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScoutStore,
  detectSensitive,
  readCandidateText,
} from "../src/scout.mjs";

test("candidate text is read only from inside the run root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-scout-read-"));
  try {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "a.md"), "\uFEFF主推产品：折叠彩虹琴");
    await writeFile(path.join(root, "big.md"), "x".repeat(1024 * 1024 + 1));

    const read = await readCandidateText(root, path.join("sub", "a.md"));
    assert.equal(read.text, "主推产品：折叠彩虹琴");
    await assert.rejects(readCandidateText(root, "missing.md"), /ENOENT|no such file/u);
    await assert.rejects(readCandidateText(root, ".."), /不在巡读目录/u);
    await assert.rejects(readCandidateText(root, "sub"), /不是普通文件/u);
    await assert.rejects(readCandidateText(root, "big.md"), /1 MB/u);
    await assert.rejects(readCandidateText(root, path.resolve(root, "sub", "a.md")), /绝对路径/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content gates refuse credentials and lists of identity numbers", () => {
  assert.match(detectSensitive(`key: sk-${"a".repeat(24)}`), /密钥/u);
  assert.match(detectSensitive("-----BEGIN RSA PRIVATE KEY-----"), /密钥/u);
  assert.equal(
    detectSensitive("110101199001011234\n110101199001011234\n110101199001011234"),
    "正文含多个身份证号，像人员或财务资料",
  );
  assert.equal(detectSensitive("110101199001011234"), null);
  assert.equal(detectSensitive("普通产品资料"), null);
});

test("distillation results are attached to the run and appended to the report", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-scout-distill-"));
  try {
    const scanRoot = path.join(temporaryRoot, "资料");
    await mkdir(scanRoot);
    await writeFile(path.join(scanRoot, "产品参数.md"), "主推产品：折叠彩虹琴");
    const filePath = path.join(temporaryRoot, "scout.json");
    const store = await createScoutStore(filePath);
    const run = await store.run({
      projectId: "project-1",
      root: scanRoot,
      goal: "产品参数",
      label: "产品资料",
      forbidden: [],
    });

    const summary = {
      at: new Date().toISOString(),
      files: 1,
      read: 1,
      cards: 1,
      merged: 0,
      dropped: 2,
      skipped: [{ path: "工资.md", reason: "正文疑似含密钥或密码，已拒绝" }],
      errors: [{ path: "坏文件.md", message: "读取失败" }],
    };
    const updated = await store.attachDistill("project-1", run.id, summary);
    assert.deepEqual(updated.distill, summary);
    assert.match(updated.report, /## 提炼结果/u);
    assert.match(updated.report, /新增待确认卡 1 张/u);
    assert.match(updated.report, /跳过 工资\.md/u);
    assert.match(updated.report, /出错 坏文件\.md/u);

    const reopened = await createScoutStore(filePath);
    const stored = await reopened.get("project-1", run.id);
    assert.equal(stored.distill.dropped, 2);
    assert.equal((await reopened.list("project-1"))[0].distill.cards, 1);
    assert.equal(await reopened.attachDistill("project-1", "missing", summary), null);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
