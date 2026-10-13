import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureAppDirectories, resolveAppDirectories } from "../src/directories.mjs";

test("application config and logs live under its data directory", () => {
  const directories = resolveAppDirectories({
    platform: "win32",
    home: "C:\\Users\\Ada",
    env: { ALLROUND_AI_DATA_DIR: "D:\\AI Data\\All-Round-AI", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
  });
  assert.deepEqual(directories, {
    data: "D:\\AI Data\\All-Round-AI",
    config: "D:\\AI Data\\All-Round-AI\\config",
    logs: "D:\\AI Data\\All-Round-AI\\logs",
    cache: "C:\\Users\\Ada\\AppData\\Local\\All-Round-AI\\Cache",
    temp: "C:\\Users\\Ada\\AppData\\Local\\All-Round-AI\\Cache\\tmp",
  });
});

test("macOS and Linux use their standard cache roots", () => {
  assert.equal(
    resolveAppDirectories({ platform: "darwin", home: "/Users/ada", env: {} }).cache,
    "/Users/ada/Library/Caches/All-Round-AI",
  );
  assert.equal(
    resolveAppDirectories({ platform: "linux", home: "/home/ada", env: { XDG_CACHE_HOME: "/mnt/cache" } }).cache,
    "/mnt/cache/all-round-ai",
  );
});

test("ensureAppDirectories creates and verifies writable app directories", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-dirs-"));
  try {
    const dataRoot = path.join(temporaryRoot, "user data");
    const directories = await ensureAppDirectories({
      platform: process.platform,
      home: temporaryRoot,
      env: { ALLROUND_AI_DATA_DIR: dataRoot },
    });
    assert.equal(directories.data, dataRoot);
    for (const directory of Object.values(directories)) {
      const { access } = await import("node:fs/promises");
      await access(directory);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
