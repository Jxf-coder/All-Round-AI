import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDataMigrations } from "../src/migrations.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function withDataDir(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "allround-migrations-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function readManifest(dataDir) {
  return JSON.parse(await readFile(path.join(dataDir, "config", "schema.json"), "utf8"));
}

test("pending migrations run once in order and record the manifest", async () => {
  await withDataDir(async (dataDir) => {
    const calls = [];
    const migrations = [
      {
        version: 1,
        name: "create-marker",
        async up(context) {
          calls.push(1);
          await context.write("one.json", { step: 1 });
        },
      },
      {
        version: 2,
        name: "extend-marker",
        async up(context) {
          calls.push(2);
          const previous = await context.read("one.json");
          await context.write("two.json", { step: previous.step + 1 });
        },
      },
    ];
    const now = () => new Date("2026-01-02T03:04:05.000Z");

    const first = await runDataMigrations({ dataDir, migrations, now });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(first.schemaVersion, 2);
    assert.deepEqual(first.applied.map((entry) => entry.version), [1, 2]);
    assert.match(first.backupDirectory, /backups/);
    assert.equal(await exists(first.backupDirectory), true);

    const manifest = await readManifest(dataDir);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.applied.map((entry) => entry.version), [1, 2]);
    assert.equal(manifest.applied[0].appliedAt, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "config", "two.json"), "utf8")),
      { step: 2 },
    );

    const second = await runDataMigrations({ dataDir, migrations, now });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(second.schemaVersion, 2);
    assert.deepEqual(second.applied, []);
    assert.equal(second.backupDirectory, null);
  });
});

test("data written by a newer schema is refused instead of downgraded", async () => {
  await withDataDir(async (dataDir) => {
    const configDir = path.join(dataDir, "config");
    await mkdir(configDir, { recursive: true });
    const manifestPath = path.join(configDir, "schema.json");
    const original = { version: 1, schemaVersion: 5, applied: [] };
    await writeFile(manifestPath, JSON.stringify(original), "utf8");

    await assert.rejects(
      runDataMigrations({
        dataDir,
        migrations: [{ version: 1, name: "baseline", async up() {} }],
      }),
      /newer version/,
    );
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), original);
  });
});

test("a failing migration restores the previous data and keeps its manifest", async () => {
  await withDataDir(async (dataDir) => {
    const baseline = {
      version: 1,
      name: "baseline",
      async up(context) {
        await context.write("one.json", { kept: true });
      },
    };
    await runDataMigrations({ dataDir, migrations: [baseline] });

    const broken = {
      version: 2,
      name: "broken",
      async up(context) {
        await context.write("partial.json", { never: "committed" });
        throw new Error("synthetic failure");
      },
    };
    await assert.rejects(
      runDataMigrations({ dataDir, migrations: [baseline, broken] }),
      /Data migration 2 \(broken\) failed: synthetic failure/,
    );

    const manifest = await readManifest(dataDir);
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.applied.map((entry) => entry.version), [1]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "config", "one.json"), "utf8")),
      { kept: true },
    );
    assert.equal(await exists(path.join(dataDir, "config", "partial.json")), false);
    assert.equal(await exists(path.join(dataDir, "config", "schema.lock")), false);
  });
});

test("a corrupted manifest fails closed", async () => {
  await withDataDir(async (dataDir) => {
    const configDir = path.join(dataDir, "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "schema.json"), "{ not json", "utf8");

    await assert.rejects(
      runDataMigrations({
        dataDir,
        migrations: [{ version: 1, name: "baseline", async up() {} }],
      }),
      SyntaxError,
    );
  });
});

test("an existing migration lock stops a second process", async () => {
  await withDataDir(async (dataDir) => {
    const configDir = path.join(dataDir, "config");
    await mkdir(configDir, { recursive: true });
    const lockPath = path.join(configDir, "schema.lock");
    await writeFile(lockPath, "1234\n", "utf8");

    await assert.rejects(
      runDataMigrations({
        dataDir,
        migrations: [{ version: 1, name: "baseline", async up() {} }],
      }),
      /Another All Round AI process is migrating/,
    );
    assert.equal(await exists(lockPath), true);
  });
});

test("migration writes cannot escape the data directory", async () => {
  await withDataDir(async (dataDir) => {
    await assert.rejects(
      runDataMigrations({
        dataDir,
        migrations: [{
          version: 1,
          name: "escaping",
          async up(context) {
            await context.write("../outside.json", { nope: true });
          },
        }],
      }),
      /escapes the data directory/,
    );
    assert.equal(await exists(path.join(dataDir, "outside.json")), false);
  });
});

test("migration registration is validated up front", async () => {
  await withDataDir(async (dataDir) => {
    const base = { version: 1, name: "baseline", async up() {} };
    await assert.rejects(
      runDataMigrations({ dataDir, migrations: [] }),
      /At least one data migration/,
    );
    await assert.rejects(
      runDataMigrations({ dataDir, migrations: [{ version: 1, name: "", async up() {} }] }),
      /integer version, a name and an up function/,
    );
    await assert.rejects(
      runDataMigrations({ dataDir, migrations: [base, { ...base, name: "again" }] }),
      /Duplicate data migration version/,
    );
    await assert.rejects(
      runDataMigrations({
        dataDir,
        migrations: [base, { version: 3, name: "gap", async up() {} }].reverse(),
      }),
      /ascending version order/,
    );
  });
});
