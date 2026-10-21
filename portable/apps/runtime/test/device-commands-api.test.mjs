import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeviceChannel } from "../src/device-channel.mjs";
import { startLocalRuntime } from "../src/server.mjs";

async function boot() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-device-commands-"));
  const channel = createDeviceChannel({ commandTtlMs: 1_000 });
  const runtime = await startLocalRuntime({
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
    deviceChannel: channel,
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

  const admin = {
    "content-type": "application/json",
    origin: runtime.url,
    cookie: await login("admin@example.test"),
  };
  const member = {
    "content-type": "application/json",
    origin: runtime.url,
    cookie: await login("member@example.test"),
  };

  async function pairDevice(name) {
    const created = await fetch(`${runtime.url}/api/devices/tickets`, {
      method: "POST",
      headers: admin,
      body: "{}",
    });
    assert.equal(created.status, 201);
    const { ticket } = await created.json();
    const paired = await fetch(`${runtime.url}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ ticket, name, platform: process.platform, version: "1.0.0" }),
    });
    assert.equal(paired.status, 201);
    return paired.json();
  }

  function deviceHeaders(token) {
    return {
      "content-type": "application/json",
      origin: runtime.url,
      authorization: `Bearer ${token}`,
    };
  }

  return {
    runtime,
    channel,
    admin,
    member,
    pairDevice,
    deviceHeaders,
    async close() {
      await runtime.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("a command travels from the workbench to the desk and back over the poll", async () => {
  const app = await boot();
  try {
    const { device, token } = await app.pairDevice("办公室 PC");

    const polling = fetch(`${app.runtime.url}/api/devices/commands?wait=5000`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pending = fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });

    const polled = await polling;
    assert.equal(polled.command.type, "files.list");
    assert.deepEqual(polled.command.payload, { path: "/tmp" });

    const accepted = await fetch(
      `${app.runtime.url}/api/devices/commands/${polled.command.id}/result`,
      {
        method: "POST",
        headers: app.deviceHeaders(token),
        body: JSON.stringify({ ok: true, result: { path: "/tmp", entries: [{ name: "a", type: "file" }] } }),
      },
    );
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).accepted, true);

    const settled = await pending;
    assert.equal(settled.status, 200);
    assert.deepEqual((await settled.json()).result.entries, [{ name: "a", type: "file" }]);
  } finally {
    await app.close();
  }
});

test("the command endpoints enforce device and admin roles", async () => {
  const app = await boot();
  try {
    const { device, token } = await app.pairDevice("前台 Mac");

    const anonymous = await fetch(`${app.runtime.url}/api/devices/commands?wait=1000`);
    assert.equal(anonymous.status, 401);

    const badToken = await fetch(`${app.runtime.url}/api/devices/commands?wait=1000`, {
      headers: { authorization: "Bearer not-a-real-device-token-value" },
    });
    assert.equal(badToken.status, 401);

    const memberDenied = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.member,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    assert.equal(memberDenied.status, 403);

    const unknown = await fetch(`${app.runtime.url}/api/devices/dev-000000000000/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    assert.equal(unknown.status, 404);

    const badType = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "process.spawn", path: "/tmp" }),
    });
    assert.equal(badType.status, 400);

    const badPath = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "tmp\nrm -rf" }),
    });
    assert.equal(badPath.status, 400);

    const crossDevice = await fetch(
      `${app.runtime.url}/api/devices/commands/cmd_deadbeefdeadbeef/result`,
      {
        method: "POST",
        headers: app.deviceHeaders(token),
        body: JSON.stringify({ ok: true, result: {} }),
      },
    );
    assert.equal(crossDevice.status, 202);
    assert.equal((await crossDevice.json()).accepted, false);
  } finally {
    await app.close();
  }
});

test("an unresponsive desk times out and a full queue answers 429", async () => {
  const app = await boot();
  try {
    const { device } = await app.pairDevice("无人值守 PC");

    const started = Date.now();
    const timedOut = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    assert.equal(timedOut.status, 504);
    assert.match((await timedOut.json()).error, /没有在限定时间内响应/u);
    assert.ok(Date.now() - started >= 900);

    // Fill the queue behind the caller's back; each entry expires with its
    // own timeout, so the test does not leak timers.
    const queued = [];
    for (let index = 0; index < 20; index += 1) {
      const entry = app.channel.enqueue({ deviceId: device.id, type: "files.list", payload: { path: "/tmp" } });
      entry.wait.catch(() => {});
      queued.push(entry.wait);
    }
    const busy = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    assert.equal(busy.status, 429);
    await Promise.allSettled(queued);
  } finally {
    await app.close();
  }
});

