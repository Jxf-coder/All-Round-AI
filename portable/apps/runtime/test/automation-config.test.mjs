import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_CONFIG_VERSION,
  createAutomationConfigStore,
  mergeAutomationParams,
} from "../src/automation-config.mjs";

async function withStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-automation-config-"));
  try {
    const file = path.join(root, "automation-config.json");
    await callback({ file, store: await createAutomationConfigStore(file), root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepted params are remembered per project and survive a restart", async () => {
  await withStore(async ({ file, store }) => {
    await store.save("project-a", "script-draft", {
      draft: { topic: "售后响应", audience: "boss", durationSec: 45 },
    });
    await store.save("project-a", "topic-pack", { topics: { count: 3 } });
    await store.save("project-b", "script-draft", { draft: { topic: "交付周期" } });

    assert.deepEqual(await store.get("project-a", "script-draft"), {
      draft: { topic: "售后响应", audience: "boss", durationSec: 45 },
    });
    assert.deepEqual(Object.keys(await store.list("project-a")).sort(), ["script-draft", "topic-pack"]);
    const listedB = await store.list("project-b");
    assert.deepEqual(listedB["script-draft"].params, { draft: { topic: "交付周期" } });
    assert.equal(isIsoTimestamp(listedB["script-draft"].updatedAt), true);

    const reopened = await createAutomationConfigStore(file);
    assert.equal((await reopened.get("project-a", "script-draft")).draft.topic, "售后响应");
    assert.equal(await reopened.get("project-a", "missing"), null);
    assert.equal(await reopened.get("missing", "script-draft"), null);
  });
});

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

test("a partial request keeps the saved values and only overrides what it sends", () => {
  const merged = mergeAutomationParams(
    { draft: { topic: "售后响应", audience: "boss" }, review: { note: "保留" } },
    { draft: { topic: "交付周期" } },
  );
  assert.deepEqual(merged, {
    draft: { topic: "交付周期", audience: "boss" },
    review: { note: "保留" },
  });
  assert.deepEqual(mergeAutomationParams(null, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(mergeAutomationParams({ a: { b: 1 } }, null), { a: { b: 1 } });
  assert.deepEqual(mergeAutomationParams({}, {}), {});
});

test("invalid params and a damaged document fail closed", async () => {
  await withStore(async ({ file, store }) => {
    await assert.rejects(store.save("project-a", "pipeline", { step: [] }), /参数格式无效/u);
    await assert.rejects(store.save("project-a", "pipeline", { step: { value: Number.NaN } }), /参数值无效/u);
    await assert.rejects(
      store.save("project-a", "pipeline", { step: { value: "x".repeat(8_001) } }),
      /参数值无效/u,
    );
    await assert.rejects(store.save("", "pipeline", {}), /project id/u);
    await assert.rejects(store.save("project-a", "", {}), /pipeline id/u);

    await writeFile(file, JSON.stringify({
      version: AUTOMATION_CONFIG_VERSION,
      projects: [{ projectId: "project-a", pipelines: { broken: { params: "nope", updatedAt: "x" } } }],
    }), "utf8");
    await assert.rejects(store.get("project-a", "broken"), /invalid pipeline|unsupported or damaged/u);
  });
});

test("the newest configs are kept when a project exceeds the pipeline cap", async () => {
  await withStore(async ({ store }) => {
    for (let index = 0; index < 55; index += 1) {
      await store.save("project-a", `pipeline-${index}`, { step: { value: index } });
    }
    const configs = await store.list("project-a");
    assert.equal(Object.keys(configs).length, 50);
    assert.equal(configs["pipeline-54"].params.step.value, 54);
    assert.equal("pipeline-0" in configs, false);
  });
});
