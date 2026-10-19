import assert from "node:assert/strict";
import test from "node:test";

import { createProviderRegistry } from "../src/ai/registry.mjs";

function provider(id, label) {
  return {
    id,
    label,
    async listModels() { return [{ id: `${id}-model`, name: `${label} Model` }]; },
    async chat() { return { id, content: id, finishReason: "stop" }; },
    async *streamChat() {
      yield { delta: id };
      yield { finishReason: "stop" };
    },
  };
}

test("the registry lists engines in order and defaults to the first", () => {
  const registry = createProviderRegistry({
    providers: [provider("alpha", "Alpha"), provider("beta", "Beta")],
  });
  assert.equal(registry.defaultId, "alpha");
  assert.deepEqual(registry.list(), [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ]);
  assert.equal(registry.has("beta"), true);
  assert.equal(registry.has("gamma"), false);
  assert.equal(registry.get("beta").label, "Beta");
  assert.equal(registry.get("gamma"), null);
});

test("an explicit default is honoured and a stale one falls back", () => {
  const registry = createProviderRegistry({
    providers: [provider("alpha", "Alpha"), provider("beta", "Beta")],
    defaultId: "beta",
  });
  assert.equal(registry.defaultId, "beta");

  const stale = createProviderRegistry({
    providers: [provider("alpha", "Alpha")],
    defaultId: "retired",
  });
  assert.equal(stale.defaultId, "alpha");
});

test("unknown or missing engines resolve to the default instead of failing", () => {
  const registry = createProviderRegistry({ providers: [provider("alpha", "Alpha")] });
  assert.equal(registry.resolve("alpha"), "alpha");
  assert.equal(registry.resolve("retired"), "alpha");
  assert.equal(registry.resolve("  "), "alpha");
  assert.equal(registry.resolve(undefined), "alpha");
});

test("invalid provider lists are rejected up front", () => {
  assert.throws(() => createProviderRegistry({ providers: [] }), /At least one AI provider/);
  assert.throws(() => createProviderRegistry({}), /At least one AI provider/);
  assert.throws(
    () => createProviderRegistry({ providers: [provider("dup", "One"), provider("dup", "Two")] }),
    /Duplicate AI provider id/,
  );
  assert.throws(
    () => createProviderRegistry({ providers: [{ id: "broken", label: "Broken" }] }),
    /must implement/,
  );
});
