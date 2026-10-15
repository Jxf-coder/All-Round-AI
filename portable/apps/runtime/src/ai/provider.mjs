// ---------------------------------------------------------------------------
// AI Provider contract. The workbench talks to AI through this interface only,
// never to a concrete implementation. This lets the runtime start on a full
// mock now and swap in a real Trae provider (subprocess / MCP / stdio / HTTP)
// once its programmable interface is pinned down, without breaking the UI.
//
// A provider object MUST implement:
//   id: string                  stable identifier ("mock", "trae", ...)
//   label: string               human-readable name
//   listModels() -> Promise<Model[]>
//   chat({ model, messages, signal }) -> Promise<ChatResult>
//   streamChat({ model, messages, signal }) -> AsyncIterable<StreamChunk>
//
// Message: { role: "system" | "user" | "assistant", content: string }
// Model:   { id, name }
// ChatResult: { id, content, model, finishReason }
// StreamChunk: { delta?: string, finishReason?: string }
// ---------------------------------------------------------------------------

const REQUIRED_METHODS = ["listModels", "chat", "streamChat"];
const ROLES = new Set(["system", "user", "assistant"]);

export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError("messages must be a non-empty array");
  }
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError("Each message must be an object");
    }
    const role = ROLES.has(message.role) ? message.role : null;
    if (!role) {
      throw new TypeError("Message role must be system, user, or assistant");
    }
    return {
      role,
      content: typeof message.content === "string" ? message.content : String(message.content ?? ""),
    };
  });
}

export function assertAiProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new TypeError("AI provider must be an object");
  }
  if (typeof provider.id !== "string" || !provider.id.trim()) {
    throw new TypeError("AI provider must declare a non-empty id");
  }
  if (typeof provider.label !== "string" || !provider.label.trim()) {
    throw new TypeError("AI provider must declare a non-empty label");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`AI provider must implement ${method}()`);
    }
  }
  return provider;
}

export function assertNotAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("AI request was cancelled");
    error.name = "AbortError";
    throw error;
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      rejectAbort();
    };
    function rejectAbort() {
      const error = new Error("AI request was cancelled");
      error.name = "AbortError";
      reject(error);
    }
    function cleanup() {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}