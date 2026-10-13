import assert from "node:assert/strict";
import test from "node:test";

import {
  startManagedProcess,
  stopManagedProcess,
  waitForManagedProcess,
} from "../src/processes.mjs";

test("managed process starts without a shell and reports a clean exit", async () => {
  const argument = "text; this is data, not a command";
  const child = await startManagedProcess(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", argument],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(child.pid > 0, true);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  const stdoutEnded = new Promise((resolve) => child.stdout.once("end", resolve));
  assert.deepEqual(await waitForManagedProcess(child), { code: 0, signal: null });
  await stdoutEnded;
  assert.equal(output, argument);
});

test("managed process can be stopped and then awaited", async () => {
  const child = await startManagedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const result = await stopManagedProcess(child, { timeoutMs: 2000 });
  assert.ok(result.code !== 0 || result.signal !== null);
  assert.deepEqual(await waitForManagedProcess(child), result);
});

test("process adapter validates command arguments and stop options", async () => {
  await assert.rejects(startManagedProcess("", []), /executable is required/);
  await assert.rejects(startManagedProcess(process.execPath, [1]), /array of strings/);
  await assert.rejects(
    stopManagedProcess({}, { timeoutMs: 1 }),
    /not started by this platform adapter/,
  );
});
