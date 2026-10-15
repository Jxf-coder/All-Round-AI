import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigStore, generateMasterKey } from "../src/config-store.mjs";

async function withStore(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-config-"));
  const filePath = path.join(root, "config.json");
  try {
    await run({ filePath, store: await createConfigStore(filePath, options) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("plain values round-trip and persist atomically", async () => {
  await withStore(async ({ filePath, store }) => {
    assert.equal(await store.get("theme"), undefined);
    await store.set("theme", "dark");
    await store.set("locale", "zh-CN");
    assert.equal(await store.get("theme"), "dark");
    assert.equal(await store.get("locale"), "zh-CN");
    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(document.version, 1);
    assert.equal(document.values.theme, "dark");
  });
});

test("secrets are encrypted at rest and decrypt back", async () => {
  const masterKey = generateMasterKey();
  await withStore(async ({ filePath, store }) => {
    await store.setSecret("model.apiKey", "sk-super-secret-value");
    assert.equal(await store.getSecret("model.apiKey"), "sk-super-secret-value");

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /sk-super-secret-value/);
    const record = JSON.parse(raw).secrets["model.apiKey"];
    assert.equal(record.algorithm, "aes-256-gcm");
    assert.equal(typeof record.iv, "string");
    assert.equal(typeof record.tag, "string");
  }, { masterKey });
});

test("secrets survive a store restart with the same master key", async () => {
  const masterKey = generateMasterKey();
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-config-restart-"));
  const filePath = path.join(root, "config.json");
  try {
    await (await createConfigStore(filePath, { masterKey })).setSecret("token", "value-123");
    const reopened = await createConfigStore(filePath, { masterKey });
    assert.equal(await reopened.getSecret("token"), "value-123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret access without a master key fails loudly", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.setSecret("token", "value"), /master key is required/);
    await assert.rejects(store.getSecret("token"), /master key is required/);
  });
});

test("tampered ciphertext fails authentication instead of returning garbage", async () => {
  const masterKey = generateMasterKey();
  await withStore(async ({ filePath, store }) => {
    await store.setSecret("token", "value-123");
    const document = JSON.parse(await readFile(filePath, "utf8"));
    document.secrets.token.tag = Buffer.alloc(16, 0x7f).toString("base64url");
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const corrupted = await createConfigStore(filePath, { masterKey });
    await assert.rejects(corrupted.getSecret("token"));
  }, { masterKey });
});

test("master key formats are validated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-config-key-"));
  try {
    const filePath = path.join(root, "config.json");
    await assert.rejects(createConfigStore(filePath, { masterKey: "too-short" }), /Master key/);
    await assert.rejects(createConfigStore(filePath, { masterKey: Buffer.alloc(8) }), /32 bytes/);
    const base64Key = Buffer.alloc(32, 1).toString("base64");
    const store = await createConfigStore(filePath, { masterKey: base64Key });
    await store.setSecret("token", "abc");
    assert.equal(await store.getSecret("token"), "abc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteSecret removes the stored secret", async () => {
  const masterKey = generateMasterKey();
  await withStore(async ({ store }) => {
    await store.setSecret("token", "value");
    await store.deleteSecret("token");
    assert.equal(await store.getSecret("token"), undefined);
  }, { masterKey });
});
