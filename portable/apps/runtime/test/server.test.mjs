import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalRuntime } from "../src/server.mjs";
import { startManagedProcess, stopManagedProcess } from "../../../packages/platform/src/processes.mjs";

test("local runtime serves health only on loopback and logs its lifecycle", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-"));
  const dataDirectory = path.join(temporaryRoot, "data files");
  let runtime;
  try {
    runtime = await startLocalRuntime({
      env: { ALLROUND_AI_DATA_DIR: dataDirectory },
      home: temporaryRoot,
      port: 0,
    });
    assert.equal(runtime.address.address, "127.0.0.1");
    assert.equal(runtime.address.port > 0, true);

    const health = await fetch(`${runtime.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { service: "all-round-ai", status: "ok" });

    const unknown = await fetch(`${runtime.url}/`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "Not found" });

    await runtime.close();
    await runtime.close();
    const log = await readFile(path.join(dataDirectory, "logs", "runtime.jsonl"), "utf8");
    assert.match(log, /Local runtime started/);
    assert.match(log, /Local runtime stopped/);
    await assert.rejects(fetch(`${runtime.url}/health`));
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime rejects invalid ports before opening a listener", async () => {
  await assert.rejects(startLocalRuntime({ port: 65536 }), /Port must be an integer/);
  await assert.rejects(startLocalRuntime({ port: "not-a-port" }), /Port must be an integer/);
});

test("runtime command starts, answers health checks, logs, and shuts down cleanly", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-runtime-cli-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const mainPath = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  let child;
  let output = "";
  let errors = "";
  try {
    child = await startManagedProcess(process.execPath, [mainPath], {
      env: {
        ...process.env,
        ALLROUND_AI_DATA_DIR: dataDirectory,
        ALLROUND_AI_PORT: "0",
        LOCALAPPDATA: temporaryRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shutdownMessage: "shutdown",
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (errors += chunk));

    const runtimeUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime did not start: ${errors}`)), 5000);
      const checkReady = () => {
        const match = output.match(/All-Round-AI local runtime: (http:\/\/127\.0\.0\.1:\d+)\/health/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", checkReady);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`runtime exited before ready (${code}): ${errors}`));
      });
      checkReady();
    });

    const response = await fetch(`${runtimeUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "all-round-ai", status: "ok" });
    assert.deepEqual(await stopManagedProcess(child), { code: 0, signal: null });
    const log = await readFile(path.join(dataDirectory, "logs", "runtime.jsonl"), "utf8");
    assert.match(log, /Local runtime started/);
    assert.match(log, /Local runtime stopped/);
  } finally {
    if (child) await stopManagedProcess(child).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
