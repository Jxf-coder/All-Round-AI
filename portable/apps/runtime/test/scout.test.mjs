import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCOUT_LIMITS,
  buildScoutReport,
  createScoutStore,
  scanDirectory,
  scoutDecision,
} from "../src/scout.mjs";

test("file rules explain every exclusion without reading contents", () => {
  const keep = scoutDecision({ name: "产品参数.md", size: 1024 });
  assert.equal(keep.keep, true);

  const cases = [
    [{ name: "~$报价.xlsx", size: 10 }, /临时/u],
    [{ name: "空.md", size: 0 }, /空文件/u],
    [{ name: "logo.png", size: 10 }, /OCR/u],
    [{ name: "演示.mp4", size: 10 }, /音视频/u],
    [{ name: "资料.zip", size: 10 }, /解压/u],
    [{ name: "setup.exe", size: 10 }, /安装包/u],
    [{ name: "海报.psd", size: 10 }, /设计图纸/u],
    [{ name: "旧表.xls", size: 10 }, /老格式/u],
    [{ name: "手册.pdf", size: 10 }, /格式不支持/u],
    [{ name: "超限.md", size: SCOUT_LIMITS.maxBytes + 1 }, /40 MB/u],
    [{ name: "草稿-方案.md", size: 10 }, /草稿/u],
    [{ name: "合同说明.md", size: 10 }, /禁入词「合同」/u],
  ];
  for (const [input, pattern] of cases) {
    const decision = scoutDecision({ ...input, forbidden: ["合同"] });
    assert.equal(decision.keep, false, input.name);
    assert.match(decision.reason, pattern, input.name);
  }
});

test("a scan keeps readable files and reports duplicates and forbidden paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-scout-scan-"));
  try {
    await mkdir(path.join(root, "sub1"));
    await mkdir(path.join(root, "sub2"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "产品参数.md"), "参数");
    await writeFile(path.join(root, "合同说明.md"), "合同");
    await writeFile(path.join(root, "图片.png"), "png");
    await writeFile(path.join(root, "空.txt"), "");
    await writeFile(path.join(root, "旧表.xls"), "xls");
    await writeFile(path.join(root, "草稿-方案.md"), "草稿");
    await writeFile(path.join(root, ".hidden.md"), "hidden");
    await writeFile(path.join(root, "sub1", "说明.txt"), "same");
    await writeFile(path.join(root, "sub2", "说明.txt"), "same");
    await writeFile(path.join(root, "node_modules", "依赖.md"), "依赖");

    const scan = await scanDirectory({ root, forbidden: ["合同"] });
    assert.deepEqual(scan.counts, { dirs: 3, files: 8, rule: 6, keep: 2, errors: 0 });
    assert.deepEqual(scan.kept.map((file) => path.basename(file.path)), ["产品参数.md", "说明.txt"]);
    const reasons = scan.skipped.map((group) => group.reason);
    assert.ok(reasons.some((reason) => /禁入词「合同」/u.test(reason)));
    assert.ok(reasons.some((reason) => /重复：与/u.test(reason)));
    assert.ok(reasons.some((reason) => /空文件/u.test(reason)));
    assert.ok(reasons.some((reason) => /OCR/u.test(reason)));
    assert.equal(scan.truncated, false);

    const report = buildScoutReport({
      label: "产品资料",
      goal: "沉淀产品参数",
      root,
      counts: scan.counts,
      kept: scan.kept,
      skipped: scan.skipped,
      truncated: scan.truncated,
    });
    assert.match(report, /# 巡读报告 · 产品资料/u);
    assert.match(report, /## 留下的/u);
    assert.match(report, /## 没留的（按原因）/u);
    assert.match(report, /产品参数\.md/u);
    assert.match(report, /禁入词「合同」/u);
    assert.match(report, /点「提炼候选」/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a store keeps the newest runs, lists summaries and serves one report", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-scout-store-"));
  try {
    const scanRoot = path.join(temporaryRoot, "资料");
    await mkdir(scanRoot);
    await writeFile(path.join(scanRoot, "产品参数.md"), "参数");
    const store = await createScoutStore(path.join(temporaryRoot, "scout.json"));

    const run = await store.run({
      projectId: "project-1",
      root: scanRoot,
      goal: "产品参数",
      label: "产品资料",
      forbidden: [],
    });
    assert.match(run.id, /^sr-/u);
    assert.equal(run.counts.keep, 1);
    assert.equal(run.status, "done");
    assert.match(run.report, /扫了 1 个文件/u);

    const list = await store.list("project-1");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, run.id);
    assert.equal("report" in list[0], false);
    assert.equal((await store.get("project-1", run.id)).report, run.report);
    assert.equal(await store.get("project-1", "missing"), null);
    assert.deepEqual(await store.list("other-project"), []);

    for (let index = 0; index < SCOUT_LIMITS.runsPerProject; index += 1) {
      await store.run({
        projectId: "project-1",
        root: scanRoot,
        goal: "",
        label: `第 ${index + 2} 次`,
        forbidden: [],
      });
    }
    assert.equal((await store.list("project-1", 50)).length, SCOUT_LIMITS.runsPerProject);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
