import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";
import { RUNTIME_SCHEMA_VERSION } from "../src/migrations.mjs";

const syntheticAuth = async () => ({
  ok: true,
  user: { id: "schema-user", name: "Schema User", role: "admin", source: "all-round-ai" },
  landing: "/",
});

async function start(dataDirectory) {
  return startLocalRuntime({
    authProvider: syntheticAuth,
    env: { ALLROUND_AI_DATA_DIR: dataDirectory },
    port: 0,
  });
}

test("the runtime records the data schema before opening any store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-schema-"));
  const dataDirectory = path.join(root, "data");
  try {
    const first = await start(dataDirectory);
    try {
      assert.equal(first.schemaVersion, RUNTIME_SCHEMA_VERSION);
      const manifestPath = path.join(dataDirectory, "config", "schema.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.schemaVersion, RUNTIME_SCHEMA_VERSION);
      assert.deepEqual(manifest.applied.map((entry) => entry.version), [RUNTIME_SCHEMA_VERSION]);
    } finally {
      await first.close();
    }

    const second = await start(dataDirectory);
    try {
      assert.equal(second.schemaVersion, RUNTIME_SCHEMA_VERSION);
      const manifest = JSON.parse(
        await readFile(path.join(dataDirectory, "config", "schema.json"), "utf8"),
      );
      // A restart on the same data directory must not replay the baseline.
      assert.equal(manifest.applied.length, 1);
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the runtime refuses a data directory written by a newer release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-schema-newer-"));
  const dataDirectory = path.join(root, "data");
  const configDirectory = path.join(dataDirectory, "config");
  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "schema.json"),
      JSON.stringify({ version: 1, schemaVersion: 99, applied: [] }),
      "utf8",
    );

    await assert.rejects(start(dataDirectory), /newer version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
