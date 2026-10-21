import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  loadAgentConfig,
  pairDevice,
  runHeartbeatLoop,
  saveAgentConfig,
  sendHeartbeat,
} from "../src/desk-agent.mjs";

const run = promisify(execFile);
const TOKEN = "test-device-token-0123456789abcdef";

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function startStub() {
  const seen = { pair: 0, heartbeat: 0 };
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/devices/pair") {
      seen.pair += 1;
      const body = await readBody(request);
      if (body.ticket !== "tkt_good") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "配对票据无效或已使用" }));
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        device: {
          id: "dev-0123456789ab",
          name: body.name,
          platform: body.platform,
          version: body.version ?? null,
          capabilities: body.capabilities ?? [],
          pairedAt: "2026-10-20T08:00:00.000Z",
          lastSeenAt: null,
          status: "offline",
          online: false,
        },
        token: TOKEN,
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/devices/heartbeat") {
      seen.heartbeat += 1;
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "设备凭据无效" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        device: {
          id: "dev-0123456789ab",
          name: "设计部 Mac",
          status: "online",
          online: true,
        },
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("pairing returns a token and the config file keeps it private", async () => {
  const stub = await startStub();
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-"));
  try {
    const paired = await pairDevice({
      serverUrl: `${stub.url}/`,
      ticket: "tkt_good",
      name: "设计部 Mac",
      platform: "darwin",
      version: "1.0.0",
      capabilities: ["files"],
    });
    assert.equal(paired.serverUrl, stub.url);
    assert.equal(paired.device.id, "dev-0123456789ab");
    assert.equal(paired.token, TOKEN);
    assert.equal(stub.seen.pair, 1);

    const configPath = path.join(root, "desk-agent.json");
    await saveAgentConfig({
      filePath: configPath,
      serverUrl: paired.serverUrl,
      device: paired.device,
      token: paired.token,
    });
    const loaded = await loadAgentConfig(configPath);
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.name, "设计部 Mac");
    assert.equal(loaded.deviceId, "dev-0123456789ab");
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    }

    const beat = await sendHeartbeat({ config: loaded, version: "1.0.1" });
    assert.equal(beat.status, "online");
    assert.equal(stub.seen.heartbeat, 1);

    await assert.rejects(
      sendHeartbeat({ config: { ...loaded, token: "wrong-token-0000000000000000" } }),
      /设备凭据已失效/u,
    );
    await assert.rejects(
      pairDevice({ serverUrl: stub.url, ticket: "tkt_bad", name: "另一台" }),
      /配对失败（HTTP 401）：配对票据无效或已使用/u,
    );
    await assert.rejects(
      pairDevice({ serverUrl: "ftp://example.test", ticket: "tkt_good", name: "x" }),
      /必须是 http\(s\)/u,
    );
    await assert.rejects(
      pairDevice({ serverUrl: "not a url", ticket: "tkt_good", name: "x" }),
      /服务器地址无效/u,
    );
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing, damaged or incomplete config fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-config-"));
  try {
    const configPath = path.join(root, "desk-agent.json");
    await assert.rejects(loadAgentConfig(configPath), /还没有配对/u);

    await writeFile(configPath, "not json\n");
    await assert.rejects(loadAgentConfig(configPath), /不可读或已损坏/u);

    await writeFile(configPath, JSON.stringify({ schema: 1, deviceId: "dev-0123456789ab", name: "x" }));
    await assert.rejects(loadAgentConfig(configPath), /缺少有效令牌/u);

    await writeFile(configPath, JSON.stringify({
      schema: 1,
      serverUrl: "http://127.0.0.1:3141",
      deviceId: "dev-0123456789ab",
      name: "x",
      token: TOKEN,
    }));
    assert.equal((await loadAgentConfig(configPath)).serverUrl, "http://127.0.0.1:3141");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the config records allowed roots and refuses relative or malformed ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-roots-"));
  try {
    const configPath = path.join(root, "desk-agent.json");
    const allowed = path.join(root, "project");
    await saveAgentConfig({
      filePath: configPath,
      serverUrl: "http://127.0.0.1:3141",
      device: { id: "dev-0123456789ab", name: "办公室 PC", platform: "win32", pairedAt: "2026-10-20T08:00:00.000Z" },
      token: TOKEN,
      roots: [allowed, `${allowed}${path.sep}`, allowed],
    });
    const loaded = await loadAgentConfig(configPath);
    assert.deepEqual(loaded.roots, [allowed]);

    await assert.rejects(
      saveAgentConfig({
        filePath: configPath,
        serverUrl: "http://127.0.0.1:3141",
        device: { id: "dev-0123456789ab", name: "办公室 PC", platform: "win32", pairedAt: "2026-10-20T08:00:00.000Z" },
        token: TOKEN,
        roots: ["relative/path"],
      }),
      /必须是绝对路径/u,
    );

    await writeFile(configPath, JSON.stringify({
      schema: 1,
      serverUrl: "http://127.0.0.1:3141",
      deviceId: "dev-0123456789ab",
      name: "x",
      token: TOKEN,
      roots: "not-an-array",
    }));
    await assert.rejects(loadAgentConfig(configPath), /允许目录无效/u);

    await writeFile(configPath, JSON.stringify({
      schema: 1,
      serverUrl: "http://127.0.0.1:3141",
      deviceId: "dev-0123456789ab",
      name: "x",
      token: TOKEN,
      roots: ["relative/path"],
    }));
    await assert.rejects(loadAgentConfig(configPath), /允许目录无效/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the heartbeat loop backs off on failures and stops when aborted", async () => {
  const config = { serverUrl: "http://127.0.0.1:3141", token: TOKEN };
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("connect ECONNREFUSED");
    return {
      ok: true,
      status: 200,
      json: async () => ({ device: { id: "dev-0123456789ab", status: "online" } }),
    };
  };
  const waits = [];
  const beats = [];
  const errors = [];
  const controller = new AbortController();
  const summary = await runHeartbeatLoop({
    config,
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    fetchImpl,
    signal: controller.signal,
    waitImpl: async (ms) => {
      waits.push(ms);
      if (waits.length === 4) controller.abort();
    },
    onBeat: (device) => beats.push(device),
    onError: (error) => errors.push(error.message),
  });
  assert.deepEqual(waits, [2_000, 4_000, 1_000, 1_000]);
  assert.equal(summary.failures, 2);
  assert.equal(summary.beats, 2);
  assert.equal(beats.length, 2);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /ECONNREFUSED/u);
});

