// ---------------------------------------------------------------------------
// Chat "thinking effort" and Fast mode.
//
// The reference workbench puts four effort levels next to the model picker and
// folds them into the model label ("… · High · Fast"): the composer always
// shows what will actually run. It picks a default from the page/skill the user
// is on; this runtime has no skill taxonomy yet, so the default is derived from
// the question itself and can always be overridden per turn.
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);

// Labels mirror the reference wording so the UI stays recognisable.
export const EFFORTS = Object.freeze([
  { id: "low", label: "Low", zh: "低", hint: "较低思考强度，回答更快" },
  { id: "medium", label: "Medium", zh: "中", hint: "中等思考强度（默认）" },
  { id: "high", label: "High", zh: "高", hint: "较高思考强度，适合复杂任务" },
  { id: "xhigh", label: "Extra High", zh: "极高", hint: "最高思考强度，需手动选择" },
]);

export const DEFAULT_EFFORT = "medium";

export function isEffort(value) {
  return EFFORT_LEVELS.includes(value);
}

// Unknown or missing values fall back to the default rather than propagating a
// bad level into the provider call.
export function normalizeEffort(value, fallback = DEFAULT_EFFORT) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isEffort(normalized) ? normalized : fallback;
}

export function effortLabel(value) {
  const normalized = normalizeEffort(value);
  return EFFORTS.find((effort) => effort.id === normalized).zh;
}

export function describeEfforts() {
  return EFFORTS.map((effort) => ({ ...effort }));
}

// A short greeting does not need deep thinking; a long or multi-step ask does.
export function suggestEffort(text) {
  const content = typeof text === "string" ? text.trim() : "";
  if (!content) return DEFAULT_EFFORT;
  const lines = content.split(/\n+/u).filter((line) => line.trim()).length;
  const complex = /分析|方案|设计|架构|规划|对比|评估|复盘|排查|重构|拆解|报告|调研/u.test(content);
  if (complex || content.length > 240 || lines > 6) return "high";
  if (content.length <= 24 && lines === 1) return "low";
  return DEFAULT_EFFORT;
}

// The label the composer shows: model, effort, and Fast mode all in one string.
export function chatModelLabel(modelName, { effort, fast } = {}) {
  const base = typeof modelName === "string" && modelName ? modelName : "选择模型";
  return [base, effortLabel(effort), fast ? "Fast" : null].filter(Boolean).join(" · ");
}
