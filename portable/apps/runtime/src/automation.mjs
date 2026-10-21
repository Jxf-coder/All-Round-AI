import { randomBytes } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Automation pipelines.
//
// A pipeline is a frozen list of steps. A run is a persisted snapshot of the
// definition plus per-step state, so a later deployment cannot insert work into
// a run that already started. Two runners exist today:
//   app    -> a registered handler runs in-process and may produce artifacts
//   manual -> the run waits until an operator confirms the step
// Runs are bounded, survive restarts and are advanced one step at a time.
// ---------------------------------------------------------------------------

export const AUTOMATION_MAX_RUNS = 50;
export const AUTOMATION_LIST_LIMIT = 20;
export const RUN_STATUSES = Object.freeze(["running", "waiting_manual", "done", "failed", "cancelled"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "waiting_manual", "done", "failed", "skipped"]);
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const DONE_LIKE = new Set(["done", "skipped"]);
const MAX_STEP_ARTIFACTS = 20;
const MAX_STEP_LOGS = 50;
const MAX_LOG_LENGTH = 500;

export class AutomationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.status = status;
  }
}

export const AUTOMATION_PIPELINES = Object.freeze([
  {
    id: "knowledge-brief",
    name: "知识简报",
    desc: "读取当前项目的知识卡、缺口与回归结果，生成一份 Markdown 简报；人工确认后本次运行结束。",
    steps: [
      {
        id: "snapshot",
        name: "读取知识现状",
        desc: "把知识卡、缺口与统计落成一份快照，后续步骤只读这份快照。",
        runner: "app",
        action: "knowledge.snapshot",
        outputs: [{ slot: "snapshot", label: "知识快照" }],
      },
      {
        id: "brief",
        name: "生成简报",
        desc: "把快照整理成可读的 Markdown，列出确认过的知识、待确认项与未关闭的缺口。",
        runner: "app",
        action: "knowledge.brief",
        after: ["snapshot"],
        outputs: [{ slot: "brief", label: "知识简报" }],
      },
      {
        id: "review",
        name: "人工确认",
        desc: "打开简报核对内容，确认后结束本次运行。",
        runner: "manual",
        after: ["brief"],
        manualHint: "打开简报核对后点击「我做完了」",
      },
    ],
  },
]);

function fail(message) {
  throw new TypeError(message);
}

function validateStep(step, index, seen) {
  if (!step || typeof step !== "object") fail("步骤必须是对象");
  if (typeof step.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(step.id)) fail("步骤 id 无效");
  if (seen.has(step.id)) fail(`步骤 id 重复：${step.id}`);
  seen.add(step.id);
  if (typeof step.name !== "string" || step.name.trim() === "") fail(`步骤 ${step.id} 缺少名称`);
  if (step.runner !== "app" && step.runner !== "manual") fail(`步骤 ${step.id} 的 runner 无效`);
  if (step.runner === "app" && (typeof step.action !== "string" || step.action.trim() === "")) {
    fail(`步骤 ${step.id} 缺少 action`);
  }
  if (step.after !== undefined) {
    if (!Array.isArray(step.after) || step.after.some((id) => typeof id !== "string")) {
      fail(`步骤 ${step.id} 的 after 必须是字符串数组`);
    }
  }
  if (step.outputs !== undefined && (!Array.isArray(step.outputs)
    || step.outputs.some((output) => typeof output?.slot !== "string" || output.slot === ""))) {
    fail(`步骤 ${step.id} 的 outputs 无效`);
  }
  return index;
}

