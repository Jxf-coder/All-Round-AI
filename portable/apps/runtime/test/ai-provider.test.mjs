import assert from "node:assert/strict";
import test from "node:test";

import { createMockAiProvider } from "../src/ai/mock-provider.mjs";
import { assertAiProvider, normalizeMessages } from "../src/ai/provider.mjs";

const MESSAGES = [{ role: "user", content: "帮我梳理今天的计划" }];

test("mock provider satisfies the AI provider contract", async () => {
  const provider = createMockAiProvider();
  assert.equal(provider.id, "mock");
  assert.equal(typeof provider.label, "string");
  const models = await provider.listModels();
  assert.equal(Array.isArray(models), true);
  assert.equal(models.length >= 1, true);
  assert.equal(typeof models[0].id, "string");
});

test("non-streaming chat echoes the user's question", async () => {
  const provider = createMockAiProvider();
  const result = await provider.chat({ model: "mock-pro", messages: MESSAGES });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.model, "mock-pro");
  assert.match(result.content, /帮我梳理今天的计划/);
  assert.equal(typeof result.id, "string");
});

test("streaming chat emits deltas that reassemble the full reply", async () => {
  const provider = createMockAiProvider({ chunkSize: 3 });
  let content = "";
  let finishReason = null;
  for await (const chunk of provider.streamChat({ messages: MESSAGES })) {
    if (chunk.delta) content += chunk.delta;
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }
  const expected = (await provider.chat({ messages: MESSAGES })).content;
  assert.equal(content, expected);
  assert.equal(finishReason, "stop");
});

test("chat rejects invalid message payloads", async () => {
  const provider = createMockAiProvider();
  await assert.rejects(provider.chat({ messages: [] }), TypeError);
  await assert.rejects(provider.chat({ messages: [{ role: "robot", content: "hi" }] }), TypeError);
  assert.deepEqual(normalizeMessages([{ role: "user", content: 42 }]), [{ role: "user", content: "42" }]);
});

test("an aborted request stops before producing output", async () => {
  const provider = createMockAiProvider({ delayMs: 50, streamDelayMs: 50 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.chat({ messages: MESSAGES, signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  await assert.rejects(async () => {
    for await (const chunk of provider.streamChat({ messages: MESSAGES, signal: controller.signal })) {
      void chunk;
    }
  }, (error) => error.name === "AbortError");
});

test("aborting mid-stream interrupts the generator", async () => {
  const provider = createMockAiProvider({ chunkSize: 2, streamDelayMs: 5 });
  const controller = new AbortController();
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of provider.streamChat({ messages: MESSAGES, signal: controller.signal })) {
      chunks.push(chunk);
      controller.abort();
    }
  }, (error) => error.name === "AbortError");
  assert.equal(chunks.length >= 1, true);
});

test("assertAiProvider rejects incomplete implementations", () => {
  assert.throws(() => assertAiProvider(null), TypeError);
  assert.throws(() => assertAiProvider({ id: "", label: "x" }), TypeError);
  assert.throws(
    () => assertAiProvider({ id: "x", label: "y", listModels: () => [], chat: () => {} }),
    /streamChat/,
  );
  assert.doesNotThrow(() => assertAiProvider(createMockAiProvider()));
});
