import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_PIPELINES,
  createAutomationEngine,
  createAutomationStore,
  describePipeline,
  validatePipelines,
} from "../src/automation.mjs";

const DEMO = {
  id: "demo",
  name: "演示产线",
  desc: "测试用",
  steps: [
    { id: "a", name: "第一步", desc: "", runner: "app", action: "test.a", outputs: [{ slot: "out", label: "结果" }] },
    { id: "b", name: "第二步", desc: "", runner: "app", action: "test.b", after: ["a"] },
    { id: "c", name: "人工确认", desc: "", runner: "manual", after: ["b"], manualHint: "看完点完成" },
  ],
};

const AUTO = {
  id: "auto",
  name: "全自动",
  desc: "测试用",
  steps: [
    { id: "a", name: "第一步", desc: "", runner: "app", action: "test.a" },
    { id: "b", name: "第二步", desc: "", runner: "app", action: "test.b" },
  ],
};

async function withStore(callback, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-automation-"));
  try {
    const store = createAutomationStore({ filePath: path.join(root, "runs.json"), ...options });
    await callback({ store, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("pipeline definitions reject duplicates, unknown dependencies and cycles", () => {
  assert.equal(validatePipelines(AUTOMATION_PIPELINES), AUTOMATION_PIPELINES);
  assert.equal(AUTOMATION_PIPELINES[0].id, "knowledge-brief");
  const described = describePipeline(AUTOMATION_PIPELINES[0]);
  assert.deepEqual(described.steps.map((step) => step.runner), ["app", "app", "manual"]);
  assert.equal(JSON.stringify(described).includes("knowledge.snapshot"), false);

  assert.throws(() => validatePipelines([DEMO, DEMO]), /产线 id 重复/u);
  assert.throws(
    () => validatePipelines([{ ...DEMO, steps: [{ ...DEMO.steps[0], after: ["missing"] }] }]),
    /依赖了不存在的步骤/u,
  );
  assert.throws(
    () => validatePipelines([{
      ...DEMO,
      steps: [
        { id: "a", name: "A", runner: "app", action: "x", after: ["b"] },
        { id: "b", name: "B", runner: "app", action: "y", after: ["a"] },
      ],
    }]),
    /排在后面的步骤/u,
  );
  assert.throws(
    () => validatePipelines([{ ...DEMO, steps: [{ ...DEMO.steps[0], action: "" }] }]),
    /缺少 action/u,
  );
});

test("a run executes app steps, waits at the manual step and finishes after confirmation", async () => {
  await withStore(async ({ store }) => {
    const calls = [];
    const engine = createAutomationEngine({
      store,
      pipelines: [DEMO],
      handlers: {
        "test.a": async () => {
          calls.push("a");
          return { artifacts: [{ slot: "out", label: "结果", path: "/tmp/a.txt", bytes: 3 }], logs: ["a 完成"] };
        },
        "test.b": async () => {
          calls.push("b");
          return {};
        },
      },
    });

    const started = await engine.start({ pipelineId: "demo", projectId: "project-1", actor: "admin" });
    assert.equal(started.status, "waiting_manual");
    assert.equal(started.currentStep, "c");
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(started.steps.a.status, "done");
    assert.deepEqual(started.steps.a.artifacts, [{ slot: "out", label: "结果", path: "/tmp/a.txt", bytes: 3 }]);
    assert.equal(started.steps.c.status, "waiting_manual");
    assert.equal(started.steps.c.completedBy, null);

    const finished = await engine.completeManual({ runId: started.id, stepId: "c", actor: "member@example.test" });
    assert.equal(finished.status, "done");
    assert.equal(finished.steps.c.status, "done");
    assert.equal(finished.steps.c.completedBy, "member@example.test");
    assert.ok(finished.finishedAt);

    // A second confirmation on a finished run is refused instead of silently
    // re-running it.
    await assert.rejects(
      engine.completeManual({ runId: started.id, stepId: "c", actor: "again" }),
      (error) => error.code === "NOT_WAITING" && error.status === 409,
    );

    // The state survives a new store instance pointed at the same file.
    const reloaded = createAutomationStore({ filePath: store.path });
    const persisted = await reloaded.read(started.id);
    assert.equal(persisted.status, "done");
    assert.equal(persisted.steps.a.artifacts.length, 1);
  });
});

test("a failing step stops the run and keeps what earlier steps produced", async () => {
  await withStore(async ({ store }) => {
    const engine = createAutomationEngine({
      store,
      pipelines: [AUTO],
      handlers: {
        "test.a": async () => ({ artifacts: [{ slot: "out", label: "结果", path: "/tmp/a.txt" }] }),
        "test.b": async () => {
          throw new Error("演示失败");
        },
      },
    });
    const run = await engine.start({ pipelineId: "auto", projectId: "project-1" });
    assert.equal(run.status, "failed");
    assert.match(run.error, /第二步：演示失败/u);
    assert.equal(run.steps.a.status, "done");
    assert.equal(run.steps.b.status, "failed");
    assert.equal(run.steps.a.artifacts.length, 1);
    assert.ok(run.finishedAt);
  });
});

test("an unregistered handler fails the run instead of skipping the step", async () => {
  await withStore(async ({ store }) => {
    const engine = createAutomationEngine({ store, pipelines: [AUTO], handlers: {} });
    const run = await engine.start({ pipelineId: "auto", projectId: "project-1" });
    assert.equal(run.status, "failed");
    assert.match(run.error, /没有注册的步骤处理器/u);
  });
});

test("cancelling skips the remaining steps and is terminal", async () => {
  await withStore(async ({ store }) => {
    const engine = createAutomationEngine({
      store,
      pipelines: [DEMO],
      handlers: { "test.a": async () => ({}), "test.b": async () => ({}) },
    });
    const started = await engine.start({ pipelineId: "demo", projectId: "project-1" });
    const cancelled = await engine.cancel({ runId: started.id });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.steps.c.status, "skipped");
    assert.equal(cancelled.steps.c.skipReason, "运行已取消");
    assert.ok(cancelled.finishedAt);
    await assert.rejects(
      engine.cancel({ runId: started.id }),
      (error) => error.code === "FINISHED" && error.status === 409,
    );
  });
});

test("an interrupted run is re-driven on the next boot exactly once per step", async () => {
  await withStore(async ({ store }) => {
    const calls = [];
    const engine = createAutomationEngine({
      store,
      pipelines: [AUTO],
      handlers: {
        "test.a": async () => {
          calls.push("a");
          return {};
        },
        "test.b": async () => {
          calls.push("b");
          return {};
        },
      },
    });
    const at = new Date("2026-10-21T00:00:00.000Z").toISOString();
    await store.save({
      id: "run_interrupted",
      pipelineId: "auto",
      projectId: "project-1",
      status: "running",
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      currentStep: "b",
      startedBy: null,
      definition: describePipeline(AUTO),
      steps: {
        a: { status: "done", startedAt: at, finishedAt: at, artifacts: [], logs: [], error: null, completedBy: null, skipReason: null },
        b: { status: "running", startedAt: at, finishedAt: null, artifacts: [], logs: [], error: null, completedBy: null, skipReason: null },
      },
      error: null,
    });

    const summary = await engine.resumeInterrupted();
    assert.deepEqual(summary, { resumed: 1, failed: 0 });
    assert.deepEqual(calls, ["b"]);
    const run = await engine.read("run_interrupted");
    assert.equal(run.status, "done");
    assert.equal(run.steps.b.status, "done");

    // A second boot has nothing left to do.
    assert.deepEqual(await engine.resumeInterrupted(), { resumed: 0, failed: 0 });
    assert.deepEqual(calls, ["b"]);
  });
});

test("manual waits survive a restart and are not re-executed", async () => {
  await withStore(async ({ store }) => {
    const engine = createAutomationEngine({
      store,
      pipelines: [DEMO],
      handlers: { "test.a": async () => ({}), "test.b": async () => ({}) },
    });
    await engine.start({ pipelineId: "demo", projectId: "project-1" });
    const summary = await engine.resumeInterrupted();
    assert.deepEqual(summary, { resumed: 0, failed: 0 });
    const runs = await engine.list();
    assert.equal(runs[0].status, "waiting_manual");
  });
});

test("runs are bounded and damaged files fail closed", async () => {
  await withStore(async ({ store, root }) => {
    const engine = createAutomationEngine({
      store,
      pipelines: [AUTO],
      handlers: { "test.a": async () => ({}), "test.b": async () => ({}) },
    });
    for (let index = 0; index < 3; index += 1) {
      await engine.start({ pipelineId: "auto", projectId: `project-${index}` });
    }
    const runs = await engine.list(10);
    assert.equal(runs.length, 2);

    await writeFile(path.join(root, "runs.json"), "{broken", "utf8");
    await assert.rejects(engine.list(), /JSON|property|position/u);
    assert.equal(await readFile(path.join(root, "runs.json"), "utf8"), "{broken");
  }, { maxRuns: 2 });
});

test("starting validates the pipeline and the project", async () => {
  await withStore(async ({ store }) => {
    const engine = createAutomationEngine({ store, pipelines: [DEMO], handlers: {} });
    await assert.rejects(
      engine.start({ pipelineId: "nope", projectId: "p" }),
      (error) => error.code === "UNKNOWN_PIPELINE",
    );
    await assert.rejects(
      engine.start({ pipelineId: "demo", projectId: "  " }),
      (error) => error.code === "BAD_PROJECT",
    );
    await assert.rejects(engine.cancel({ runId: "run_missing" }), (error) => error.status === 404);
  });
});
