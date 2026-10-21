import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAllowedProgram, runProcess } from "../src/local-process.mjs";

const NODE = process.execPath;

test("an allowed program runs and its output comes back", async () => {
  const result = await runProcess({
    program: NODE,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    timeoutMs: 5_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("arguments stay literal because no shell is involved", async () => {
  const literal = "a; echo hacked && whoami";
  const result = await runProcess({
    program: NODE,
    args: ["-e", "process.stdout.write(process.argv[1])", literal],
    timeoutMs: 5_000,
  });
  assert.equal(result.stdout, literal);
});

test("the allow list matches the resolved program path", async () => {
  assert.equal(await resolveAllowedProgram({ allow: [NODE], command: NODE }), await realpath(NODE));

  await assert.rejects(
    resolveAllowedProgram({ allow: [], command: NODE }),
    (error) => error.code === "NO_ALLOWLIST",
  );
  await assert.rejects(
    resolveAllowedProgram({ allow: [NODE], command: path.join(os.tmpdir(), "definitely-missing.exe") }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    resolveAllowedProgram({ allow: [path.join(os.tmpdir(), "other.exe")], command: NODE }),
    (error) => error.code === "NOT_ALLOWED" && /允许清单/u.test(error.message),
  );
  await assert.rejects(
    resolveAllowedProgram({ allow: [NODE], command: "node" }),
    (error) => error.code === "BAD_COMMAND",
  );
});

test("a runaway program is terminated at the timeout", async () => {
  const started = Date.now();
  const result = await runProcess({
    program: NODE,
    args: ["-e", "setTimeout(() => {}, 8000)"],
    timeoutMs: 1_000,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 6_000);
});

test("output beyond the cap is truncated instead of buffered", async () => {
  const result = await runProcess({
    program: NODE,
    args: ["-e", "process.stdout.write('x'.repeat(5000))"],
    timeoutMs: 5_000,
    maxOutputBytes: 1_000,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 1_000);
});

test("the working directory must be absolute and is honoured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-process-cwd-"));
  try {
    const result = await runProcess({
      program: NODE,
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: root,
      timeoutMs: 5_000,
    });
    assert.equal((await realpath(result.stdout)).toLowerCase(), (await realpath(root)).toLowerCase());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid process requests are refused before spawning", () => {
  assert.throws(() => runProcess({ program: "node" }), /必须是绝对路径/u);
  assert.throws(() => runProcess({ program: NODE, args: "nope" }), /参数必须是数组/u);
  assert.throws(
    () => runProcess({ program: NODE, args: Array.from({ length: 33 }, () => "x") }),
    /不能超过 32 个/u,
  );
  assert.throws(() => runProcess({ program: NODE, args: [null] }), /参数必须是字符串/u);
  assert.throws(
    () => runProcess({ program: NODE, args: ["a\u0000b"] }),
    /空字符/u,
  );
  assert.throws(() => runProcess({ program: NODE, cwd: "relative" }), /工作目录/u);
  assert.throws(() => runProcess({ program: NODE, timeoutMs: 10 }), /超时/u);
  assert.throws(() => runProcess({ program: NODE, timeoutMs: 90_000 }), /超时/u);
  assert.throws(() => runProcess({ program: NODE, maxOutputBytes: 0 }), /输出上限/u);
});

test("a missing executable rejects instead of crashing the agent", async () => {
  await assert.rejects(
    runProcess({ program: path.join(os.tmpdir(), "definitely-missing-program.exe") }),
    (error) => error.code === "SPAWN_FAILED",
  );
});
