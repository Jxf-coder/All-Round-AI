import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceChannel } from "../src/device-channel.mjs";

test("a command waits for the device and resolves with the reported result", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 5_000 });
  const pending = channel.enqueue({
    deviceId: "dev-aaaaaaaaaaaa",
    type: "files.list",
    payload: { path: "/tmp" },
  });
  assert.match(pending.id, /^cmd_[0-9a-f]{16}$/u);

  const command = await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 500 });
  assert.equal(command.id, pending.id);
  assert.equal(command.type, "files.list");
  assert.deepEqual(command.payload, { path: "/tmp" });

  assert.equal(
    channel.complete({
      deviceId: "dev-aaaaaaaaaaaa",
      commandId: command.id,
      ok: true,
      result: { entries: [{ name: "a.txt", type: "file" }] },
    }),
    true,
  );
  assert.deepEqual(await pending.wait, { entries: [{ name: "a.txt", type: "file" }] });
});

test("a long poll returns null when nothing arrives in time", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 5_000 });
  const started = Date.now();
  const command = await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 40 });
  assert.equal(command, null);
  assert.ok(Date.now() - started >= 30);
});

test("a queued command is delivered to whichever poll arrives next", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 5_000 });
  const first = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.read", payload: { path: "/a" } });
  const second = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", payload: { path: "/b" } });
  first.wait.catch(() => {});
  second.wait.catch(() => {});

  assert.equal((await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 })).id, first.id);
  assert.equal((await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 })).id, second.id);
  assert.equal(await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 }), null);
});

test("results only settle commands that belong to the same device", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 5_000 });
  const pending = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", payload: { path: "/" } });
  const command = await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 });

  assert.equal(
    channel.complete({ deviceId: "dev-bbbbbbbbbbbb", commandId: command.id, ok: true, result: {} }),
    false,
  );
  assert.equal(
    channel.complete({ deviceId: "dev-aaaaaaaaaaaa", commandId: "cmd-deadbeefdeadbeef", ok: true }),
    false,
  );

  channel.complete({ deviceId: "dev-aaaaaaaaaaaa", commandId: command.id, ok: true, result: { entries: [] } });
  assert.deepEqual(await pending.wait, { entries: [] });
});

test("a command the device never picks up times out and leaves the queue", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 1_000 });
  const pending = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", payload: { path: "/" } });
  await assert.rejects(pending.wait, (error) => error.code === "TIMEOUT" && /限定时间内响应/u.test(error.message));
  assert.equal(await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 }), null);
});

test("a failed command rejects the caller with the device error", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 5_000 });
  const pending = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.read", payload: { path: "/x" } });
  const command = await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 });
  channel.complete({
    deviceId: "dev-aaaaaaaaaaaa",
    commandId: command.id,
    ok: false,
    error: "路径不在允许访问的目录里",
  });
  await assert.rejects(pending.wait, (error) => error.code === "DEVICE_ERROR" && /不在允许访问/u.test(error.message));
});

test("a device queue is capped so one dead desk cannot grow without bound", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 1_000 });
  const pending = [];
  for (let index = 0; index < 20; index += 1) {
    const entry = channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", payload: { path: "/" } });
    entry.wait.catch(() => {});
    pending.push(entry);
  }
  assert.throws(
    () => channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", payload: { path: "/" } }),
    (error) => error.code === "BUSY",
  );
  // Another device still has its own independent queue.
  const other = channel.enqueue({ deviceId: "dev-bbbbbbbbbbbb", type: "files.list", payload: { path: "/" } });
  other.wait.catch(() => {});
  assert.ok(other.id);
  await Promise.allSettled(pending.map((entry) => entry.wait));
});

test("a per-command timeout can outlive the channel default", async () => {
  const channel = createDeviceChannel({ commandTtlMs: 1_000 });
  const pending = channel.enqueue({
    deviceId: "dev-aaaaaaaaaaaa",
    type: "process.run",
    payload: { command: "/bin/true" },
    ttlMs: 3_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const command = await channel.take({ deviceId: "dev-aaaaaaaaaaaa", waitMs: 10 });
  assert.equal(command.id, pending.id);
  channel.complete({ deviceId: "dev-aaaaaaaaaaaa", commandId: command.id, ok: true, result: { code: 0 } });
  assert.deepEqual(await pending.wait, { code: 0 });
});

test("invalid input is rejected before anything is queued", () => {
  const channel = createDeviceChannel({ commandTtlMs: 1_000 });
  assert.throws(() => channel.enqueue({ deviceId: "", type: "files.list" }), TypeError);
  assert.throws(() => channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "" }), TypeError);
  assert.throws(() => channel.enqueue({ deviceId: "dev-aaaaaaaaaaaa", type: "files.list", ttlMs: 10 }), TypeError);
  assert.throws(() => createDeviceChannel({ commandTtlMs: 10 }), TypeError);
});
