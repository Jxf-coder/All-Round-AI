import { assertAiProvider, assertNotAborted, normalizeMessages } from "./provider.mjs";

// ---------------------------------------------------------------------------
// Local model provider (Ollama). The runtime stays dependency-free: this talks
// to the Ollama HTTP API with the built-in fetch. Nothing leaves the machine
// unless the configured base URL points elsewhere.
//
// Ollama is opt-in. The runtime registers this provider only when a base URL is
// configured, so a fresh install still starts with the mock and never waits on
// a service that is not installed.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LIST_TIMEOUT_MS = 5_000;
const CHAT_TIMEOUT_MS = 120_000;

function normalizeBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Ollama 地址必须是 http(s) 地址");
  }
  return url.toString().replace(/\/+$/u, "");
}

function modelId(entry) {
  const value = entry?.name ?? entry?.model;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function modelLabel(id) {
  return id.replace(/:latest$/u, "");
}

function errorMessage(detail, fallback) {
  if (detail && typeof detail === "object" && typeof detail.error === "string" && detail.error.trim()) {
    return detail.error.trim();
  }
  return fallback;
}

export function createOllamaProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required for the Ollama provider");
  }

  function signalFor(external, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  const provider = {
    id: "ollama",
    label: "Ollama（本地模型）",
    async listModels() {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/tags`, {
          method: "GET",
          signal: signalFor(undefined, LIST_TIMEOUT_MS),
        });
      } catch {
        // An unreachable local service is reported as "no models" rather than
        // breaking the settings screen. Sending a message will surface the
        // real connection error.
        return [];
      }
      if (!response.ok) return [];
      const body = await response.json().catch(() => null);
      const models = Array.isArray(body?.models) ? body.models : [];
      const seen = new Set();
      const result = [];
      for (const entry of models) {
        const id = modelId(entry);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, name: modelLabel(id) });
      }
      return result;
    },
    async chat({ model, messages, signal } = {}) {
      const normalized = normalizeMessages(messages);
      assertNotAborted(signal);
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("没有可用的 Ollama 模型，请先在 Ollama 里拉取模型");
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: normalized, stream: false }),
          signal: signalFor(signal, CHAT_TIMEOUT_MS),
        });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        throw new Error(`连不上 Ollama（${baseUrl}）：${error.message || "连接失败"}`);
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(errorMessage(body, `Ollama 返回 ${response.status}`));
      }
      const content = body?.message?.content;
      if (typeof content !== "string") {
        throw new Error(errorMessage(body, "Ollama 没有返回内容"));
      }
      return {
        id: `ollama-${Date.now().toString(36)}`,
        content,
        model,
        finishReason: body?.done_reason === "length" ? "length" : "stop",
      };
    },
    async *streamChat({ model, messages, signal } = {}) {
      const normalized = normalizeMessages(messages);
      assertNotAborted(signal);
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("没有可用的 Ollama 模型，请先在 Ollama 里拉取模型");
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: normalized, stream: true }),
          signal: signalFor(signal, CHAT_TIMEOUT_MS),
        });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        throw new Error(`连不上 Ollama（${baseUrl}）：${error.message || "连接失败"}`);
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(errorMessage(body, `Ollama 返回 ${response.status}`));
      }
      if (!response.body) throw new Error("Ollama 没有返回流");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason = "stop";
      try {
        while (true) {
          assertNotAborted(signal);
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) {
              let chunk;
              try {
                chunk = JSON.parse(line);
              } catch {
                throw new Error("Ollama 返回了无法解析的流");
              }
              if (typeof chunk.error === "string" && chunk.error.trim()) {
                throw new Error(chunk.error.trim());
              }
              if (typeof chunk.message?.content === "string" && chunk.message.content) {
                yield { delta: chunk.message.content };
              }
              if (chunk.done === true) {
                finishReason = chunk.done_reason === "length" ? "length" : "stop";
                yield { finishReason };
                return;
              }
            }
            index = buffer.indexOf("\n");
          }
        }
        const tail = buffer.trim();
        if (tail) {
          const chunk = JSON.parse(tail);
          if (typeof chunk.message?.content === "string" && chunk.message.content) {
            yield { delta: chunk.message.content };
          }
        }
        yield { finishReason };
      } finally {
        reader.releaseLock();
      }
    },
  };

  return assertAiProvider(provider);
}

export const OLLAMA_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
