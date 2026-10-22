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
    assert.equal(skills.get("audio-extract").enabled, true);
    assert.equal(skills.get("audio-extract").available, false);
    assert.match(skills.get("audio-extract").reason, /FFmpeg/);
    assert.equal(skills.get("video-normalize").enabled, true);
    assert.equal(skills.get("video-normalize").available, false);
    assert.match(skills.get("video-normalize").reason, /FFmpeg/);
    assert.equal(skills.get("video-reframe").enabled, true);
    assert.equal(skills.get("video-reframe").available, false);
    assert.equal(skills.get("video-subtitle").enabled, true);
    assert.equal(skills.get("video-subtitle").available, false);
    assert.equal(skills.get("video-burn").enabled, true);
    assert.equal(skills.get("video-burn").available, false);
    assert.match(skills.get("video-burn").reason, /FFmpeg/);
    assert.equal(skills.get("media-render").enabled, true);
    assert.equal(skills.get("media-render").available, false);
    assert.equal(skills.get("asr-subtitle").enabled, true);
    assert.equal(skills.get("asr-subtitle").available, false);
    assert.match(skills.get("asr-subtitle").reason, /FFmpeg/);
    assert.equal(skills.get("asr-batch").enabled, true);
    assert.equal(skills.get("asr-batch").available, false);
    // With FFmpeg present the next gate is the local recognizer itself.
    const mediaReady = byId(await fixture.store.list([], {
      media: { ffmpeg: { available: true } },
      asr: { available: false, reason: "Python 不可用" },
    }));
    assert.equal(mediaReady.get("asr-subtitle").available, false);
    assert.match(mediaReady.get("asr-subtitle").reason, /faster-whisper/u);
    assert.equal(skills.get("publish-pack").enabled, true);
    assert.equal(skills.get("publish-pack").available, true);
    assert.deepEqual(listed.stats, { total: SKILLS.length, enabled: 24, available: 13, comingSoon: 3 });
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

test("media skills follow the detected FFmpeg install", async () => {
  const fixture = await temporaryStore();
  try {
    const missing = byId(await fixture.store.list([], {
      media: { ffmpeg: { available: false, reason: "未安装，或不在 PATH 里" } },
    }));
    assert.equal(missing.get("audio-extract").available, false);
    assert.match(missing.get("audio-extract").reason, /未安装，或不在 PATH 里/u);
    assert.equal(missing.get("video-normalize").available, false);
    assert.equal(missing.get("video-reframe").available, false);
    assert.equal(missing.get("video-subtitle").available, false);
    assert.equal(missing.get("media-inventory").available, true);

    const ready = byId(await fixture.store.list([], {
      media: { ffmpeg: { available: true } },
    }));
    assert.equal(ready.get("audio-extract").available, true);
    assert.equal(ready.get("audio-extract").reason, "");
    assert.equal(ready.get("video-normalize").available, true);
    assert.equal(ready.get("video-reframe").available, true);
    assert.equal(ready.get("video-subtitle").available, true);
    assert.equal(ready.get("media-inventory").available, true);
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
  assert.equal(skillForPipeline("topic-pack"), "topic-pack");
  assert.equal(skillForPipeline("script-rewrite"), "script-rewrite");
  assert.equal(skillForPipeline("media-inventory"), "media-inventory");
  assert.equal(skillForPipeline("audio-extract"), "audio-extract");
  assert.equal(skillForPipeline("video-normalize"), "video-normalize");
  assert.equal(skillForPipeline("video-reframe"), "video-reframe");
  assert.equal(skillForPipeline("video-subtitle"), "video-subtitle");
  assert.equal(skillForPipeline("unknown"), null);
});