test("an invalid token stops the loop instead of retrying", async () => {
  await assert.rejects(
    runHeartbeatLoop({
      config: { serverUrl: "http://127.0.0.1:3141", token: TOKEN },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "设备凭据无效" }) }),
      waitImpl: async () => {
        throw new Error("should not wait");
      },
    }),
    /设备凭据已失效/u,
  );
  await assert.rejects(
    runHeartbeatLoop({ config: { serverUrl: "http://127.0.0.1:3141", token: TOKEN }, intervalMs: 500 }),
    /至少 1000 毫秒/u,
  );
});

test("the CLI pairs, heartbeats and reports status without the token", async () => {
  const stub = await startStub();
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-cli-"));
  try {
    const cli = fileURLToPath(new URL("../src/desk-cli.mjs", import.meta.url));
    const configPath = path.join(root, "desk-agent.json");

    const paired = JSON.parse((await run(process.execPath, [
      cli, "pair",
      "--server", stub.url,
      "--ticket", "tkt_good",
      "--name", "办公室 PC",
      "--platform", "win32",
      "--capabilities", "files,screen",
      "--config", configPath,
    ])).stdout);
    assert.equal(paired.ok, true);
    assert.equal(paired.device.name, "办公室 PC");
    assert.equal(JSON.stringify(paired).includes(TOKEN), false);

    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.token, TOKEN);

    const beat = JSON.parse((await run(process.execPath, [
      cli, "heartbeat", "--config", configPath,
    ])).stdout);
    assert.equal(beat.ok, true);
    assert.equal(beat.device.status, "online");

    const status = JSON.parse((await run(process.execPath, [
      cli, "status", "--config", configPath,
    ])).stdout);
    assert.equal(status.paired, true);
    assert.equal(status.name, "办公室 PC");
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    assert.equal(status.serverUrl, stub.url);

    const replay = await run(process.execPath, [
      cli, "pair",
      "--server", stub.url,
      "--ticket", "tkt_bad",
      "--name", "重放",
      "--config", path.join(root, "other.json"),
    ]).catch((error) => error);
    assert.equal(replay.code, 1);
    assert.match(replay.stderr, /配对失败（HTTP 401）/u);
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});
