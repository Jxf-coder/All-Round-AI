import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureScreen, LocalScreenError, MAX_SCREEN_BYTES } from "../src/local-screen.mjs";

function fakePng(width, height) {
  const buffer = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function onlyExisting(...allowed) {
  const set = new Set(allowed);
  return async (file) => {
    if (!set.has(file)) throw new Error("ENOENT");
  };
}

test("a successful capture returns base64 PNG dimensions and removes the temp file", async () => {
  const removed = [];
  const calls = [];
  const result = await captureScreen({
    platform: "linux",
    tmpDir: "/tmp",
    pathApi: path.posix,
    env: { PATH: "/usr/bin" },
    now: () => 1_700_000_000_000,
    existsImpl: onlyExisting("/usr/bin/grim"),
    run: async (options) => {
      calls.push(options);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    readFileImpl: async (file) => {
      assert.match(file, /^\/tmp\/allround-screen-[a-z0-9]+-[a-f0-9]{10}\.png$/u);
      return fakePng(1920, 1080);
    },
    unlinkImpl: async (file) => {
      removed.push(file);
    },
  });

  assert.equal(calls[0].program, "/usr/bin/grim");
  assert.equal(calls[0].args.length, 1);
  assert.match(calls[0].args[0], /\.png$/u);
  assert.equal(calls[0].timeoutMs, 20_000);
  assert.equal(result.format, "png");
  assert.equal(result.bytes, 32);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(Buffer.from(result.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(removed, [calls[0].args[0]]);
});

test("a failing tool is reported and the temp file is still removed", async () => {
  const removed = [];
  await assert.rejects(
    captureScreen({
      platform: "linux",
      tmpDir: "/tmp",
      pathApi: path.posix,
      env: { PATH: "/usr/bin" },
      existsImpl: onlyExisting("/usr/bin/scrot"),
      run: async () => ({ code: 1, stdout: "", stderr: "cannot open display", timedOut: false }),
      readFileImpl: async () => fakePng(10, 10),
      unlinkImpl: async (file) => {
        removed.push(file);
      },
    }),
    (error) => error instanceof LocalScreenError
      && error.code === "CAPTURE_FAILED"
      && /cannot open display/u.test(error.message),
  );
  assert.equal(removed.length, 1);
});

test("timeouts, missing output, empty files and oversized screenshots are rejected", async () => {
  const base = {
    platform: "linux",
    tmpDir: "/tmp",
    pathApi: path.posix,
    env: { PATH: "/usr/bin" },
    existsImpl: onlyExisting("/usr/bin/grim"),
    unlinkImpl: async () => {},
  };

  await assert.rejects(
    captureScreen({ ...base, run: async () => ({ code: 0, timedOut: true }) }),
    (error) => error.code === "TIMEOUT",
  );
  await assert.rejects(
    captureScreen({ ...base, run: async () => ({ code: 0 }), readFileImpl: async () => null }),
    (error) => error.code === "NO_OUTPUT",
  );
  await assert.rejects(
    captureScreen({ ...base, run: async () => ({ code: 0 }), readFileImpl: async () => Buffer.alloc(0) }),
    (error) => error.code === "EMPTY",
  );
  await assert.rejects(
    captureScreen({
      ...base,
      run: async () => ({ code: 0 }),
      readFileImpl: async () => Buffer.alloc(MAX_SCREEN_BYTES + 1, 1),
    }),
    (error) => error.code === "TOO_LARGE",
  );
  await assert.rejects(
    captureScreen({ ...base, maxBytes: 0, run: async () => ({ code: 0 }) }),
    (error) => error.code === "BAD_LIMIT",
  );
});

test("each platform uses its own fixed capture tool", async () => {
  const powershell = path.win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const windowsCalls = [];
  await captureScreen({
    platform: "win32",
    tmpDir: "C:\\Temp",
    pathApi: path.win32,
    env: { SystemRoot: "C:\\Windows", PATH: "" },
    existsImpl: onlyExisting(powershell),
    run: async (options) => {
      windowsCalls.push(options);
      return { code: 0 };
    },
    readFileImpl: async () => fakePng(800, 600),
    unlinkImpl: async () => {},
  });
  assert.equal(windowsCalls[0].program, powershell);
  assert.equal(windowsCalls[0].args.includes("-NoProfile"), true);
  assert.match(windowsCalls[0].args.at(-1), /CopyFromScreen/u);

  const macCalls = [];
  await captureScreen({
    platform: "darwin",
    tmpDir: "/tmp",
    pathApi: path.posix,
    env: {},
    existsImpl: onlyExisting("/usr/sbin/screencapture"),
    run: async (options) => {
      macCalls.push(options);
      return { code: 0 };
    },
    readFileImpl: async () => fakePng(1512, 982),
    unlinkImpl: async () => {},
  });
  assert.equal(macCalls[0].program, "/usr/sbin/screencapture");
  assert.deepEqual(macCalls[0].args.slice(0, 1), ["-x"]);

  await assert.rejects(
    captureScreen({
      platform: "linux",
      tmpDir: "/tmp",
      pathApi: path.posix,
      env: { PATH: "/usr/bin:/bin" },
      existsImpl: onlyExisting("/usr/bin/nothing"),
      run: async () => ({ code: 0 }),
    }),
    (error) => error.code === "NO_TOOL" && /grim/u.test(error.message),
  );
  await assert.rejects(
    captureScreen({ platform: "aix", tmpDir: "/tmp", pathApi: path.posix, env: {} }),
    (error) => error.code === "UNSUPPORTED",
  );
});

test("the default temp directory lives in the OS temp folder", async () => {
  const removed = [];
  await captureScreen({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    existsImpl: onlyExisting("/usr/bin/grim"),
    run: async () => ({ code: 0 }),
    readFileImpl: async () => fakePng(1, 1),
    unlinkImpl: async (file) => {
      removed.push(file);
    },
  });
  assert.equal(path.dirname(removed[0]), os.tmpdir());
});
