import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpawnOptions,
  resolveDataDirectory,
  resolveDataPath,
} from "../src/paths.mjs";

test("Windows uses APPDATA for per-user data", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
    }),
    "C:\\Users\\Ada\\AppData\\Roaming\\All-Round-AI",
  );
});

test("Windows falls back to the standard roaming profile location", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: {},
    }),
    "C:\\Users\\Ada\\AppData\\Roaming\\All-Round-AI",
  );
});

test("macOS uses Application Support", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "darwin",
      home: "/Users/ada",
      env: {},
    }),
    "/Users/ada/Library/Application Support/All-Round-AI",
  );
});

test("Linux respects XDG_DATA_HOME", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "linux",
      home: "/home/ada",
      env: { XDG_DATA_HOME: "/mnt/data" },
    }),
    "/mnt/data/all-round-ai",
  );
});

test("Linux falls back to the user's local share directory", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "linux",
      home: "/home/ada",
      env: {},
    }),
    "/home/ada/.local/share/all-round-ai",
  );
});

test("an absolute explicit data directory takes precedence", () => {
  assert.equal(
    resolveDataDirectory({
      platform: "darwin",
      home: "/Users/ada",
      env: { ALLROUND_AI_DATA_DIR: "/Volumes/Work/AllRoundData" },
    }),
    "/Volumes/Work/AllRoundData",
  );
});

test("a relative explicit data directory is rejected", () => {
  assert.throws(
    () =>
      resolveDataDirectory({
        platform: "win32",
        home: "C:\\Users\\Ada",
        env: { ALLROUND_AI_DATA_DIR: "relative\\data" },
      }),
    /must be an absolute path/,
  );
});

test("data files resolve beneath the selected data directory", () => {
  assert.equal(
    resolveDataPath("projects\\one\\state.json", {
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
    }),
    "C:\\Users\\Ada\\AppData\\Roaming\\All-Round-AI\\projects\\one\\state.json",
  );
});

test("Windows traversal using backslashes is rejected", () => {
  assert.throws(
    () =>
      resolveDataPath("..\\..\\..\\Secrets\\token.txt", {
        platform: "win32",
        home: "C:\\Users\\Ada",
        env: {},
      }),
    /escapes the application data directory/,
  );
});

test("POSIX traversal is rejected", () => {
  assert.throws(
    () =>
      resolveDataPath("../outside/token.txt", {
        platform: "darwin",
        home: "/Users/ada",
        env: {},
      }),
    /escapes the application data directory/,
  );
});

test("absolute paths are not accepted as data-relative paths", () => {
  assert.throws(
    () =>
      resolveDataPath("C:\\Temp\\outside.txt", {
        platform: "win32",
        home: "C:\\Users\\Ada",
        env: {},
      }),
    /must be relative/,
  );
});

test("spawn options disable shell invocation and hide Windows child windows", () => {
  assert.deepEqual(
    buildSpawnOptions("win32", { cwd: "C:\\Work", shell: true, windowsHide: false }),
    { cwd: "C:\\Work", shell: false, windowsHide: true },
  );
});

test("spawn options remain shell-free on macOS and Linux", () => {
  assert.deepEqual(buildSpawnOptions("darwin", { shell: true }), { shell: false });
  assert.deepEqual(buildSpawnOptions("linux", {}), { shell: false });
});

test("unsupported operating systems are rejected explicitly", () => {
  assert.throws(() => resolveDataDirectory({ platform: "freebsd" }), /Unsupported operating system/);
  assert.throws(() => buildSpawnOptions("freebsd"), /Unsupported operating system/);
});
