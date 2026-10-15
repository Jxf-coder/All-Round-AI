import { randomUUID } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Projects. The reference workbench organises everything under a three-level
// tree — a company root, the roles (岗位) under it, and the seats (子岗位) under
// each role — and scopes chats and knowledge by the selected project. This
// module keeps that model and its validation, but without the hiring/tenant
// layer, which has no portable equivalent yet.
// ---------------------------------------------------------------------------

export const DEFAULT_ROOT_NAME = "默认项目";

const PROJECT_TYPES = ["root", "child", "seat"];
const PROJECT_TYPE_SET = new Set(PROJECT_TYPES);
const MAX_NAME_LENGTH = 60;
const MAX_PROJECTS = 200;

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function clone(project) {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    parentId: project.parentId ?? null,
    slug: project.slug,
    createdAt: project.createdAt,
  };
}

// Mirrors the reference slug rule: a readable stem plus a short id suffix so
// two projects with the same name still get distinct directory names.
function slugify(name, id) {
  const base = String(name)
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/gu, "")
    .replace(/\s+/gu, "-")
    .slice(0, 40);
  const short = id.replace(/-/gu, "").slice(0, 6);
  return `${base || "project"}-${short}`;
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("All Round AI project store format is unsupported or damaged");
  }
  for (const project of value.projects) {
    if (!project || typeof project !== "object"
      || typeof project.id !== "string"
      || typeof project.name !== "string"
      || !PROJECT_TYPE_SET.has(project.type)
      || typeof project.slug !== "string"
      || !isIsoTimestamp(project.createdAt)
      || (project.parentId !== undefined && project.parentId !== null && typeof project.parentId !== "string")) {
      throw new Error("All Round AI project store contains an invalid project");
    }
  }
  return value;
}

function normalizeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("名称不能为空");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  return name;
}

export async function createProjectStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, projects: [] }),
    validate: validateDocument,
  });

  // The switcher always needs something to show, so the first read seeds the
  // company root. Later reads only touch the file when it is still empty.
  async function readAll() {
    const document = await store.read();
    if (document.projects.some((project) => project.type === "root")) {
      return document.projects.map(clone);
    }
    return store.update((current) => {
      if (!current.projects.some((project) => project.type === "root")) {
        const id = randomUUID();
        current.projects.push({
          id,
          name: DEFAULT_ROOT_NAME,
          type: "root",
          parentId: null,
          slug: slugify(DEFAULT_ROOT_NAME, id),
          createdAt: new Date().toISOString(),
        });
      }
      return current.projects.map(clone);
    });
  }

  return Object.freeze({
    async list() {
      return readAll();
    },
    // The tree the switcher renders: one entry per company root, each with its
    // roles and each role with its seats.
    async tree() {
      const projects = await readAll();
      return projects
        .filter((project) => project.type === "root")
        .map((root) => ({
          root,
          children: projects
            .filter((project) => project.type === "child" && project.parentId === root.id)
            .map((child) => ({
              ...child,
              seats: projects.filter((project) => project.type === "seat" && project.parentId === child.id),
            })),
        }));
    },
    async get(id) {
      if (typeof id !== "string" || !id) return null;
      const projects = await readAll();
      return projects.find((project) => project.id === id) ?? null;
    },
    async defaultRootId() {
      const projects = await readAll();
      return projects.find((project) => project.type === "root")?.id ?? null;
    },
    async create({ name, type = "root", parentId = null } = {}) {
      const projectName = normalizeName(name);
      if (!PROJECT_TYPE_SET.has(type)) throw new Error("项目类型无效");
      if (type === "child" && !parentId) throw new Error("创建岗位需要所属公司 parentId");
      if (type === "seat" && !parentId) throw new Error("创建子岗位需要所属岗位 parentId");

      return store.update((document) => {
        if (document.projects.length >= MAX_PROJECTS) {
          throw new Error("项目数量已达上限，请先清理旧项目");
        }
        if (type === "child" || type === "seat") {
          const expectedParent = type === "child" ? "root" : "child";
          const parent = document.projects.find((item) => item.id === parentId);
          if (!parent || parent.type !== expectedParent) {
            throw new Error(
              type === "child" ? "只能在公司根项目下创建岗位" : "只能在岗位下创建子岗位",
            );
          }
        }
        const id = randomUUID();
        const project = {
          id,
          name: projectName,
          type,
          parentId: type === "root" ? null : parentId,
          slug: slugify(projectName, id),
          createdAt: new Date().toISOString(),
        };
        document.projects.push(project);
        return clone(project);
      });
    },
  });
}