export function validatePipelines(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) fail("至少需要一条产线");
  const ids = new Set();
  for (const definition of pipelines) {
    if (typeof definition.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/u.test(definition.id)) {
      fail("产线 id 无效");
    }
    if (ids.has(definition.id)) fail(`产线 id 重复：${definition.id}`);
    ids.add(definition.id);
    if (typeof definition.name !== "string" || definition.name.trim() === "") fail(`产线 ${definition.id} 缺少名称`);
    if (!Array.isArray(definition.steps) || definition.steps.length === 0) fail(`产线 ${definition.id} 没有步骤`);
    const seen = new Set();
    definition.steps.forEach((step, index) => validateStep(step, index, seen));
    const positions = new Map(definition.steps.map((step, index) => [step.id, index]));
    for (const [index, step] of definition.steps.entries()) {
      for (const dependency of step.after ?? (index === 0 ? [] : [definition.steps[index - 1].id])) {
        if (!positions.has(dependency)) fail(`步骤 ${step.id} 依赖了不存在的步骤：${dependency}`);
        if (dependency === step.id) fail(`步骤 ${step.id} 不能依赖自己`);
        if (positions.get(dependency) > index) fail(`步骤 ${step.id} 依赖了排在后面的步骤：${dependency}`);
      }
    }
  }
  return pipelines;
}

validatePipelines(AUTOMATION_PIPELINES);

export function describePipeline(definition) {
  return {
    id: definition.id,
    name: definition.name,
    desc: definition.desc,
    steps: definition.steps.map((step) => ({
      id: step.id,
      name: step.name,
      desc: step.desc,
      runner: step.runner,
      ...(step.after ? { after: [...step.after] } : {}),
      ...(step.outputs ? { outputs: step.outputs.map((output) => ({ ...output })) } : {}),
      ...(step.manualHint ? { manualHint: step.manualHint } : {}),
    })),
  };
}

export function pipelineById(id, pipelines = AUTOMATION_PIPELINES) {
  return pipelines.find((definition) => definition.id === id) ?? null;
}

function isRunLike(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.pipelineId === "string"
    && typeof value.projectId === "string"
    && RUN_STATUSES.includes(value.status)
    && typeof value.steps === "object"
    && value.steps !== null
    && Object.values(value.steps).every((step) => Boolean(step)
      && typeof step === "object"
      && STEP_STATUSES.includes(step.status)
      && Array.isArray(step.artifacts)
      && Array.isArray(step.logs));
}

function emptyState() {
  return {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    artifacts: [],
    logs: [],
    error: null,
    completedBy: null,
    skipReason: null,
  };
}

export function createAutomationStore({ filePath, maxRuns = AUTOMATION_MAX_RUNS } = {}) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) throw new TypeError("运行记录上限必须是正整数");
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, runs: [] }),
    validate: (document) => {
      if (!document || typeof document !== "object" || document.version !== 1 || !Array.isArray(document.runs)) {
        throw new TypeError("自动化运行记录不可读或已损坏");
      }
      if (!document.runs.every(isRunLike)) throw new TypeError("自动化运行记录不可读或已损坏");
      return document;
    },
  });

  return Object.freeze({
    path: filePath,
    async list(limit = AUTOMATION_LIST_LIMIT) {
      const { runs } = await store.read();
      return runs.slice(-Math.max(1, limit)).reverse();
    },
    async read(id) {
      const { runs } = await store.read();
      return runs.find((run) => run.id === id) ?? null;
    },
    async save(run) {
      if (!isRunLike(run)) throw new TypeError("运行记录格式无效");
      return store.update((document) => {
        const index = document.runs.findIndex((entry) => entry.id === run.id);
        if (index >= 0) document.runs[index] = run;
        else document.runs.push(run);
        // Finished runs fall off first; an active run is never evicted unless
        // the cap itself is smaller than the number of active runs.
        while (document.runs.length > maxRuns) {
          const removable = document.runs.findIndex((entry) => TERMINAL.has(entry.status));
          document.runs.splice(removable >= 0 ? removable : 0, 1);
        }
        return run;
      });
    },
  });
}

function cleanArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((artifact) => artifact && typeof artifact === "object")
    .slice(0, MAX_STEP_ARTIFACTS)
    .map((artifact) => ({
      slot: String(artifact.slot ?? "").slice(0, 60),
      label: String(artifact.label ?? artifact.slot ?? "").slice(0, 120),
      path: String(artifact.path ?? "").slice(0, 4096),
      ...(Number.isSafeInteger(artifact.bytes) ? { bytes: artifact.bytes } : {}),
    }))
    .filter((artifact) => artifact.slot !== "" && artifact.path !== "");
}

function cleanLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs
    .filter((line) => typeof line === "string")
    .slice(0, MAX_STEP_LOGS)
    .map((line) => line.slice(0, MAX_LOG_LENGTH));
}

function dependenciesOf(definition, step, index) {
  return step.after ?? (index === 0 ? [] : [definition.steps[index - 1].id]);
}

function pickReady(run, definition) {
  for (const [index, step] of definition.steps.entries()) {
    const state = run.steps[step.id];
    if (!state || state.status !== "pending") continue;
    const ready = dependenciesOf(definition, step, index).every((id) => DONE_LIKE.has(run.steps[id]?.status));
    if (ready) return step;
  }
  return null;
}

function settle(run, definition) {
  const statuses = definition.steps.map((step) => run.steps[step.id]?.status);
  if (statuses.every((status) => DONE_LIKE.has(status))) {
    run.status = "done";
    run.currentStep = null;
    run.finishedAt = run.updatedAt;
  }
}

