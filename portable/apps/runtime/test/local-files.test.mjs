import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  listDirectory,
  readTextFile,
  resolveLocalPath,
} from "../src/local-files.mjs";

const run = promisify(execFile);

async function seed() {
  const base = await mkdtemp(path.join(os.tmpdir(), "allround-local-files-"));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  await mkdir(path.join(allowed, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(allowed, "a.txt"), "hello\n");
  await writeFile(path.join(allowed, "sub", "b.md"), "# title\n");
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  await writeFile(path.join(allowed, "binary.bin"), Buffer.from([1, 0, 2]));
  await writeFile(path.join(allowed, "big.txt"), "x".repeat(2048));
  return { base, allowed, outside };
}

test("text inside an allowed root can be read and listed", async () => {
  const { base, allowed } = await seed();
  try {
    const read = await readTextFile({ roots: [allowed], target: path.join(allowed, "a.txt") });
    assert.equal(read.text, "hello\n");
    assert.equal(read.size, 6);

    const listing = await listDirectory({ roots: [allowed], target: allowed });
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["a.txt", "big.txt", "binary.bin", "sub"]);
    assert.equal(listing.entries.find((entry) => entry.name === "sub").type, "directory");
    assert.equal(listing.truncated, false);

    const truncated = await listDirectory({ roots: [allowed], target: allowed, limit: 2 });
    assert.equal(truncated.entries.length, 2);
    assert.equal(truncated.truncated, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("paths outside the allowed roots are refused", async () => {
  const { base, allowed, outside } = await seed();
  try {
    await assert.rejects(
      readTextFile({ roots: [allowed], target: path.join(outside, "secret.txt") }),
      /不在允许访问的目录里/u,
    );
    await assert.rejects(
      readTextFile({ roots: [allowed], target: path.join(allowed, "..", "outside", "secret.txt") }),
      /不在允许访问的目录里/u,
    );
    await assert.rejects(
      resolveLocalPath({ roots: [allowed], target: path.join(allowed, "missing.txt") }),
      /路径不存在/u,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("oversized and binary files are refused", async () => {
  const { base, allowed } = await seed();
  try {
    await assert.rejects(
      readTextFile({ roots: [allowed], target: path.join(allowed, "big.txt"), maxBytes: 1024 }),
      /超过 1024 字节/u,
    );
    await assert.rejects(
      readTextFile({ roots: [allowed], target: path.join(allowed, "binary.bin") }),
      /不是文本文件/u,
    );
    await assert.rejects(
      listDirectory({ roots: [allowed], target: path.join(allowed, "a.txt") }),
      /不是目录/u,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("invalid configuration fails closed", async () => {
  const { base, allowed } = await seed();
  try {
    await assert.rejects(resolveLocalPath({ roots: [], target: allowed }), /没有配置允许访问的目录/u);
    await assert.rejects(resolveLocalPath({ roots: ["relative"], target: allowed }), /必须是绝对路径/u);
    await assert.rejects(resolveLocalPath({ roots: [allowed], target: "a.txt" }), /必须是绝对路径/u);
    await assert.rejects(
      readTextFile({ roots: [allowed], target: path.join(allowed, "a.txt"), maxBytes: 0 }),
      /读取上限/u,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the CLI lists and reads inside an allowed root only", async () => {
  const { base, allowed, outside } = await seed();
  try {
    const cli = fileURLToPath(new URL("../src/desk-cli.mjs", import.meta.url));

    const read = JSON.parse((await run(process.execPath, [
      cli, "files", "--root", allowed, "--read", path.join(allowed, "a.txt"),
    ])).stdout);
    assert.equal(read.text, "hello\n");
    assert.equal(read.size, 6);

    const listed = JSON.parse((await run(process.execPath, [
      cli, "files", "--root", allowed, "--list", allowed,
    ])).stdout);
    assert.ok(listed.entries.some((entry) => entry.name === "a.txt"));

    const denied = await run(process.execPath, [
      cli, "files", "--root", allowed, "--read", path.join(outside, "secret.txt"),
    ]).catch((error) => error);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /不在允许访问的目录里/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a symlink cannot be used to escape a root", { skip: process.platform === "win32" }, async () => {
  const { base, allowed, outside } = await seed();
  try {
    const link = path.join(allowed, "escape.txt");
    await symlink(path.join(outside, "secret.txt"), link);
    await assert.rejects(readTextFile({ roots: [allowed], target: link }), /不在允许访问的目录里/u);
    const listing = await listDirectory({ roots: [allowed], target: allowed });
    assert.equal(listing.entries.some((entry) => entry.name === "escape.txt"), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
