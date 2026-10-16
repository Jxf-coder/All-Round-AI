import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  chatModelLabel,
  describeEfforts,
  effortLabel,
  isEffort,
  normalizeEffort,
  suggestEffort,
} from "../src/ai/effort.mjs";

test("effort levels match the reference set and carry Chinese labels", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["low", "medium", "high", "xhigh"]);
  assert.equal(EFFORT_LEVELS.includes(DEFAULT_EFFORT), true);
  const described = describeEfforts();
  assert.equal(described.length, 4);
  for (const effort of described) {
    assert.equal(typeof effort.id, "string");
    assert.equal(typeof effort.label, "string");
    assert.equal(typeof effort.zh, "string");
    assert.equal(typeof effort.hint, "string");
  }
  // A copy is returned so callers cannot mutate the frozen source.
  described[0].zh = "mutated";
  assert.equal(describeEfforts()[0].zh, "低");
});

test("unknown or malformed effort values fall back instead of propagating", () => {
  assert.equal(isEffort("high"), true);
  assert.equal(isEffort("ultra"), false);
  assert.equal(isEffort(undefined), false);
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("  xhigh  "), "xhigh");
  assert.equal(normalizeEffort("ultra"), DEFAULT_EFFORT);
  assert.equal(normalizeEffort(null), DEFAULT_EFFORT);
  assert.equal(normalizeEffort("", "low"), "low");
  assert.equal(effortLabel("xhigh"), "极高");
  assert.equal(effortLabel("unknown"), "中");
});

test("effort is suggested from the question itself", () => {
  assert.equal(suggestEffort("你好"), "low");
  assert.equal(suggestEffort("今天天气不错"), "low");
  // A longer but ordinary request stays in the middle.
  assert.equal(suggestEffort("帮我把这几天的会议记录整理一下，然后按主题归类汇总到一处，方便我后面查看"), DEFAULT_EFFORT);
  // Multi-step or clearly analytical asks get more thinking.
  assert.equal(suggestEffort("帮我分析一下整个架构设计方案并给出对比评估"), "high");
  assert.equal(suggestEffort(`第一点\n第二点\n第三点\n第四点\n第五点\n第六点\n第七点`), "high");
  assert.equal(suggestEffort("长".repeat(300)), "high");
  assert.equal(suggestEffort(""), DEFAULT_EFFORT);
  assert.equal(suggestEffort(undefined), DEFAULT_EFFORT);
});

test("the composer label carries model, effort and Fast mode", () => {
  assert.equal(chatModelLabel("Mock Pro", { effort: "high", fast: false }), "Mock Pro · 高");
  assert.equal(chatModelLabel("Mock Pro", { effort: "low", fast: true }), "Mock Pro · 低 · Fast");
  // A missing model and effort still produces a usable label.
  assert.equal(chatModelLabel("", {}), "选择模型 · 中");
});
