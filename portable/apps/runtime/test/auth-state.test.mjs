import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuthStateStore } from "../src/auth-state.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-auth-state-"));
  const filePath = path.join(root, "auth-state.json");
  try {
    await run({ filePath, store: createAuthStateStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SESSION = {
  user: { id: "u-1", name: "Test User", role: "member", mustChangePassword: false },
  context: { credentialVersion: 2 },
  expiresAt: 1_700_000_000_000,
};

test("a missing file loads as empty state", async () => {
  await withStore(async ({ store }) => {
    const state = await store.load();
    assert.equal(state.sessions.size, 0);
    assert.equal(state.loginFailures.size, 0);
  });
});

test("sessions and throttling survive a save/load cycle", async () => {
  await withStore(async ({ store }) => {
    await store.save({
      sessions: new Map([["session-1", SESSION]]),
      loginFailures: new Map([["throttle-key", [1_000, 2_000]]]),
    });
    const state = await store.load();
    assert.deepEqual([...state.sessions.keys()], ["session-1"]);
    assert.deepEqual(state.sessions.get("session-1"), SESSION);
    assert.deepEqual(state.loginFailures.get("throttle-key"), [1_000, 2_000]);
  });
});

test("only the credential version of a provider context reaches the disk", async () => {
  await withStore(async ({ filePath, store }) => {
    await store.save({
      sessions: new Map([["session-1", {
        ...SESSION,
        // A provider may put anything in its context; none of it may be stored.
        context: { credentialVersion: 3, accessToken: "provider-token-value", secret: "provider-secret" },
      }]]),
      loginFailures: new Map(),
    });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /provider-token-value|provider-secret/);
    assert.equal((await store.load()).sessions.get("session-1").context.credentialVersion, 3);
    assert.deepEqual(Object.keys((await store.load()).sessions.get("session-1").context), ["credentialVersion"]);
  });
});

test("a session without a credential version loads with a null context", async () => {
  await withStore(async ({ store }) => {
    await store.save({
      sessions: new Map([["session-1", { user: SESSION.user, context: null, expiresAt: 10 }]]),
      loginFailures: new Map(),
    });
    assert.equal((await store.load()).sessions.get("session-1").context, null);
  });
});

test("damaged or malformed state fails closed instead of resetting", async () => {
  await withStore(async ({ filePath, store }) => {
    await writeFile(filePath, "{ not json", "utf8");
    await assert.rejects(store.load());
  });

  const invalidDocuments = [
    { version: 2, sessions: [], loginFailures: [] },
    { version: 1, sessions: "nope", loginFailures: [] },
    { version: 1, sessions: [{ id: "a", user: { name: "x" }, expiresAt: "later" }], loginFailures: [] },
    { version: 1, sessions: [{ id: "a", user: {}, expiresAt: 1 }], loginFailures: [] },
    { version: 1, sessions: [{ id: "a", user: { name: "x" }, expiresAt: 1 }, { id: "a", user: { name: "y" }, expiresAt: 2 }], loginFailures: [] },
    { version: 1, sessions: [], loginFailures: [{ key: "k", timestamps: ["soon"] }] },
    { version: 1, sessions: [], loginFailures: [{ key: "k", timestamps: [1] }, { key: "k", timestamps: [2] }] },
  ];
  for (const document of invalidDocuments) {
    await withStore(async ({ filePath: target, store: target_store }) => {
      await writeFile(target, JSON.stringify(document), "utf8");
      await assert.rejects(target_store.load());
    });
  }
});
