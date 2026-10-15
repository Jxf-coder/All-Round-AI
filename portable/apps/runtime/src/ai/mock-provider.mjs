import { assertAiProvider, assertNotAborted, normalizeMessages, sleep } from "./provider.mjs";

const MOCK_MODELS = [
  { id: "mock-tiny", name: "Mock Tiny" },
  { id: "mock-pro", name: "Mock Pro" },
];

function buildReply(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const question = lastUser?.content?.trim() ?? "";
  return question
    ? `这是「All Round AI 工作台」的演示回复：${question}`
    : "这是「All Round AI 工作台」的演示回复。";
}

// The mock streams in small chunks with a short pause so the workbench can be
// exercised the way a real provider behaves: tokens appear progressively and a
// reply can actually be stopped mid-flight. Tests override these when they want
// instantaneous or slower output.
export function createMockAiProvider(options = {}) {
  const delayMs = options.delayMs ?? 0;
  const streamChunkSize = options.chunkSize ?? 3;
  const streamDelayMs = options.streamDelayMs ?? 20;

  const provider = {
    id: "mock",
    label: "Mock（本地演示）",
    async listModels() {
      return MOCK_MODELS.map((model) => ({ ...model }));
    },
    async chat({ model = "mock-pro", messages, signal } = {}) {
      const normalized = normalizeMessages(messages);
      assertNotAborted(signal);
      if (delayMs > 0) await sleep(delayMs, signal);
      return {
        id: `mock-${Date.now().toString(36)}`,
        content: buildReply(normalized),
        model,
        finishReason: "stop",
      };
    },
    async *streamChat({ model = "mock-pro", messages, signal } = {}) {
      const normalized = normalizeMessages(messages);
      const content = buildReply(normalized);
      assertNotAborted(signal);
      for (let index = 0; index < content.length; index += streamChunkSize) {
        if (streamDelayMs > 0) await sleep(streamDelayMs, signal);
        assertNotAborted(signal);
        yield { delta: content.slice(index, index + streamChunkSize) };
      }
      yield { finishReason: "stop" };
    },
  };

  return assertAiProvider(provider);
}