test("every privileged command leaves an audit entry, including refusals", async () => {
  const app = await boot();
  try {
    const { device, token } = await app.pairDevice("审计工作站");

    const refused = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.member,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    assert.equal(refused.status, 403);

    const invalid = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "process.spawn", path: "/tmp" }),
    });
    assert.equal(invalid.status, 400);

    const polling = fetch(`${app.runtime.url}/api/devices/commands?wait=5000`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pending = fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.list", path: "/tmp" }),
    });
    const polled = await polling;
    await fetch(`${app.runtime.url}/api/devices/commands/${polled.command.id}/result`, {
      method: "POST",
      headers: app.deviceHeaders(token),
      body: JSON.stringify({ ok: true, result: { entries: [] } }),
    });
    assert.equal((await pending).status, 200);

    const timedOut = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.read", path: "/tmp/a.txt" }),
    });
    assert.equal(timedOut.status, 504);

    const memberRead = await fetch(`${app.runtime.url}/api/audit`, { headers: { cookie: app.member.cookie } });
    assert.equal(memberRead.status, 403);

    const read = await fetch(`${app.runtime.url}/api/audit?limit=10`, { headers: { cookie: app.admin.cookie } });
    assert.equal(read.status, 200);
    const trail = await read.json();
    assert.deepEqual(trail.entries.map((entry) => entry.outcome), ["error", "ok", "denied", "denied"]);
    assert.equal(trail.entries[0].action, "device.command");
    assert.equal(trail.entries[1].detail, "files.list /tmp");
    for (const entry of trail.entries) assert.equal(entry.target, device.id);
    assert.equal(trail.entries[1].actorName, "admin@example.test");
    assert.equal(trail.entries[2].actorName, "admin@example.test");
    assert.equal(trail.entries[3].actorName, "member@example.test");
    assert.equal(JSON.stringify(trail).includes(token), false);

    const badLimit = await fetch(`${app.runtime.url}/api/audit?limit=0`, { headers: { cookie: app.admin.cookie } });
    assert.equal(badLimit.status, 400);
  } finally {
    await app.close();
  }
});

test("write commands carry their text and refuse oversized or missing content", async () => {
  const app = await boot();
  try {
    const { device, token } = await app.pairDevice("写入工作站");

    const missing = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.write", path: "/tmp/a.txt" }),
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /缺少写入内容/u);

    const oversized = await fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.write", path: "/tmp/a.txt", content: "x".repeat(256 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /超过 256 KB/u);

    const polling = fetch(`${app.runtime.url}/api/devices/commands?wait=5000`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pending = fetch(`${app.runtime.url}/api/devices/${device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.write", path: "/tmp/a.txt", content: "写入了\n" }),
    });
    const polled = await polling;
    assert.equal(polled.command.type, "files.write");
    assert.deepEqual(polled.command.payload, { path: "/tmp/a.txt", content: "写入了\n" });

    await fetch(`${app.runtime.url}/api/devices/commands/${polled.command.id}/result`, {
      method: "POST",
      headers: app.deviceHeaders(token),
      body: JSON.stringify({ ok: true, result: { path: "/tmp/a.txt", size: 10 } }),
    });
    const settled = await pending;
    assert.equal(settled.status, 200);
    assert.equal((await settled.json()).result.size, 10);

    const trail = await (await fetch(`${app.runtime.url}/api/audit?limit=5`, {
      headers: { cookie: app.admin.cookie },
    })).json();
    assert.equal(trail.entries[0].detail, "files.write /tmp/a.txt");
    assert.equal(trail.entries[0].outcome, "ok");
  } finally {
    await app.close();
  }
});

test("a result from another device never settles someone else's command", async () => {
  const app = await boot();
  try {
    const owner = await app.pairDevice("设计部 Mac");
    const other = await app.pairDevice("测试机");

    const pending = fetch(`${app.runtime.url}/api/devices/${owner.device.id}/commands`, {
      method: "POST",
      headers: app.admin,
      body: JSON.stringify({ type: "files.read", path: "/tmp/a.txt" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const polled = await (await fetch(`${app.runtime.url}/api/devices/commands?wait=1000`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })).json();
    assert.ok(polled.command, "the owning device should receive the command");

    const spoofed = await fetch(
      `${app.runtime.url}/api/devices/commands/${polled.command.id}/result`,
      {
        method: "POST",
        headers: app.deviceHeaders(other.token),
        body: JSON.stringify({ ok: true, result: { text: "leaked" } }),
      },
    );
    assert.equal(spoofed.status, 202);
    assert.equal((await spoofed.json()).accepted, false);

    const settled = await pending;
    assert.equal(settled.status, 504);
  } finally {
    await app.close();
  }
});
