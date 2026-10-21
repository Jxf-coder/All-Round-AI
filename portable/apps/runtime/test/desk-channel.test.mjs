import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeCommand,
  fetchNextCommand,
  pollOnce,
  runCommandLoop,
  submitResult,
} from "../src/desk-channel.mjs";

function configWith(roots) {
  return { serverUrl: "http://127.0.0.1:3000", token: "t".repeat(40), roots };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the desk long-polls with its bearer token and handles empty queues", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    return jsonResponse(200, { command: null });
  };
  const command = await fetchNextCommand({ config: configWith([]), waitMs: 1_000, fetchImpl });
  assert.equal(command, null);
  assert.match(calls[0].url, /\/api\/devices\/commands\?wait=1000$/u);
  assert.equal(calls[0].authorization, `Bearer ${"t".repeat(40)}`);
});

test("a revoked device token stops the desk instead of retrying", async () => {
  const fetchImpl = async () => jsonResponse(401, { error: "设备凭据无效" });
  await assert.rejects(
    fetchNextCommand({ config: configWith([]), fetchImpl }),
    (error) => error.code === "DEVICE_UNAUTHORIZED",
  );
  await assert.rejects(
    submitResult({ config: configWith([]), commandId: "cmd_x", ok: true, fetchImpl }),
    (error) => error.code === "DEVICE_UNAUTHORIZED",
  );
});

test("server failures surface as errors, not as an empty command", async () => {
  const fetchImpl = async () => jsonResponse(503, { error: "维护中" });
  await assert.rejects(
    fetchNextCommand({ config: configWith([]), fetchImpl }),
    /HTTP 503/u,
  );
});

test("file commands stay inside the configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-channel-"));
  try {
    await writeFile(path.join(root, "note.txt"), "hello desk\n");
    await mkdir(path.join(root, "sub"));
    const config = configWith([root]);

    const listed = await executeCommand({
      config,
      command: { type: "files.list", payload: { path: root } },
    });
    assert.deepEqual(listed.entries.map((entry) => entry.name), ["note.txt", "sub"]);
    assert.equal(listed.entries[1].type, "directory");

    const read = await executeCommand({
      config,
      command: { type: "files.read", payload: { path: path.join(root, "note.txt") } },
    });
    assert.equal(read.text, "hello desk\n");
    assert.equal(read.size, 11);

    const written = await executeCommand({
      config,
      command: { type: "files.write", payload: { path: path.join(root, "out.txt"), content: "written\n" } },
    });
    assert.equal(written.size, 8);
    assert.equal((await readFile(path.join(root, "out.txt"), "utf8")), "written\n");

    await assert.rejects(
      executeCommand({ config, command: { type: "files.write", payload: { path: path.join(root, "no.txt") } } }),
      /缺少写入内容/u,
    );

    await assert.rejects(
      executeCommand({ config, command: { type: "files.read", payload: { path: path.join(root, "..", "x") } } }),
      /路径不存在|不在允许访问的目录里/u,
    );
    await assert.rejects(
      executeCommand({ config, command: { type: "process.spawn", payload: { path: root } } }),
      /不支持的设备命令/u,
    );
    await assert.rejects(
      executeCommand({ config: configWith([]), command: { type: "files.list", payload: { path: root } } }),
      /没有配置允许访问的目录/u,
    );
    await assert.rejects(
      executeCommand({ config, command: { type: "files.list", payload: {} } }),
      /缺少路径/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process commands only run allow-listed programs inside the roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-process-"));
  try {
    const config = { ...configWith([root]), allow: [process.execPath] };
    const result = await executeCommand({
      config,
      command: {
        type: "process.run",
        payload: { command: process.execPath, args: ["-e", "process.stdout.write('hi')"] },
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hi");

    await assert.rejects(
      executeCommand({
        config: { ...config, allow: [] },
        command: { type: "process.run", payload: { command: process.execPath } },
      }),
      /没有配置允许运行的程序/u,
    );
    await assert.rejects(
      executeCommand({
        config,
        command: { type: "process.run", payload: { command: process.execPath, cwd: path.join(root, "..") } },
      }),
      /不在允许访问的目录里/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("screen capture needs an explicit opt-in from pairing", async () => {
  await assert.rejects(
    executeCommand({ config: configWith([]), command: { type: "screen.capture", payload: {} } }),
    /没有开启屏幕能力/u,
  );

  const fake = { format: "png", bytes: 3, width: 1, height: 1, data: "AAA" };
  let captured = 0;
  const result = await executeCommand({
    config: { ...configWith([]), screen: true },
    command: { type: "screen.capture" },
    captureImpl: async () => {
      captured += 1;
      return fake;
    },
  });
  assert.equal(captured, 1);
  assert.deepEqual(result, fake);
});

test("one poll executes the command and posts its result back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-poll-"));
  try {
    await writeFile(path.join(root, "readme.md"), "# desk\n");
    const posted = [];
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        posted.push({ url, body: JSON.parse(options.body) });
        return jsonResponse(202, { accepted: true });
      }
      return jsonResponse(200, {
        command: { id: "cmd_1234", type: "files.read", payload: { path: path.join(root, "readme.md") } },
      });
    };

    const outcome = await pollOnce({ config: configWith([root]), waitMs: 1_000, fetchImpl });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.ok, true);
    assert.equal(posted.length, 1);
    assert.match(posted[0].url, /\/api\/devices\/commands\/cmd_1234\/result$/u);
    assert.equal(posted[0].body.ok, true);
    assert.equal(posted[0].body.result.text, "# desk\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed command still reports its error so the operator sees why", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-poll-fail-"));
  try {
    const posted = [];
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        posted.push(JSON.parse(options.body));
        return jsonResponse(202, { accepted: true });
      }
      return jsonResponse(200, {
        command: { id: "cmd_5678", type: "files.read", payload: { path: path.join(root, "missing.txt") } },
      });
    };

    const outcome = await pollOnce({ config: configWith([root]), waitMs: 1_000, fetchImpl });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /路径不存在/u);
    assert.equal(posted[0].ok, false);
    assert.match(posted[0].error, /路径不存在/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command loop keeps going after a network error and stops on abort", async () => {
  const controller = new AbortController();
  let polls = 0;
  const errors = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return jsonResponse(202, { accepted: true });
    polls += 1;
    if (polls === 1) throw new Error("connect ECONNREFUSED");
    if (polls === 2) {
      return jsonResponse(200, { command: { id: "cmd_9", type: "files.list", payload: { path: os.tmpdir() } } });
    }
    return jsonResponse(200, { command: null });
  };

  const summary = await runCommandLoop({
    config: configWith([os.tmpdir()]),
    signal: controller.signal,
    waitMs: 1_000,
    retryMs: 10,
    fetchImpl,
    onCommand: () => controller.abort(),
    onError: (error) => errors.push(error.message),
  });
  assert.equal(summary.handled, 1);
  assert.deepEqual(errors, ["connect ECONNREFUSED"]);
});

test("the command loop stops immediately when the token is revoked", async () => {
  const fetchImpl = async () => jsonResponse(401, { error: "设备凭据无效" });
  await assert.rejects(
    runCommandLoop({ config: configWith([]), waitMs: 1_000, fetchImpl }),
    (error) => error.code === "DEVICE_UNAUTHORIZED",
  );
});
