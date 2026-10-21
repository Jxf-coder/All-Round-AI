import assert from "node:assert/strict";
import test from "node:test";

import { createMediaToolProbe, detectMediaTools, MEDIA_PROBE_TTL_MS } from "../src/media-tools.mjs";

function runnerStub(seen) {
  return async (command, args, options) => {
    seen.push({ command, args, options });
    if (command === "ffmpeg") return { stdout: "ffmpeg version 6.1.1 Copyright (c) 2000-2023\nbuilt with gcc\n" };
    if (command === "ffprobe") return { stdout: "ffprobe version 6.1.1\n" };
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
}

test("both binaries are probed with a fixed command, no shell and a minimal environment", async () => {
  const seen = [];
  const result = await detectMediaTools({ runner: runnerStub(seen) });
  assert.equal(result.ffmpeg.available, true);
  assert.equal(result.ffmpeg.version, "ffmpeg version 6.1.1 Copyright (c) 2000-2023");
  assert.equal(result.ffprobe.version, "ffprobe version 6.1.1");
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.deepEqual(call.args, ["-version"]);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5_000);
    assert.equal(Object.keys(call.options.env).includes("PATH"), true);
    assert.equal(Object.keys(call.options.env).includes("HOME"), false);
  }
});

test("a missing binary is reported with a readable reason instead of throwing", async () => {
  const result = await detectMediaTools({
    runner: async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(result.ffmpeg.available, false);
  assert.equal(result.ffmpeg.path, null);
  assert.match(result.ffmpeg.reason, /未安装/u);

  const timedOut = await detectMediaTools({
    runner: async () => {
      throw Object.assign(new Error("timeout"), { killed: true });
    },
  });
  assert.match(timedOut.ffmpeg.reason, /超时/u);
});

test("the probe caches its answer and a refresh bypasses the cache", async () => {
  const seen = [];
  let now = 1_000;
  const probe = createMediaToolProbe({
    runner: runnerStub(seen),
    ttlMs: MEDIA_PROBE_TTL_MS,
    now: () => now,
  });
  await probe();
  await probe();
  assert.equal(seen.length, 2);

  now += MEDIA_PROBE_TTL_MS + 1;
  await probe();
  assert.equal(seen.length, 4);

  await probe({ refresh: true });
  assert.equal(seen.length, 6);
});
