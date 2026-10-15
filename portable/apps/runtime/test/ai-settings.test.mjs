import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigStore } from "../src/config-store.mjs";
import { loadOrCreateMasterKey } from "../src/master-key.mjs";
import { createMockAiProvider } from "../src/ai/mock-provider.mjs";
import { createAiSettings } from "../src/ai/settings.mjs";

async function withSettings(run, { provider = createMockAiProvider() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-ai-settings-"));
  try {
    const masterKey = await loadOrCreateMasterKey(path.join(root, "master-key.json"));
    const configStore = await createConfigStore(path.join(root, "settings.json"), { masterKey });
    await run({ root, configStore, settings: createAiSettings({ configStore, provider }), provider });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("settings default to the provider's first model and a masked credential state", async () => {
  await withSettings(async ({ settings }) => {
    const described = await settings.describe();
    assert.equal(described.provider, "mock");
    assert.equal(described.model, described.models[0].id);
    assert.equal(described.apiKeyConfigured, false);
    assert.equal(JSON.stringify(described).includes("apiKey\":"), false);
    assert.equal(await settings.currentModel(), described.model);
  });
});

test("a stored model is returned and survives a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-ai-settings-restart-"));
  try {
    const keyPath = path.join(root, "master-key.json");
    const configPath = path.join(root, "settings.json");
    const provider = createMockAiProvider();
    const first = createAiSettings({
      configStore: await createConfigStore(configPath, { masterKey: await loadOrCreateMasterKey(keyPath) }),
      provider,
    });
    const chosen = (await first.describe()).models.at(-1).id;
    await first.update({ model: chosen });

    const reopened = createAiSettings({
      configStore: await createConfigStore(configPath, { masterKey: await loadOrCreateMasterKey(keyPath) }),
      provider,
    });
    assert.equal((await reopened.describe()).model, chosen);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown models and malformed credentials are rejected", async () => {
  await withSettings(async ({ settings }) => {
    await assert.rejects(settings.update({ model: "no-such-model" }), (error) => error.status === 400);
    await assert.rejects(settings.update({ model: 7 }), (error) => error.status === 400);
    await assert.rejects(settings.update({ apiKey: 42 }), (error) => error.status === 400);
    await assert.rejects(settings.update({ apiKey: "x".repeat(4097) }), (error) => error.status === 400);
  });
});

test("a provider credential is encrypted at rest, never returned, and clearable", async () => {
  await withSettings(async ({ root, settings }) => {
    const secret = "sk-live-value-that-must-not-leak";
    const afterSet = await settings.update({ apiKey: secret });
    assert.equal(afterSet.apiKeyConfigured, true);
    assert.equal(JSON.stringify(afterSet).includes(secret), false);

    const raw = await readFile(path.join(root, "settings.json"), "utf8");
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.match(raw, /aes-256-gcm/);

    const masterKeyRaw = await readFile(path.join(root, "master-key.json"), "utf8");
    assert.doesNotMatch(masterKeyRaw, new RegExp(secret));

    // Clearing removes the record without leaving the ciphertext behind.
    const afterClear = await settings.update({ apiKey: null });
    assert.equal(afterClear.apiKeyConfigured, false);
    assert.doesNotMatch(await readFile(path.join(root, "settings.json"), "utf8"), /aes-256-gcm/);
  });
});

test("the master key is created once and reused afterwards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-master-key-"));
  const keyPath = path.join(root, "nested", "master-key.json");
  try {
    const first = await loadOrCreateMasterKey(keyPath);
    assert.match(first, /^[0-9a-f]{64}$/i);
    assert.equal(await loadOrCreateMasterKey(keyPath), first);
    if (process.platform !== "win32") {
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    }

    await writeFile(keyPath, JSON.stringify({ version: 1, key: "not-hex" }), "utf8");
    await assert.rejects(loadOrCreateMasterKey(keyPath), /master key file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
