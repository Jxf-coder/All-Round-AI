import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  activateRelease,
  checkHealth,
  compareVersions,
  installRelease,
  parseVersion,
  releaseStatus,
  rollbackRelease,
  verifyReleasePackage,
} from "../src/updater.mjs";

const run = promisify(execFile);
const fixedNow = () => new Date("2026-10-20T07:08:09.000Z");

async function buildPackage(root, version, files) {
  const directory = path.join(root, `package-${version}`);
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    records.push({
      path: relative,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const manifest = {
    schema: 1,
    product: "all-round-ai",
    version,
    createdAt: fixedNow().toISOString(),
    files: records,
  };
  await writeFile(path.join(directory, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

const SAMPLE_FILES = {
  "package.json": "{\"name\":\"all-round-ai\"}\n",
  "portable/apps/runtime/src/main.mjs": "console.log('hi');\n",
};

test("versions compare numerically and prereleases sort before releases", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("1.2.3-beta.2").prerelease, ["beta", "2"]);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
  assert.throws(() => parseVersion("0.1"), /无法识别的版本号/u);
  assert.throws(() => parseVersion("latest"), /无法识别的版本号/u);
});

test("a release package must match its manifest exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-release-"));
  try {
    const pkg = await buildPackage(root, "0.1.0", SAMPLE_FILES);
    const verified = await verifyReleasePackage(pkg);
    assert.equal(verified.ok, true);
    assert.equal(verified.manifest.files.length, 2);

    await writeFile(path.join(pkg, "portable", "apps", "runtime", "src", "extra.mjs"), "// extra\n");
    const extra = await verifyReleasePackage(pkg);
    assert.equal(extra.ok, false);
    assert.match(extra.errors[0].reason, /清单之外/u);
    await rm(path.join(pkg, "portable", "apps", "runtime", "src", "extra.mjs"));

    await writeFile(path.join(pkg, "package.json"), "{\"name\":\"tampered\"}\n");
    const tampered = await verifyReleasePackage(pkg);
    assert.equal(tampered.ok, false);
    assert.match(tampered.errors[0].reason, /大小不一致|校验和不一致/u);

    await rm(path.join(pkg, "portable", "apps", "runtime", "src", "main.mjs"));
    const missing = await verifyReleasePackage(pkg);
    assert.match(missing.errors.map((error) => error.reason).join(" "), /文件不存在/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package manifest cannot escape its directory or claim another product", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-release-bad-"));
  try {
    await writeFile(path.join(root, "release.json"), JSON.stringify({
      schema: 1,
      product: "all-round-ai",
      version: "0.1.0",
      files: [{ path: "../escape.json", size: 1, sha256: "0".repeat(64) }],
    }));
    await assert.rejects(verifyReleasePackage(root), /不能包含空段或 \.\./u);

    await writeFile(path.join(root, "release.json"), JSON.stringify({
      schema: 1,
      product: "other-product",
      version: "0.1.0",
      files: [{ path: "a.txt", size: 1, sha256: "0".repeat(64) }],
    }));
    await assert.rejects(verifyReleasePackage(root), /不属于 all-round-ai/u);

    await writeFile(path.join(root, "release.json"), JSON.stringify({
      schema: 1,
      product: "all-round-ai",
      version: "0.1.0",
      files: [],
    }));
    await assert.rejects(verifyReleasePackage(root), /没有任何文件/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install copies a verified release and refuses to overwrite a version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-install-"));
  try {
    const releasesRoot = path.join(root, "releases");
    const pkg = await buildPackage(root, "0.1.0", SAMPLE_FILES);
    const installed = await installRelease({ packageDir: pkg, releasesRoot });
    assert.equal(installed.version, "0.1.0");
    assert.equal(installed.files, 2);
    assert.equal(installed.totalBytes, Buffer.byteLength(SAMPLE_FILES["package.json"])
      + Buffer.byteLength(SAMPLE_FILES["portable/apps/runtime/src/main.mjs"]));
    assert.equal(
      await readFile(path.join(installed.directory, "portable", "apps", "runtime", "src", "main.mjs"), "utf8"),
      "console.log('hi');\n",
    );
    assert.equal((await verifyReleasePackage(installed.directory)).ok, true);

    await assert.rejects(
      installRelease({ packageDir: pkg, releasesRoot }),
      /版本已存在/u,
    );

    const tamperedPackage = await buildPackage(root, "0.1.1", { "package.json": "{}\n" });
    await writeFile(path.join(tamperedPackage, "package.json"), "{\"x\":1}\n");
    await assert.rejects(
      installRelease({ packageDir: tamperedPackage, releasesRoot }),
      /发布包校验失败/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activate switches the current link and rollback returns to the previous release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-activate-"));
  try {
    const releasesRoot = path.join(root, "releases");
    const currentPath = path.join(root, "current");
    const stateFile = path.join(root, "state", "releases.json");

    const first = await installRelease({
      packageDir: await buildPackage(root, "0.1.0", SAMPLE_FILES),
      releasesRoot,
    });
    const activated = await activateRelease({ releasesRoot, currentPath, stateFile, version: "0.1.0", now: fixedNow });
    assert.equal(activated.changed, true);
    assert.equal(activated.previous, null);
    assert.equal(await realpath(currentPath), await realpath(first.directory));

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.active, "0.1.0");
    assert.equal(state.previous, null);
    assert.equal(state.history.length, 1);

    const second = await installRelease({
      packageDir: await buildPackage(root, "0.2.0", { ...SAMPLE_FILES, "CHANGELOG.md": "new\n" }),
      releasesRoot,
    });
    const upgraded = await activateRelease({ releasesRoot, currentPath, stateFile, version: "0.2.0", now: fixedNow });
    assert.equal(upgraded.previous, "0.1.0");
    assert.equal(await realpath(currentPath), await realpath(second.directory));

    const status = await releaseStatus({ releasesRoot, currentPath, stateFile });
    assert.deepEqual(status.installed, ["0.1.0", "0.2.0"]);
    assert.equal(status.active, "0.2.0");
    assert.equal(status.previous, "0.1.0");
    assert.equal(status.linkExists, true);

    const rolled = await rollbackRelease({ releasesRoot, currentPath, stateFile, now: fixedNow });
    assert.equal(rolled.version, "0.1.0");
    assert.equal(rolled.previous, "0.2.0");
    assert.equal(await realpath(currentPath), await realpath(first.directory));
    // Rolling back must not delete the release it moved away from.
    assert.equal(
      await readFile(path.join(second.directory, "CHANGELOG.md"), "utf8"),
      "new\n",
    );

    const afterRollback = await releaseStatus({ releasesRoot, currentPath, stateFile });
    assert.equal(afterRollback.active, "0.1.0");
    assert.equal(afterRollback.previous, "0.2.0");
    assert.equal(afterRollback.history.at(-1).rollback, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activate rejects unknown versions and rollback without a previous version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-activate-bad-"));
  try {
    const releasesRoot = path.join(root, "releases");
    const currentPath = path.join(root, "current");
    const stateFile = path.join(root, "state", "releases.json");
    await assert.rejects(
      activateRelease({ releasesRoot, currentPath, stateFile, version: "9.9.9" }),
      /未安装或已损坏/u,
    );
    await assert.rejects(
      rollbackRelease({ releasesRoot, currentPath, stateFile }),
      /没有可回滚的版本/u,
    );

    await installRelease({ packageDir: await buildPackage(root, "0.1.0", SAMPLE_FILES), releasesRoot });
    await mkdir(currentPath);
    await writeFile(path.join(currentPath, "keep.txt"), "real directory\n");
    await assert.rejects(
      activateRelease({ releasesRoot, currentPath, stateFile, version: "0.1.0" }),
      /真实目录/u,
    );
    assert.equal(await readFile(path.join(currentPath, "keep.txt"), "utf8"), "real directory\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health checks retry failures and report the last error", async () => {
  let calls = 0;
  const eventual = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ service: "all-round-ai", status: "ok" }) };
  };
  const first = await checkHealth({ url: "http://127.0.0.1:3141/health", fetchImpl: eventual, waitImpl: async () => {} });
  assert.deepEqual(first, { ok: true, attempts: 3, url: "http://127.0.0.1:3141/health", service: "all-round-ai" });

  const failing = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const second = await checkHealth({
    url: "http://127.0.0.1:3141/health",
    fetchImpl: failing,
    attempts: 2,
    waitImpl: async () => {},
  });
  assert.equal(second.ok, false);
  assert.equal(second.attempts, 2);
  assert.match(second.error, /ECONNREFUSED/u);

  await assert.rejects(checkHealth({ url: "ftp://example.com" }), /http\(s\) URL/u);
  await assert.rejects(checkHealth({ url: "http://x", attempts: 0 }), /正整数/u);
});

test("the CLI verifies, installs, activates, reports status and rolls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-update-cli-"));
  try {
    const releasesRoot = path.join(root, "releases");
    const currentPath = path.join(root, "current");
    const stateFile = path.join(root, "state", "releases.json");
    const cli = fileURLToPath(new URL("../src/update-cli.mjs", import.meta.url));
    const firstPackage = await buildPackage(root, "0.1.0", SAMPLE_FILES);
    const secondPackage = await buildPackage(root, "0.2.0", { ...SAMPLE_FILES, "CHANGELOG.md": "new\n" });

    const verified = JSON.parse((await run(process.execPath, [cli, "verify", "--package", firstPackage])).stdout);
    assert.equal(verified.ok, true);
    assert.equal(verified.version, "0.1.0");

    const installed = JSON.parse((await run(process.execPath, [
      cli, "install", "--package", firstPackage, "--releases", releasesRoot,
    ])).stdout);
    assert.equal(installed.version, "0.1.0");

    const activated = JSON.parse((await run(process.execPath, [
      cli, "activate", "--releases", releasesRoot, "--current", currentPath, "--state", stateFile, "--version", "0.1.0",
    ])).stdout);
    assert.equal(activated.changed, true);

    await run(process.execPath, [cli, "install", "--package", secondPackage, "--releases", releasesRoot]);
    await run(process.execPath, [
      cli, "activate", "--releases", releasesRoot, "--current", currentPath, "--state", stateFile, "--version", "0.2.0",
    ]);

    const status = JSON.parse((await run(process.execPath, [
      cli, "status", "--releases", releasesRoot, "--current", currentPath, "--state", stateFile,
    ])).stdout);
    assert.deepEqual(status.installed, ["0.1.0", "0.2.0"]);
    assert.equal(status.active, "0.2.0");

    const rolled = JSON.parse((await run(process.execPath, [
      cli, "rollback", "--releases", releasesRoot, "--current", currentPath, "--state", stateFile,
    ])).stdout);
    assert.equal(rolled.version, "0.1.0");

    const failedHealth = await run(process.execPath, [
      cli, "health", "--url", "http://127.0.0.1:9/health", "--attempts", "1", "--delay-ms", "0",
    ]).catch((error) => error);
    assert.equal(failedHealth.code, 1);
    assert.equal(JSON.parse(failedHealth.stdout).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package containing a symlink is rejected", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-release-link-"));
  try {
    const pkg = await buildPackage(root, "0.1.0", SAMPLE_FILES);
    await symlink(path.join(pkg, "package.json"), path.join(pkg, "linked.json"));
    const verified = await verifyReleasePackage(pkg);
    assert.equal(verified.ok, false);
    assert.match(verified.errors.map((error) => error.reason).join(" "), /符号链接/u);
    assert.equal(await readFile(path.join(pkg, "package.json"), "utf8"), SAMPLE_FILES["package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
