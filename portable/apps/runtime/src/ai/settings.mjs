import { assertAiProvider } from "./provider.mjs";

const KEY_MODEL = "ai.model";
const KEY_API_KEY = "ai.apiKey";

function badRequest(message) {
  const error = new TypeError(message);
  error.status = 400;
  return error;
}

// ---------------------------------------------------------------------------
// AI settings are installation-wide: which model the workbench chats with, and
// the provider credential used once a real provider is wired in. The credential
// is written through the encrypting config store and is never read back into a
// response — callers only learn whether one is configured.
// ---------------------------------------------------------------------------

export function createAiSettings({ configStore, provider }) {
  if (!configStore || typeof configStore.get !== "function" || typeof configStore.setSecret !== "function") {
    throw new TypeError("An encrypting config store is required for AI settings");
  }
  assertAiProvider(provider);

  async function describe() {
    const models = await provider.listModels();
    const stored = await configStore.get(KEY_MODEL);
    const model = models.some((candidate) => candidate.id === stored) ? stored : models[0]?.id ?? null;
    let apiKeyConfigured = false;
    try {
      const secret = await configStore.getSecret(KEY_API_KEY);
      apiKeyConfigured = typeof secret === "string" && secret.length > 0;
    } catch {
      // An unreadable secret is reported as "not configured" rather than
      // failing the whole settings read.
      apiKeyConfigured = false;
    }
    return {
      provider: provider.id,
      providerLabel: provider.label,
      model,
      models: models.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      apiKeyConfigured,
    };
  }

  return Object.freeze({
    describe,
    async currentModel() {
      return (await describe()).model;
    },
    async update({ model, apiKey } = {}) {
      if (model !== undefined) {
        const models = await provider.listModels();
        if (typeof model !== "string" || !models.some((candidate) => candidate.id === model)) {
          throw badRequest("未知的模型");
        }
        await configStore.set(KEY_MODEL, model);
      }
      if (apiKey !== undefined) {
        if (apiKey === null || apiKey === "") {
          await configStore.deleteSecret(KEY_API_KEY);
        } else if (typeof apiKey === "string") {
          if (apiKey.length > 4096) throw badRequest("密钥长度超出限制");
          await configStore.setSecret(KEY_API_KEY, apiKey);
        } else {
          throw badRequest("apiKey 必须是字符串或 null");
        }
      }
      return describe();
    },
  });
}
