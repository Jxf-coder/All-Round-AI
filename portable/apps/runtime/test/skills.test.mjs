import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMMAND_SKILLS,
  SKILLS,
  createSkillStore,
  skillById,
  skillForCommand,
  skillForPipeline,
} from "../src/skills.mjs";

async function temporaryStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-skills-"));
  const file = path.join(root, "skills.json");
  const store = await createSkillStore(file);
  return {
    file,
    store,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function byId(list) {
  return new Map(list.skills.map((skill) => [skill.id, skill]));
}

test("the catalog lists implemented capabilities and keeps later phases visible", async () => {
  const fixture = await temporaryStore();
  try {
    const listed = await fixture.store.list();
    assert.deepEqual(listed.categories.map((category) => category.id),
      ["all", "knowledge", "creation", "production", "system"]);
    assert.equal(listed.skills.length, SKILLS.length);
    assert.equal(new Set(SKILLS.map((skill) => skill.id)).size, SKILLS.length);

    const skills = byId(listed);
    assert.equal(skills.get("knowledge-qa").enabled, true);
    assert.equal(skills.get("script-draft").enabled, true);
    assert.equal(skills.get("doc-rewrite").comingSoon, true);
    assert.equal(skills.get("doc-rewrite").enabled, false);
    assert.equal(skills.get("doc-rewrite").available, false);
    assert.match(skills.get("doc-rewrite").reason, /迁移中/);
    assert.deepEqual(listed.stats, { total: SKILLS.length, enabled: 7, available: 4, comingSoon: 4 });
  } finally {
    await fixture.close();
  }
});

test("desk availability follows declared capabilities and separates online state", async () => {
  const fixture = await temporaryStore();
  try {
    const none = byId(await fixture.store.list());
    assert.equal(none.get("local-files").available, false);
    assert.match(none.get("local-files").reason, /files/);
    assert.match(none.get("local-files").howTo, /desk-cli pair/);

    const offline = byId(await fixture.store.list([
      { id: "dev-1", capabilities: ["files", "process"], online: false },
    ]));
    assert.equal(offline.get("local-files").available, true);
    assert.equal(offline.get("local-files").devices, 1);
    assert.equal(offline.get("local-files").online, 0);
    assert.equal(offline.get("local-screen").available, false);

    const online = byId(await fixture.store.list([
      { id: "dev-1", capabilities: ["files"], online: true },
      { id: "dev-2", capabilities: ["files", "screen"], online: true },
    ]));
    assert.equal(online.get("local-files").devices, 2);
    assert.equal(online.get("local-files").online, 2);
    assert.equal(online.get("local-screen").devices, 1);
    assert.equal(online.get("local-screen").online, 1);
  } finally {
    await fixture.close();
  }
});

test("a switch survives a restart and only accepts real, launched skills", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.setEnabled("knowledge-qa", false);
    assert.equal(await fixture.store.isEnabled("knowledge-qa"), false);

    const reopened = await createSkillStore(fixture.file);
    assert.equal(await reopened.isEnabled("knowledge-qa"), false);
    assert.equal(byId(await reopened.list()).get("knowledge-qa").enabled, false);

    await reopened.setEnabled("knowledge-qa", true);
    assert.equal(await reopened.isEnabled("knowledge-qa"), true);

    await assert.rejects(reopened.setEnabled("does-not-exist", false), /技能不存在/);
    await assert.rejects(reopened.setEnabled("doc-rewrite", true), /还没有上线/);
    await assert.rejects(reopened.setEnabled("knowledge-qa", "yes"), /布尔值/);
  } finally {
    await fixture.close();
  }
});

test("a damaged switch document fails closed instead of enabling everything", async () => {
  const fixture = await temporaryStore();
  try {
    await writeFile(fixture.file, '{"version":1,"disabled":"all"}\n', "utf8");
    await assert.rejects(fixture.store.list(), /unsupported or damaged/);
  } finally {
    await fixture.close();
  }
});

test("command and pipeline mappings stay inside the catalog", () => {
  for (const skillId of Object.values(COMMAND_SKILLS)) {
    assert.ok(skillById(skillId), `${skillId} must exist`);
  }
  assert.equal(skillForCommand("files.read"), "local-files");
  assert.equal(skillForCommand("process.run"), "local-process");
  assert.equal(skillForCommand("screen.capture"), "local-screen");
  assert.equal(skillForCommand("unknown"), null);
  assert.equal(skillForPipeline("knowledge-brief"), "knowledge-brief");
  assert.equal(skillForPipeline("script-draft"), "script-draft");
  assert.equal(skillForPipeline("unknown"), null);
});
