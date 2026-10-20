import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_SOURCE_ROOTS,
  createSourceStore,
  normalizeRoots,
  resolveScoutRoot,
} from "../src/sources.mjs";

test("source roots must be absolute, bounded and free of traversal", () => {
  const root = path.join(os.tmpdir(), "allround-roots");
  assert.deepEqual(normalizeRoots([` ${root} `, root, ""]), [path.normalize(root)]);
  assert.deepEqual(normalizeRoots([]), []);
  assert.throws(() => normalizeRoots("nope"), /数组/u);
  assert.throws(() => normalizeRoots([42]), /字符串/u);
  assert.throws(() => normalizeRoots(["relative/path"]), /绝对路径/u);
  assert.throws(() => normalizeRoots([`${root}${path.sep}..${path.sep}etc`]), /\.\./u);
  assert.throws(() => normalizeRoots([`${root}${path.sep}${"x".repeat(320)}`]), /300/u);
  assert.throws(
    () => normalizeRoots(Array.from({ length: MAX_SOURCE_ROOTS + 1 }, (_, index) => path.join(root, `r${index}`))),
    /最多配置/u,
  );
});

test("the source store seeds a default root, saves, persists and fails closed", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-sources-"));
  try {
    const filePath = path.join(temporaryRoot, "sources.json");
    const defaultRoot = path.join(temporaryRoot, "imports");
    const store = await createSourceStore(filePath, { defaultRoots: [defaultRoot] });
    const initial = await store.list();
    assert.deepEqual(initial.roots, [path.normalize(defaultRoot)]);
    assert.equal(initial.updatedAt, null);
    assert.equal(initial.updatedBy, "");

    const other = path.join(temporaryRoot, "产品资料");
    const saved = await store.save([other], "管理员");
    assert.deepEqual(saved.roots, [path.normalize(other)]);
    assert.equal(saved.updatedBy, "管理员");
    assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));

    const reopened = await createSourceStore(filePath, { defaultRoots: [defaultRoot] });
    assert.deepEqual((await reopened.list()).roots, [path.normalize(other)]);

    await writeFile(filePath, JSON.stringify({ version: 1, roots: ["relative"], updatedAt: null }));
    await assert.rejects(reopened.list(), /invalid root/u);
    await writeFile(filePath, JSON.stringify({ version: 2, roots: [] }));
    await assert.rejects(reopened.list(), /unsupported or damaged/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a scout root must resolve inside an allowed root", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-roots-resolve-"));
  try {
    const allowed = path.join(temporaryRoot, "allowed");
    const sibling = path.join(temporaryRoot, "allowed-sibling");
    const child = path.join(allowed, "sub");
    await mkdir(child, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(allowed, "file.txt"), "x");

    assert.equal(await resolveScoutRoot(child, [allowed]), await realpath(child));
    assert.equal(await resolveScoutRoot(allowed, [allowed]), await realpath(allowed));
    await assert.rejects(resolveScoutRoot(sibling, [allowed]), /白名单/u);
    await assert.rejects(resolveScoutRoot(temporaryRoot, [allowed]), /白名单/u);
    await assert.rejects(resolveScoutRoot(path.join(allowed, "file.txt"), [allowed]), /不是文件夹/u);
    await assert.rejects(resolveScoutRoot("relative", [allowed]), /绝对路径/u);
    await assert.rejects(resolveScoutRoot(`${allowed}${path.sep}..${path.sep}allowed`, [allowed]), /\.\./u);
    await assert.rejects(resolveScoutRoot(path.join(allowed, "missing"), [allowed]), /不存在/u);
    await assert.rejects(resolveScoutRoot(child, [path.join(temporaryRoot, "not-there")]), /白名单/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
