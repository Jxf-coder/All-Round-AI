// ---------------------------------------------------------------------------
// AI provider registry.
//
// The workbench can switch engines per turn the same way the reference exposes
// a runtime switch (cursor / deepseek). Here an "engine" is simply a provider
// id, so adding a local or cloud provider later is a registration, not a UI
// change. Exactly one provider is the installation default; an unknown or
// missing engine resolves to it instead of failing the turn.
// ---------------------------------------------------------------------------

import { assertAiProvider } from "./provider.mjs";

export function createProviderRegistry(options = {}) {
  const providers = options.providers ?? [];
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError("At least one AI provider is required");
  }
  const byId = new Map();
  const order = [];
  for (const provider of providers) {
    assertAiProvider(provider);
    if (byId.has(provider.id)) {
      throw new TypeError(`Duplicate AI provider id: ${provider.id}`);
    }
    byId.set(provider.id, provider);
    order.push(provider.id);
  }
  const requested = typeof options.defaultId === "string" ? options.defaultId.trim() : "";
  const defaultId = byId.has(requested) ? requested : order[0];

  return Object.freeze({
    defaultId,
    list() {
      return order.map((id) => ({ id, label: byId.get(id).label }));
    },
    has(id) {
      return byId.has(id);
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    // Lenient on purpose: a stale client sending a retired engine keeps working
    // against the default instead of breaking the conversation.
    resolve(id) {
      const normalized = typeof id === "string" ? id.trim() : "";
      return byId.has(normalized) ? normalized : defaultId;
    },
  });
}
