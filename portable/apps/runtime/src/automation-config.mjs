import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Per-project pipeline params. The reference keeps a PipelineConfig per project
// in the vault; here only the last accepted params are remembered, so reopening
// a pipeline does not ask the operator to type the same topic again. Run
// snapshots stay authoritative: a stored config never rewrites a finished run.
// ---------------------------------------------------------------------------

export const AUTOMATION_CONFIG_VERSION = 1;
const MAX_PROJECTS = 100;
const MAX_PIPELINES = 50;
const MAX_STEPS = 20;
const MAX_KEYS = 40;
const MAX_TEXT = 8_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isParamValue(value) {
  return typeof value === "string"
    ? value.length <= MAX_TEXT
    : typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value));
}

function validateParams(params, label) {
  if (!isPlainObject(params)) throw new TypeError(`${label}参数格式无效`);
  const steps = Object.keys(params);
  if (steps.length > MAX_STEPS) throw new TypeError(`${label}参数步骤过多`);
  for (const stepId of steps) {
    const values = params[stepId];
    if (!isPlainObject(values)) throw new TypeError(`${label}参数格式无效`);
    const keys = Object.keys(values);
    if (keys.length > MAX_KEYS) throw new TypeError(`${label}参数过多`);
    for (const key of keys) {
      if (!isParamValue(values[key])) throw new TypeError(`${label}参数值无效`);
    }
  }
}

function assertDocument(value) {
  if (!value || value.version !== AUTOMATION_CONFIG_VERSION || !Array.isArray(value.projects)) {
    throw new Error("All Round AI pipeline config is unsupported or damaged");
  }
  for (const project of value.projects) {
    if (!project || typeof project.projectId !== "string" || !project.projectId
      || !isPlainObject(project.pipelines)) {
      throw new Error("All Round AI pipeline config contains an invalid project");
    }
    for (const [pipelineId, entry] of Object.entries(project.pipelines)) {
      if (!pipelineId || !entry || typeof entry !== "object"
        || typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt))) {
        throw new Error("All Round AI pipeline config contains an invalid pipeline");
      }
      validateParams(entry.params, "Pipeline config ");
    }
  }
  return value;
}

// Request params win key by key, so a caller can change just the topic and
// keep the stored audience and duration.
export function mergeAutomationParams(saved, input) {
  const merged = {};
  if (isPlainObject(saved)) {
    for (const [stepId, values] of Object.entries(saved)) {
      merged[stepId] = { ...values };
    }
  }
  if (isPlainObject(input)) {
    for (const [stepId, values] of Object.entries(input)) {
      merged[stepId] = { ...(merged[stepId] ?? {}), ...values };
    }
  }
  return merged;
}

export async function createAutomationConfigStore(filePath) {
  if (typeof filePath !== "string") throw new TypeError("A pipeline config path is required");
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: AUTOMATION_CONFIG_VERSION, projects: [] }),
    validate: assertDocument,
  });

  function projectOf(document, projectId, create) {
    let project = document.projects.find((item) => item.projectId === projectId);
    if (!project && create) {
      project = { projectId, pipelines: {} };
      document.projects.push(project);
    }
    return project ?? null;
  }

  return Object.freeze({
    path: store.path,
    async get(projectId, pipelineId) {
      const project = projectOf(await store.read(), projectId, false);
      return project?.pipelines?.[pipelineId]?.params ?? null;
    },
    async list(projectId) {
      if (typeof projectId !== "string" || !projectId) throw new TypeError("A project id is required");
      const project = projectOf(await store.read(), projectId, false);
      const result = {};
      for (const [pipelineId, entry] of Object.entries(project?.pipelines ?? {})) {
        result[pipelineId] = { params: entry.params, updatedAt: entry.updatedAt };
      }
      return result;
    },
    async save(projectId, pipelineId, params) {
      if (typeof projectId !== "string" || !projectId) throw new TypeError("A project id is required");
      if (typeof pipelineId !== "string" || !pipelineId) throw new TypeError("A pipeline id is required");
      validateParams(params, "Pipeline config ");
      const at = new Date().toISOString();
      return store.update((document) => {
        const project = projectOf(document, projectId, true);
        project.pipelines[pipelineId] = { params, updatedAt: at };
        const ids = Object.keys(project.pipelines);
        if (ids.length > MAX_PIPELINES) {
          const oldest = ids
            .sort((left, right) => project.pipelines[left].updatedAt.localeCompare(project.pipelines[right].updatedAt))
            .slice(0, ids.length - MAX_PIPELINES);
          for (const id of oldest) delete project.pipelines[id];
        }
        if (document.projects.length > MAX_PROJECTS) {
          const sorted = [...document.projects].sort((left, right) => {
            const leftAt = Object.values(left.pipelines).map((entry) => entry.updatedAt).sort().at(-1) ?? "";
            const rightAt = Object.values(right.pipelines).map((entry) => entry.updatedAt).sort().at(-1) ?? "";
            return leftAt.localeCompare(rightAt);
          });
          for (const stale of sorted.slice(0, document.projects.length - MAX_PROJECTS)) {
            const index = document.projects.indexOf(stale);
            if (index >= 0) document.projects.splice(index, 1);
          }
        }
        return { params, updatedAt: at };
      });
    },
  });
}
