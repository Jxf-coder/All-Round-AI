import { assertAiProvider, assertNotAborted, normalizeMessages } from "./provider.mjs";

// ---------------------------------------------------------------------------
// DeepSeek provider.
//
// DeepSeek exposes an OpenAI-compatible chat completion API, so this stays a
// small adapter over fetch: no SDK, no streaming library. The key is resolved
// per request so a key saved in the settings screen takes effect without a
// restart, and it is never written to logs or error messages.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const CHAT_TIMEOUT_MS = 180_000;

export const DEEPSEEK_MODELS = Object.freeze([
  { id: "deepseek-chat", name: "DeepSeek V3（对话）" },
  { id: "deepseek-reasoner", name: "DeepSeek R1（推理）" },
]);

function normalizeBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("DeepSeek 地址必须是 http(s) 地址");
  }
  return url.toString().replace(/\/+$/u, "");
}

function statusMessage(status) {
  if (status === 401) return "DeepSeek 密钥无效或未授权";
  if (status === 402) return "DeepSeek 账户余额不足";
  if (status === 429) return "DeepSeek 请求过于频繁，请稍后再试";
  if (status >= 500) return "DeepSeek 服务暂时不可用";
  return `DeepSeek 返回 ${status}`;
}

function errorMessage(body, status) {
  const detail = typeof body?.error?.message === "string" ? body.error.message.trim() : "";
  const base = statusMessage(status);
  return detail ? `${base}：${detail}` : base;
}

export function createDeepseekProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required for the DeepSeek provider");
  }
  const keySource = options.apiKey;
  async function resolveKey() {
    const value = typeof keySource === "function" ? await keySource() : keySource;
    return typeof value === "string" ? value.trim() : "";
  }

  function signalFor(external, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  async function request({ model, messages, signal, stream }) {
    const normalized = normalizeMessages(messages);
    assertNotAborted(signal);
    if (typeof model !== "string" || !model.trim()) {
      throw new Error("没有可用的 DeepSeek 模型");
    }
    const key = await resolveKey();
    if (!key) {
      throw new Error("没有配置 DeepSeek API Key，请在设置页填写或在环境变量 ALLROUND_AI_DEEPSEEK_KEY 中提供");
    }
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: normalized, stream }),
        signal: signalFor(signal, CHAT_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      throw new Error(`连不上 DeepSeek（${baseUrl}）：${error.message || "连接失败"}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(errorMessage(body, response.status));
    }
    return response;
  }

  const provider = {
    id: "deepseek",
    label: "DeepSeek（云端）",
    // The catalogue is fixed and published by DeepSeek; listing it locally
    // avoids spending a request just to open the settings screen.
    async listModels() {
      return DEEPSEEK_MODELS.map((model) => ({ ...model }));
    },
    async chat({ model, messages, signal } = {}) {
      const response = await request({ model, messages, signal, stream: false });
      const body = await response.json().catch(() => null);
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("DeepSeek 没有返回内容");
      return {
        id: `deepseek-${Date.now().toString(36)}`,
        content,
        model,
        finishReason: body?.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      };
    },
    async *streamChat({ model, messages, signal } = {}) {
      const response = await request({ model, messages, signal, stream: true });
      if (!response.body) throw new Error("DeepSeek 没有返回流");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason = "stop";
      let finished = false;
      try {
        while (!finished) {
          assertNotAborted(signal);
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index !== -1 && !finished) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") {
                finished = true;
                break;
              }
              if (payload) {
                let chunk;
                try {
                  chunk = JSON.parse(payload);
                } catch {
                  throw new Error("DeepSeek 返回了无法解析的流");
                }
                if (typeof chunk.error?.message === "string" && chunk.error.message.trim()) {
                  throw new Error(chunk.error.message.trim());
                }
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) yield { delta };
                if (chunk.choices?.[0]?.finish_reason === "length") finishReason = "length";
              }
            }
            index = buffer.indexOf("\n");
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

export const DEEPSEEK_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
