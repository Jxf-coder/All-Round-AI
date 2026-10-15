// ---------------------------------------------------------------------------
// Conversation context windowing.
//
// A chat turn replays the stored conversation to the provider, but the stored
// conversation can grow far past what a model accepts. This module decides
// which messages are replayed: the newest turns win, the window stays inside a
// rough token budget, and the replayed slice always starts on a user turn so
// providers that require a leading user message keep working.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_MESSAGES = 20;
export const DEFAULT_TOKEN_BUDGET = 8_000;

// Heuristic, not a real tokenizer: no dependency is allowed and every provider
// counts differently. CJK text costs about one token per character; latin text
// averages roughly four characters per token. Over-estimating is the safe
// direction because it only shortens the window.
const CJK = /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u;

export function estimateTokens(content) {
  const text = typeof content === "string" ? content : "";
  if (!text) return 0;
  let cost = 0;
  for (const character of text) {
    cost += CJK.test(character) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(cost));
}

// Returns the newest messages that fit the budget, oldest first. The single
// newest message is always kept: dropping the question itself would leave
// nothing to answer, even when that one message exceeds the budget.
export function selectContextMessages(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const maxMessages = Number.isInteger(options.maxMessages) && options.maxMessages > 0
    ? options.maxMessages
    : DEFAULT_MAX_MESSAGES;
  const budget = Number.isFinite(options.budget) && options.budget > 0
    ? options.budget
    : DEFAULT_TOKEN_BUDGET;

  const selected = [];
  let cost = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message.content !== "string") continue;
    const messageCost = estimateTokens(message.content);
    if (selected.length >= maxMessages) break;
    if (selected.length > 0 && cost + messageCost > budget) break;
    selected.unshift({ role: message.role, content: message.content });
    cost += messageCost;
  }
  // A window that begins mid-exchange (an answer without its question) reads as
  // a malformed conversation, so leading assistant turns are dropped.
  while (selected.length > 1 && selected[0].role === "assistant") selected.shift();
  return selected;
}
