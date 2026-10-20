import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  createBackup,
  readManifest,
  restoreBackup,
  verifyBackup,
} from "../src/backup.mjs";

const run = promisify(execFile);
const fixedNow = () => new Date("2026-10-20T05:06:07.000Z");

async function seedData(root) {
  await mkdir(path.join(root, "config", "sub"), { recursive: true });
  await mkdir(path.join(root, "handover"), { recursive: true });
  await mkdir(path.join(root, "imports"), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });
  await mkdir(path.join(root, "backups", "old"), { recursive: true });
  await writeFile(path.join(root, "config", "accounts.json"), "{\"version\":1}\n");
  await writeFile(path.join(root, "config", "sub", "settings.json"), "{\"model\":\"llama\"}\n");
  await writeFile(path.join(root, "handover", "handover-demo-20261020000000.json"), "{}\n");
  await writeFile(path.join(root, "imports", "readme.txt"), "产品资料\n");
  await writeFile(path.join(root, "logs", "runtime.jsonl"), "{\"level\":\"info\"}\n");
  await writeFile(path.join(root, "backups", "old", "thing.json"), "{}\n");
}

test("a backup copies the data but not logs or older backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const outDir = path.join(root, "out");
    await seedData(dataDir);
    await mkdir(outDir);

    const { directory, manifest } = await createBackup({ dataDir, outDir, now: fixedNow });
    assert.equal(path.basename(directory), "allround-backup-20261020-050607");
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.excluded, ["backups", "logs"]);
    assert.deepEqual(
      manifest.files.map((file) => file.path).sort(),
      ["config/accounts.json", "config/sub/settings.json", "handover/handover-demo-20261020000000.json", "imports/readme.txt"],
    );
    assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)));
    assert.equal(
      manifest.totalBytes,
      manifest.files.reduce((total, file) => total + file.size, 0),
    );
    assert.equal((await readManifest(directory)).files.length, 4);
    assert.equal((await verifyBackup(directory)).ok, true);
    assert.equal(await readFile(path.join(directory, "config", "accounts.json"), "utf8"), "{\"version\":1}\n");
    await assert.rejects(readFile(path.join(directory, "logs", "runtime.jsonl"), "utf8"), /ENOENT/u);

    await assert.rejects(createBackup({ dataDir, outDir, now: fixedNow }), /已存在/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore verifies hashes, refuses a non-empty target and keeps the manifest out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-restore-"));
  try {
    const dataDir = path.join(root, "data");
    const outDir = path.join(root, "out");
    await seedData(dataDir);
    await mkdir(outDir);
    const { directory } = await createBackup({ dataDir, outDir, now: fixedNow });

    const restoredDir = path.join(root, "restored");
    const result = await restoreBackup({ backupDir: directory, dataDir: restoredDir });
    assert.equal(result.restored, 4);
    assert.equal(await readFile(path.join(restoredDir, "config", "accounts.json"), "utf8"), "{\"version\":1}\n");
    assert.deepEqual((await readdir(restoredDir)).sort(), ["config", "handover", "imports"]);
    await assert.rejects(readFile(path.join(restoredDir, "manifest.json"), "utf8"), /ENOENT/u);

    await assert.rejects(
      restoreBackup({ backupDir: directory, dataDir: restoredDir }),
      /不是空的/u,
    );
    await restoreBackup({ backupDir: directory, dataDir: restoredDir, force: true });

    await writeFile(path.join(directory, "config", "accounts.json"), "tampered\n");
    const check = await verifyBackup(directory);
    assert.equal(check.ok, false);
    assert.match(check.errors[0].reason, /大小不一致|校验和不一致/u);
    await assert.rejects(
      restoreBackup({ backupDir: directory, dataDir: path.join(root, "third") }),
      /备份校验失败/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a manifest cannot point outside its backup directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-backup-traversal-"));
  try {
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      version: 1,
      files: [{ path: "../escape.json", size: 1, sha256: "0".repeat(64) }],
    }));
    await assert.rejects(readManifest(root), /不能包含 \.\./u);
    await assert.rejects(verifyBackup(root), /不能包含 \.\./u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI creates, verifies and restores a backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-backup-cli-"));
  try {
    const dataDir = path.join(root, "data");
    const outDir = path.join(root, "out");
    await seedData(dataDir);
    await mkdir(outDir);
    const cli = fileURLToPath(new URL("../src/backup-cli.mjs", import.meta.url));

    const created = await run(process.execPath, [cli, "create", "--data-dir", dataDir, "--out", outDir]);
    const createdJson = JSON.parse(created.stdout);
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.files, 4);

    const verified = await run(process.execPath, [cli, "verify", "--backup", createdJson.directory]);
    assert.equal(JSON.parse(verified.stdout).ok, true);

    const restoredDir = path.join(root, "restored");
    const restored = await run(process.execPath, [cli, "restore", "--backup", createdJson.directory, "--data-dir", restoredDir]);
    assert.equal(JSON.parse(restored.stdout).restored, 4);
    assert.equal(await readFile(path.join(restoredDir, "imports", "readme.txt"), "utf8"), "产品资料\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
