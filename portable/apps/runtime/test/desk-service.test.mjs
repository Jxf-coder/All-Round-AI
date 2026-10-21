import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  renderDeskService,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsTask,
  writeDeskService,
} from "../src/desk-service.mjs";

const run = promisify(execFile);

const LINUX_PATHS = {
  nodePath: "/usr/bin/node",
  mainPath: "/opt/all-round-ai/portable/apps/runtime/src/desk-cli.mjs",
  configPath: "/home/u/.local/share/all-round-ai/desk-agent.json",
};

const MAC_PATHS = {
  nodePath: "/opt/homebrew/bin/node",
  mainPath: "/Users/u/Applications/all-round-ai/portable/apps/runtime/src/desk-cli.mjs",
  configPath: "/Users/u/Library/Application Support/All-Round-AI/desk-agent.json",
};

const WINDOWS_PATHS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  mainPath: "C:\\all-round-ai\\portable\\apps\\runtime\\src\\desk-cli.mjs",
  configPath: "C:\\Users\\u\\AppData\\Roaming\\All-Round-AI\\desk-agent.json",
};

test("the systemd user unit runs the agent with restart and a writable config directory", () => {
  const unit = renderSystemdUnit(LINUX_PATHS);
  assert.match(unit, /\[Install\]\nWantedBy=default\.target/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(
    unit,
    /ExecStart="\/usr\/bin\/node" "\/opt\/all-round-ai\/portable\/apps\/runtime\/src\/desk-cli\.mjs" run --config "\/home\/u\/\.local\/share\/all-round-ai\/desk-agent\.json"/u,
  );
  assert.match(unit, /ReadWritePaths="\/home\/u\/\.local\/share\/all-round-ai"/u);
  assert.match(unit, /StandardError=append:\/home\/u\/\.local\/share\/all-round-ai\/desk-agent\.err\.log/u);
  assert.equal(unit.includes("token"), false);

  assert.throws(
    () => renderSystemdUnit({ ...LINUX_PATHS, configPath: "relative/desk-agent.json" }),
    /必须是绝对路径/u,
  );
  assert.throws(
    () => renderSystemdUnit({ ...LINUX_PATHS, configPath: "/home/u/bad\npath.json" }),
    /不能包含换行/u,
  );
});

test("the LaunchAgent escapes XML and keeps the agent alive", () => {
  const plist = renderLaunchAgent({
    ...MAC_PATHS,
    configPath: "/Users/u/Library/Application Support/All-Round-AI & Notes/desk-agent.json",
  });
  assert.match(plist, /<key>Label<\/key>\n  <string>com\.allroundai\.desk<\/string>/u);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>/u);
  assert.match(plist, /All-Round-AI &amp; Notes/u);
  assert.match(plist, /<string>--config<\/string>/u);
  assert.equal(plist.includes("token"), false);
});

test("the Windows task registers at logon and restarts on failure", () => {
  const script = renderWindowsTask(WINDOWS_PATHS);
  assert.match(script, /Register-ScheduledTask -TaskName \$taskName/u);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/u);
  assert.match(script, /RestartCount 999/u);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/u);
  assert.match(script, /\$node = "C:\\Program Files\\nodejs\\node\.exe"/u);
  assert.match(script, /run --config/u);
  assert.equal(script.includes("token"), false);
  assert.throws(
    () => renderWindowsTask({ ...WINDOWS_PATHS, mainPath: "relative\\desk-cli.mjs" }),
    /必须是绝对路径/u,
  );
});

test("the dispatcher picks one file per platform and rejects others", () => {
  assert.equal(renderDeskService({ platform: "linux", ...LINUX_PATHS }).files[0].name, "all-round-ai-desk.service");
  assert.equal(renderDeskService({ platform: "darwin", ...MAC_PATHS }).files[0].name, "com.allroundai.desk.plist");
  assert.equal(renderDeskService({ platform: "win32", ...WINDOWS_PATHS }).files[0].name, "install-desk-task.ps1");
  assert.throws(() => renderDeskService({ platform: "aix", ...LINUX_PATHS }), /不支持的平台/u);
});

test("the Windows task script carries a BOM so unicode paths survive PowerShell 5", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-service-bom-"));
  try {
    const written = await writeDeskService({
      platform: "win32",
      outDir: root,
      ...WINDOWS_PATHS,
    });
    assert.deepEqual(written.files, ["install-desk-task.ps1"]);
    const content = await readFile(path.join(root, "install-desk-task.ps1"), "utf8");
    assert.equal(content.charCodeAt(0), 0xfeff);
    assert.match(content, /Register-ScheduledTask/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing a service file and the CLI both work for the current platform", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-desk-service-"));
  try {
    const isWindows = process.platform === "win32";
    const configPath = path.join(root, "desk-agent.json");
    await writeFile(configPath, JSON.stringify({
      schema: 1,
      serverUrl: "http://127.0.0.1:3175",
      deviceId: "dev-0123456789ab",
      name: "验收设备",
      token: "test-device-token-0123456789abcdef",
      pairedAt: "2026-10-20T10:00:00.000Z",
    }));

    const mainPath = fileURLToPath(new URL("../src/desk-cli.mjs", import.meta.url));
    const written = await writeDeskService({
      outDir: path.join(root, "service"),
      nodePath: process.execPath,
      mainPath,
      configPath,
    });
    assert.equal(written.platform, process.platform);
    assert.equal(written.files.length, 1);
    const content = await readFile(path.join(written.directory, written.files[0]), "utf8");
    assert.ok(content.length > 100);
    assert.equal(content.includes("test-device-token"), false);

    const cli = fileURLToPath(new URL("../src/desk-cli.mjs", import.meta.url));
    const output = await run(process.execPath, [
      cli, "service",
      "--config", configPath,
      "--out", path.join(root, "cli-service"),
    ]);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.platform, process.platform);
    assert.match(parsed.install, isWindows ? /install-desk-task/u : /systemctl|launchctl/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
