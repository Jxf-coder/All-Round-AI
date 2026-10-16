import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTurnManager } from "../src/ai/turns.mjs";

async function withManager(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "allround-turns-"));
  try {
    const filePath = path.join(directory, "chat-turns.json");
    await run(createTurnManager({ filePath, ...options }), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a turn is persisted as running and exposes no internals", async () => {
  await withManager(async (manager) => {
    const turn = await manager.begin({
      ownerId: "u1",
      conversationId: "c1",
      projectId: "p1",
      clientTurnId: "turn-a",
    });
    assert.equal(turn.status, "running");
    assert.equal(turn.clientTurnId, "turn-a");
    assert.equal(turn.conversationId, "c1");
    assert.equal(turn.projectId, "p1");
    assert.equal(turn.seq, 0);
    assert.equal(turn.text, "");
    assert.equal("controller" in turn, false);
    assert.equal("listeners" in turn, false);

    // The record outlives the process: a fresh manager reads it back.
    const replayed = createTurnManager({ filePath: manager.path });
    assert.equal((await replayed.latestFor("u1", "c1")).status, "running");
    assert.equal(await replayed.latestFor("u1", "other"), null);
  });
});

test("deltas accumulate in order, are sequenced, and replay to a subscriber", async () => {
  await withManager(async (manager) => {
    const turn = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    manager.append(turn.id, { delta: "你" });
    manager.append(turn.id, { delta: "好" });

    const seen = [];
    manager.subscribe(turn.id, (event) => seen.push(event), { after: 0 });
    assert.deepEqual(seen.map((event) => event.seq), [1, 2]);
    assert.equal((await manager.latestFor("u1", "c1")).text, "你好");

    // `after` skips what the client already rendered.
    const later = [];
    manager.subscribe(turn.id, (event) => later.push(event), { after: 1 });
    assert.deepEqual(later.map((event) => event.seq), [2]);
  });
});

test("finishing a turn marks it terminal, notifies followers, and stops accepting deltas", async () => {
  await withManager(async (manager) => {
    const turn = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    manager.append(turn.id, { delta: "部分" });
    const events = [];
    manager.subscribe(turn.id, (event) => events.push(event), { after: 1 });

    const finished = await manager.finish(turn.id, { status: "done" });
    assert.equal(finished.status, "done");
    assert.equal(finished.text, "部分");
    assert.deepEqual(events.map((event) => event.done === true), [true]);
    assert.equal(manager.statusOf(turn.id), "done");

    // A delta that arrives after the terminal event cannot reopen the turn.
    assert.equal(manager.append(turn.id, { delta: "迟到" }), null);
    assert.equal((await manager.latestFor("u1", "c1")).text, "部分");

    // A subscriber attaching later still receives the terminal event from the replay.
    const late = [];
    manager.subscribe(turn.id, (event) => late.push(event), { after: 0 });
    assert.deepEqual(late.map((event) => event.seq), [1, 2]);

    // And the terminal state is on disk for the next process.
    const replayed = createTurnManager({ filePath: manager.path });
    const stored = await replayed.latestFor("u1", "c1");
    assert.equal(stored.status, "done");
    assert.equal(stored.text, "部分");
  });
});

test("cancelling a running turn aborts its signal and is observable", async () => {
  await withManager(async (manager) => {
    const turn = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    const signal = manager.signalFor(turn.id);
    assert.equal(signal.aborted, false);
    assert.equal(manager.cancel(turn.id), true);
    assert.equal(signal.aborted, true);
    assert.equal(manager.isCancelled(turn.id), true);
    // Cancelling twice, or after the turn ended, reports no change.
    assert.equal(manager.cancel(turn.id), true);
    await manager.finish(turn.id, { status: "cancelled" });
    assert.equal(manager.cancel(turn.id), false);
  });
});

test("starting a turn replaces the one already running in the same conversation", async () => {
  await withManager(async (manager) => {
    const first = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    const firstSignal = manager.signalFor(first.id);
    const second = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    assert.notEqual(first.id, second.id);
    assert.equal(firstSignal.aborted, true, "the replaced turn must be stopped");
    assert.equal(manager.statusOf(second.id), "running");
    // A different conversation keeps its own turn running.
    const other = await manager.begin({ ownerId: "u1", conversationId: "c2" });
    assert.equal(manager.statusOf(second.id), "running");
    assert.equal(manager.statusOf(other.id), "running");
  });
});

test("a resent clientTurnId finds the turn it already started", async () => {
  await withManager(async (manager) => {
    const turn = await manager.begin({ ownerId: "u1", conversationId: "c1", clientTurnId: "same" });
    const found = await manager.findByClientTurnId({ ownerId: "u1", conversationId: "c1", clientTurnId: "same" });
    assert.equal(found?.id, turn.id);

    // Terminal turns are found from disk too, and scoping still applies.
    await manager.finish(turn.id, { status: "done" });
    const replayed = createTurnManager({ filePath: manager.path });
    assert.equal(
      (await replayed.findByClientTurnId({ ownerId: "u1", conversationId: "c1", clientTurnId: "same" }))?.id,
      turn.id,
    );
    assert.equal(
      await replayed.findByClientTurnId({ ownerId: "u2", conversationId: "c1", clientTurnId: "same" }),
      null,
    );
    assert.equal(
      await replayed.findByClientTurnId({ ownerId: "u1", conversationId: "c1", clientTurnId: null }),
      null,
    );
  });
});

test("recovery closes turns that were running when the process stopped", async () => {
  await withManager(async (manager) => {
    const running = await manager.begin({ ownerId: "u1", conversationId: "c1" });
    const finished = await manager.begin({ ownerId: "u1", conversationId: "c2" });
    manager.append(finished.id, { delta: "完整" });
    await manager.finish(finished.id, { status: "done" });

    const restarted = createTurnManager({ filePath: manager.path });
    assert.equal(await restarted.recover(), 1);
    const interrupted = await restarted.latestFor("u1", "c1");
    assert.equal(interrupted.id, running.id);
    assert.equal(interrupted.status, "error");
    assert.match(interrupted.error, /重启/);
    // A completed turn is untouched, and recovery is idempotent.
    assert.equal((await restarted.latestFor("u1", "c2")).status, "done");
    assert.equal(await restarted.recover(), 0);
  });
});

test("the persisted log is bounded to the most recent turns", async () => {
  await withManager(async (manager, filePath) => {
    for (const conversationId of ["c1", "c2", "c3"]) {
      const turn = await manager.begin({ ownerId: "u1", conversationId });
      await manager.finish(turn.id, { status: "done" });
    }
    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(document.turns.length, 2);
    assert.equal(document.turns.some((turn) => turn.conversationId === "c1"), false);
    assert.equal(document.turns.at(-1).conversationId, "c3");
  }, { maxTurns: 2 });
});

test("a corrupted turn log fails closed instead of silently dropping history", async () => {
  await withManager(async (manager, filePath) => {
    await manager.begin({ ownerId: "u1", conversationId: "c1" });
    await writeFile(filePath, "{ not json", "utf8");
    await assert.rejects(
      () => manager.begin({ ownerId: "u1", conversationId: "c1" }),
      SyntaxError,
    );
    const damaged = createTurnManager({ filePath });
    await assert.rejects(() => damaged.recover());
  });
});
