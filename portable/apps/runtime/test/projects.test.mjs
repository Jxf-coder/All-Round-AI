import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectStore, DEFAULT_ROOT_NAME } from "../src/projects.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-projects-"));
  const filePath = path.join(root, "projects.json");
  try {
    await run({ filePath, store: await createProjectStore(filePath) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the first read seeds one company root and only once", async () => {
  await withStore(async ({ filePath, store }) => {
    const projects = await store.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].type, "root");
    assert.equal(projects[0].name, DEFAULT_ROOT_NAME);
    assert.equal(projects[0].parentId, null);
    assert.match(projects[0].slug, /-[0-9a-f]{6}$/u);
    assert.equal(await store.defaultRootId(), projects[0].id);

    // Re-reading must not add another root, and the file must contain exactly one.
    await store.list();
    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(document.version, 1);
    assert.equal(document.projects.filter((project) => project.type === "root").length, 1);
  });
});

test("roles and seats are created under their parent and nest in the tree", async () => {
  await withStore(async ({ store }) => {
    const rootId = await store.defaultRootId();
    const role = await store.create({ name: "新媒体运营", type: "child", parentId: rootId });
    assert.equal(role.type, "child");
    assert.equal(role.parentId, rootId);
    const seat = await store.create({ name: "短视频", type: "seat", parentId: role.id });
    assert.equal(seat.parentId, role.id);

    const [tree] = await store.tree();
    assert.equal(tree.root.id, rootId);
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].name, "新媒体运营");
    assert.deepEqual(tree.children[0].seats.map((item) => item.name), ["短视频"]);
    // A role created without a type defaults to a company root, like the reference.
    const secondRoot = await store.create({ name: "第二条业务线" });
    assert.equal(secondRoot.type, "root");
    assert.equal((await store.tree()).length, 2);
  });
});

test("project creation rejects invalid names, types and parents", async () => {
  await withStore(async ({ store }) => {
    const rootId = await store.defaultRootId();
    const role = await store.create({ name: "电商客服", type: "child", parentId: rootId });

    await assert.rejects(store.create({ name: "   " }), /名称不能为空/u);
    await assert.rejects(store.create({ name: undefined }), /名称不能为空/u);
    await assert.rejects(store.create({ name: "x".repeat(61) }), /不能超过 60 个字符/u);
    await assert.rejects(store.create({ name: "岗位", type: "team", parentId: rootId }), /项目类型无效/u);
    await assert.rejects(store.create({ name: "岗位", type: "child" }), /需要所属公司 parentId/u);
    await assert.rejects(store.create({ name: "子岗位", type: "seat" }), /需要所属岗位 parentId/u);
    // A role must hang off a company root, a seat off a role.
    await assert.rejects(
      store.create({ name: "错层级", type: "child", parentId: role.id }),
      /只能在公司根项目下创建岗位/u,
    );
    await assert.rejects(
      store.create({ name: "错层级", type: "seat", parentId: rootId }),
      /只能在岗位下创建子岗位/u,
    );
    await assert.rejects(
      store.create({ name: "孤儿", type: "child", parentId: "missing" }),
      /只能在公司根项目下创建岗位/u,
    );
    // A rejected creation must not have written anything.
    assert.equal((await store.list()).length, 2);
  });
});

test("projects persist across store instances and keep names distinct in slugs", async () => {
  await withStore(async ({ filePath, store }) => {
    const rootId = await store.defaultRootId();
    const first = await store.create({ name: "产品经理", type: "child", parentId: rootId });
    const second = await store.create({ name: "产品经理", type: "child", parentId: rootId });
    assert.notEqual(first.slug, second.slug);
    // Characters that are illegal in a directory name are stripped.
    const messy = await store.create({ name: 'A/B:C*D?E"F<G>H|I', type: "child", parentId: rootId });
    assert.match(messy.slug, /^abcdefghi-[0-9a-f]{6}$/u);

    const reopened = await createProjectStore(filePath);
    assert.deepEqual(
      (await reopened.list()).map((project) => project.id),
      (await store.list()).map((project) => project.id),
    );
    assert.equal((await reopened.get(first.id)).name, "产品经理");
    assert.equal(await reopened.get("missing"), null);
    assert.equal(await reopened.get(""), null);
  });
});

test("a damaged project document fails closed instead of silently resetting", async () => {
  await withStore(async ({ filePath, store }) => {
    await store.list();
    await writeFile(filePath, JSON.stringify({ version: 2, projects: [] }), "utf8");
    await assert.rejects(store.list(), /unsupported or damaged/u);

    await writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{ id: "a", name: "A", type: "team", slug: "a-123456", createdAt: new Date().toISOString() }],
    }), "utf8");
    await assert.rejects(store.list(), /invalid project/u);
  });
});
