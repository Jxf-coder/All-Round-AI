import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeviceRegistry, hashDeviceToken } from "../src/devices.mjs";
import { startLocalRuntime } from "../src/server.mjs";

async function seededRegistry(root, overrides = {}) {
  let current = new Date("2026-10-20T08:00:00.000Z");
  const registry = await createDeviceRegistry({
    filePath: path.join(root, "devices.json"),
    now: () => new Date(current.getTime()),
    ticketTtlMs: 60_000,
    heartbeatFreshMs: 30_000,
    ...overrides,
  });
  return {
    registry,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

test("a ticket pairs once and only the token hash reaches the disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-devices-"));
  try {
    const { registry } = await seededRegistry(root);
    const ticket = registry.issueTicket({ actorId: "user-admin" });
    assert.match(ticket.ticket, /^tkt_/u);

    const paired = await registry.pair({
      ticket: ticket.ticket,
      name: "设计部 Mac",
      platform: "darwin",
      version: "1.0.0",
      capabilities: ["files", "screen", "files"],
    });
    assert.match(paired.token, /^[A-Za-z0-9_-]{40,}$/u);
    assert.equal(paired.device.name, "设计部 Mac");
    assert.deepEqual(paired.device.capabilities, ["files", "screen"]);
    assert.equal(paired.device.status, "offline");
    assert.equal(paired.device.online, false);
    assert.equal("tokenHash" in paired.device, false);

    const stored = await readFile(path.join(root, "devices.json"), "utf8");
    assert.equal(stored.includes(paired.token), false);
    const document = JSON.parse(stored);
    assert.equal(document.devices[0].tokenHash, createHash("sha256").update(paired.token).digest("hex"));
    assert.equal(document.devices[0].tokenHash, hashDeviceToken(paired.token));

    await assert.rejects(
      registry.pair({ ticket: ticket.ticket, name: "另一台", platform: "linux" }),
      /配对票据无效或已使用/u,
    );
    await assert.rejects(
      registry.pair({ ticket: registry.issueTicket().ticket, name: "设计部 Mac", platform: "linux" }),
      /设备名称已存在/u,
    );
    await assert.rejects(
      registry.pair({ ticket: registry.issueTicket().ticket, platform: "linux" }),
      /缺少设备名称/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeats authenticate, refresh online status and stop after revoke", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-devices-heartbeat-"));
  try {
    const { registry, advance } = await seededRegistry(root);
    const ticket = registry.issueTicket();
    const { device, token } = await registry.pair({
      ticket: ticket.ticket,
      name: "办公室 PC",
      platform: "win32",
      version: "1.0.0",
    });

    await assert.rejects(registry.heartbeat({ token: "not-a-token" }), /设备凭据无效/u);
    assert.equal((await registry.list())[0].online, false);

    advance(10_000);
    const beat = await registry.heartbeat({ token, version: "1.0.1" });
    assert.equal(beat.online, true);
    assert.equal(beat.version, "1.0.1");
    assert.equal((await registry.list())[0].status, "online");

    advance(31_000);
    assert.equal((await registry.list())[0].status, "offline");

    assert.equal(await registry.revoke("dev-000000000000"), false);
    await assert.rejects(registry.revoke("bad-id"), /设备 id 无效/u);
    assert.equal(await registry.revoke(device.id), true);
    assert.deepEqual(await registry.list(), []);
    await assert.rejects(registry.heartbeat({ token }), /设备凭据无效/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired ticket is refused and a damaged document fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-devices-expiry-"));
  try {
    const { registry, advance } = await seededRegistry(root);
    const expired = registry.issueTicket();
    advance(61_000);
    await assert.rejects(
      registry.pair({ ticket: expired.ticket, name: "迟到的设备", platform: "linux" }),
      /已过期/u,
    );

    await writeFile(path.join(root, "devices.json"), "{\"schema\":1,\"devices\":[{\"id\":\"bad\"}]}\n");
    await assert.rejects(registry.list(), /无效 id/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the device API issues tickets, pairs, lists and revokes under roles", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-devices-api-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: {
          id: user,
          name: user,
          role: user.startsWith("member") ? "member" : "admin",
          source: "all-round-ai",
        },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });

    async function login(user) {
      const response = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: runtime.url },
        body: JSON.stringify({ user, password: "synthetic-test-password" }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }
    const admin = { "content-type": "application/json", origin: runtime.url, cookie: await login("admin@example.test") };
    const member = { "content-type": "application/json", origin: runtime.url, cookie: await login("member@example.test") };

    const empty = await (await fetch(`${runtime.url}/api/devices`, { headers: { cookie: member.cookie } })).json();
    assert.deepEqual(empty.devices, []);

    const denied = await fetch(`${runtime.url}/api/devices/tickets`, { method: "POST", headers: member, body: "{}" });
    assert.equal(denied.status, 403);

    const created = await fetch(`${runtime.url}/api/devices/tickets`, { method: "POST", headers: admin, body: "{}" });
    assert.equal(created.status, 201);
    const { ticket } = await created.json();

    const paired = await fetch(`${runtime.url}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({
        ticket,
        name: "设计部 Mac",
        platform: "darwin",
        version: "1.0.0",
        capabilities: ["files"],
      }),
    });
    assert.equal(paired.status, 201);
    const pairing = await paired.json();
    assert.equal(pairing.device.status, "offline");
    assert.equal(JSON.stringify(pairing).includes("tokenHash"), false);

    const replay = await fetch(`${runtime.url}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ ticket, name: "重放", platform: "linux" }),
    });
    assert.equal(replay.status, 401);

    const missing = await fetch(`${runtime.url}/api/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: "{}",
    });
    assert.equal(missing.status, 401);

    const beat = await fetch(`${runtime.url}/api/devices/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: runtime.url,
        authorization: `Bearer ${pairing.token}`,
      },
      body: JSON.stringify({ version: "1.0.1" }),
    });
    assert.equal(beat.status, 200);
    const heartbeat = await beat.json();
    assert.equal(heartbeat.device.status, "online");
    assert.equal(heartbeat.device.version, "1.0.1");

    const listed = await (await fetch(`${runtime.url}/api/devices`, { headers: { cookie: member.cookie } })).json();
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].name, "设计部 Mac");
    assert.equal(listed.devices[0].online, true);

    const memberRevoke = await fetch(`${runtime.url}/api/devices/${pairing.device.id}`, {
      method: "DELETE",
      headers: member,
    });
    assert.equal(memberRevoke.status, 403);

    const revoked = await fetch(`${runtime.url}/api/devices/${pairing.device.id}`, {
      method: "DELETE",
      headers: admin,
    });
    assert.equal(revoked.status, 200);

    const afterRevoke = await fetch(`${runtime.url}/api/devices/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: runtime.url,
        "x-device-token": pairing.token,
      },
      body: "{}",
    });
    assert.equal(afterRevoke.status, 401);

    const missingDevice = await fetch(`${runtime.url}/api/devices/dev-000000000000`, {
      method: "DELETE",
      headers: admin,
    });
    assert.equal(missingDevice.status, 404);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
