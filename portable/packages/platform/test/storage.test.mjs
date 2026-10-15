import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJsonFileStore } from "../src/storage.mjs";

async function withTempStore(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-storage-"));
  const filePath = path.join(root, "nested", "store.json");
  try {
    await run({ root, filePath, store: createJsonFileStore(filePath, options) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const COUNTER_DOCUMENT = { initial: () => ({ version: 1, items: [] }) };

test("a missing file yields the initial document without creating it", async () => {
  await withTempStore(async ({ filePath, store }) => {
    assert.deepEqual(await store.read(), { version: 1, items: [] });
    await assert.rejects(readFile(filePath, "utf8"), (error) => error.code === "ENOENT");
  }, COUNTER_DOCUMENT);
});

test("update persists the document and returns the mutator result", async () => {
  await withTempStore(async ({ filePath, store }) => {
    const result = await store.update((document) => {
      document.items.push("first");
      return document.items.length;
    });
    assert.equal(result, 1);
    assert.deepEqual(await store.read(), { version: 1, items: ["first"] });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { version: 1, items: ["first"] });
  }, COUNTER_DOCUMENT);
});

test("concurrent updates are serialised without losing writes", async () => {
  await withTempStore(async ({ store }) => {
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      store.update((document) => {
        document.items.push(index);
      })));
    const { items } = await store.read();
    assert.equal(items.length, 25);
    assert.deepEqual([...items].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
  }, COUNTER_DOCUMENT);
});

test("damaged JSON fails closed instead of silently resetting", async () => {
  await withTempStore(async ({ filePath, store }) => {
    await store.update((document) => {
      document.items.push("kept");
    });
    await writeFile(filePath, "{ not json", "utf8");
    await assert.rejects(store.read());
    await assert.rejects(store.update(() => {}));
    assert.equal(await readFile(filePath, "utf8"), "{ not json");
  }, COUNTER_DOCUMENT);
});

test("a failing validator or mutator aborts the write", async () => {
  const validate = (value) => {
    if (value.version !== 1) throw new Error("unsupported document");
    return value;
  };

  await withTempStore(async ({ filePath, store }) => {
    await assert.rejects(
      store.update(() => {
        throw new Error("mutator failed");
      }),
      /mutator failed/,
    );
    await assert.rejects(readFile(filePath, "utf8"), (error) => error.code === "ENOENT");
  }, {
    initial: () => ({ version: 1, items: [] }),
    validate,
  });

  await withTempStore(async ({ filePath, store }) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 2 }), "utf8");
    await assert.rejects(store.read(), /unsupported document/);
  }, {
    initial: () => ({ version: 1 }),
    validate,
  });
});

test("writes leave no temporary files behind and restrict permissions", async () => {
  await withTempStore(async ({ filePath, store }) => {
    await store.update((document) => {
      document.items.push("only");
    });
    assert.deepEqual(await readdir(path.dirname(filePath)), ["store.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
    }
  }, COUNTER_DOCUMENT);
});

test("store construction validates its inputs", async () => {
  const absolutePath = path.join(os.tmpdir(), "allround-storage-unused.json");
  assert.throws(() => createJsonFileStore("relative.json", COUNTER_DOCUMENT), /absolute store path/);
  assert.throws(() => createJsonFileStore(absolutePath), /initial document factory/);
  assert.throws(
    () => createJsonFileStore(absolutePath, { initial: () => ({}), validate: "nope" }),
    /validation must be a function/,
  );
  const store = createJsonFileStore(absolutePath, COUNTER_DOCUMENT);
  await assert.rejects(store.update("not a function"), TypeError);
});