export function createAutomationEngine({
  store,
  handlers = {},
  pipelines = AUTOMATION_PIPELINES,
  now = () => new Date(),
  generateId = () => `run_${randomBytes(8).toString("hex")}`,
} = {}) {
  if (!store || typeof store.save !== "function" || typeof store.read !== "function") {
    throw new TypeError("自动化引擎需要运行记录存储");
  }
  validatePipelines(pipelines);
  const definitions = new Map(pipelines.map((definition) => [definition.id, definition]));
  const locks = new Map();
  const iso = () => now().toISOString();

  // One advance at a time per run: a double click or a boot resume must not
  // execute the same step twice.
  function withLock(id, task) {
    const previous = locks.get(id) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(task);
    locks.set(id, running);
    return running.finally(() => {
      if (locks.get(id) === running) locks.delete(id);
    });
  }

  async function advance(run, definition) {
    while (!TERMINAL.has(run.status)) {
      const step = pickReady(run, definition);
      if (!step) break;
      const state = run.steps[step.id];
      if (step.runner === "manual") {
        state.status = "waiting_manual";
        state.startedAt ??= iso();
        run.status = "waiting_manual";
        run.currentStep = step.id;
        run.updatedAt = iso();
        await store.save(run);
        return run;
      }
      state.status = "running";
      state.startedAt = iso();
      state.error = null;
      run.currentStep = step.id;
      run.updatedAt = iso();
      await store.save(run);
      try {
        const handler = handlers[step.action];
        if (typeof handler !== "function") throw new Error(`没有注册的步骤处理器：${step.action}`);
        const outcome = await handler({ run, step, definition }) ?? {};
        state.status = "done";
        state.finishedAt = iso();
        state.artifacts = cleanArtifacts(outcome.artifacts);
        state.logs = cleanLogs(outcome.logs);
      } catch (error) {
        state.status = "failed";
        state.finishedAt = iso();
        state.error = error.message || "步骤执行失败";
        run.status = "failed";
        run.error = `${step.name}：${state.error}`;
        run.finishedAt = state.finishedAt;
        run.currentStep = null;
        run.updatedAt = state.finishedAt;
        await store.save(run);
        return run;
      }
      run.updatedAt = iso();
      await store.save(run);
    }
    settle(run, definition);
    if (run.status === "running") {
      // Nothing is runnable and the run is not complete; failing loudly beats
      // leaving a run that would never move again.
      run.status = "failed";
      run.error = "步骤依赖无法满足";
      run.currentStep = null;
      run.finishedAt = iso();
      run.updatedAt = run.finishedAt;
    }
    await store.save(run);
    return run;
  }

  async function requireRun(id) {
    const run = await store.read(id);
    if (!run) throw new AutomationError("NOT_FOUND", "运行不存在", 404);
    const definition = definitions.get(run.pipelineId);
    if (!definition) throw new AutomationError("UNKNOWN_PIPELINE", "这条产线的定义已不存在", 409);
    return { run, definition };
  }

  return Object.freeze({
    async start({ pipelineId, projectId, actor = null } = {}) {
      const definition = definitions.get(pipelineId);
      if (!definition) throw new AutomationError("UNKNOWN_PIPELINE", "没有这条产线");
      if (typeof projectId !== "string" || projectId.trim() === "") {
        throw new AutomationError("BAD_PROJECT", "请先选择项目");
      }
      const at = iso();
      const run = {
        id: generateId(),
        pipelineId,
        projectId: projectId.trim(),
        status: "running",
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
        currentStep: null,
        startedBy: typeof actor === "string" ? actor.slice(0, 200) : null,
        definition: describePipeline(definition),
        steps: Object.fromEntries(definition.steps.map((step) => [step.id, emptyState()])),
        error: null,
      };
      await store.save(run);
      return withLock(run.id, () => advance(run, definition));
    },

    async completeManual({ runId, stepId, actor = null } = {}) {
      return withLock(runId, async () => {
        const { run, definition } = await requireRun(runId);
        if (run.status !== "waiting_manual") {
          throw new AutomationError("NOT_WAITING", "这次运行当前不在等待人工确认", 409);
        }
        const state = run.steps[stepId];
        if (!state || state.status !== "waiting_manual") {
          throw new AutomationError("BAD_STEP", "这个步骤不在等待人工确认", 409);
        }
        state.status = "done";
        state.finishedAt = iso();
        state.completedBy = typeof actor === "string" ? actor.slice(0, 200) : null;
        run.status = "running";
        run.currentStep = null;
        run.updatedAt = iso();
        await store.save(run);
        return advance(run, definition);
      });
    },

    async cancel({ runId } = {}) {
      return withLock(runId, async () => {
        const { run } = await requireRun(runId);
        if (TERMINAL.has(run.status)) {
          throw new AutomationError("FINISHED", "这次运行已经结束，不能取消", 409);
        }
        const at = iso();
        for (const state of Object.values(run.steps)) {
          if (["pending", "running", "waiting_manual"].includes(state.status)) {
            state.status = "skipped";
            state.finishedAt = at;
            state.skipReason = "运行已取消";
          }
        }
        run.status = "cancelled";
        run.currentStep = null;
        run.finishedAt = at;
        run.updatedAt = at;
        await store.save(run);
        return run;
      });
    },

    // Runs interrupted mid-step are re-driven after boot. Manual waits are
    // durable and stay exactly as they were.
    async resumeInterrupted() {
      const runs = await store.list(AUTOMATION_MAX_RUNS);
      let resumed = 0;
      let failed = 0;
      for (const run of runs) {
        if (run.status !== "running") continue;
        const definition = definitions.get(run.pipelineId);
        if (!definition) {
          run.status = "failed";
          run.error = "这条产线的定义已不存在";
          run.updatedAt = iso();
          run.finishedAt = run.updatedAt;
          await store.save(run);
          failed += 1;
          continue;
        }
        for (const state of Object.values(run.steps)) {
          if (state.status === "running") {
            state.status = "pending";
            state.startedAt = null;
            state.error = null;
          }
        }
        try {
          await withLock(run.id, () => advance(run, definition));
          resumed += 1;
        } catch {
          failed += 1;
        }
      }
      return { resumed, failed };
    },

    async read(runId) {
      return store.read(runId);
    },

    async list(limit = AUTOMATION_LIST_LIMIT) {
      return store.list(limit);
    },
  });
}
