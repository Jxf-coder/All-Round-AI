import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  selectContextMessages,
} from "../src/ai/context.mjs";

const turn = (role, content) => ({ id: `${role}-${content}`, role, content, createdAt: "2026-01-01T00:00:00.000Z" });

test("estimateTokens is dependency-free but directionally sane", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("中文"), 2);
  // Non-string input is treated as empty rather than throwing.
  assert.equal(estimateTokens(undefined), 0);
});

test("selectContextMessages replays the stored conversation oldest first", () => {
  const messages = [
    turn("user", "第一问"),
    turn("assistant", "第一答"),
    turn("user", "第二问"),
  ];
  assert.deepEqual(selectContextMessages(messages), [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
});

test("selectContextMessages keeps the newest messages when the window is full", () => {
  const messages = [];
  for (let index = 0; index < DEFAULT_MAX_MESSAGES + 6; index += 1) {
    messages.push(turn(index % 2 === 0 ? "user" : "assistant", `第 ${index} 条`));
  }
  messages.push(turn("user", "最新一问"));
  const selected = selectContextMessages(messages);
  assert.equal(selected.length <= DEFAULT_MAX_MESSAGES, true);
  assert.deepEqual(selected.at(-1), { role: "user", content: "最新一问" });
});

test("selectContextMessages drops older turns that exceed the token budget", () => {
  const messages = [
    turn("user", "x".repeat(4_000)),
    turn("assistant", "第一答"),
    turn("user", "上一问"),
    turn("assistant", "上一答"),
    turn("user", "当前一问"),
  ];
  // The 4,000-character opening turn alone costs ~1,000 tokens, so a 10-token
  // budget keeps only the three newest turns.
  const selected = selectContextMessages(messages, { budget: 10 });
  assert.deepEqual(selected, [
    { role: "user", content: "上一问" },
    { role: "assistant", content: "上一答" },
    { role: "user", content: "当前一问" },
  ]);
});

test("selectContextMessages always keeps the newest message, even alone over budget", () => {
  const selected = selectContextMessages([turn("user", "中".repeat(500))], { budget: 5 });
  assert.deepEqual(selected, [{ role: "user", content: "中".repeat(500) }]);
});

test("selectContextMessages never starts the window on an assistant turn", () => {
  const messages = [
    turn("user", "更早的问题"),
    turn("assistant", "更早的回答"),
    turn("user", "上一问"),
    turn("assistant", "上一答"),
    turn("user", "当前一问"),
  ];
  // A four-message window would begin with "更早的回答"; the leading answer is
  // dropped so the provider receives a well-formed exchange.
  assert.deepEqual(selectContextMessages(messages, { maxMessages: 4 }), [
    { role: "user", content: "上一问" },
    { role: "assistant", content: "上一答" },
    { role: "user", content: "当前一问" },
  ]);
  // A window that can only hold an answer and the question keeps the question.
  assert.deepEqual(selectContextMessages(messages, { maxMessages: 2 }), [
    { role: "user", content: "当前一问" },
  ]);
});

test("selectContextMessages rejects a non-array and defaults its limits", () => {
  assert.throws(() => selectContextMessages("not messages"), TypeError);
  assert.equal(DEFAULT_TOKEN_BUDGET > 0, true);
  // Invalid limits fall back to the defaults instead of breaking the turn.
  const messages = [turn("user", "问"), turn("assistant", "答"), turn("user", "再问")];
  assert.deepEqual(selectContextMessages(messages, { maxMessages: 0, budget: -1 }), [
    { role: "user", content: "问" },
    { role: "assistant", content: "答" },
    { role: "user", content: "再问" },
  ]);
});
