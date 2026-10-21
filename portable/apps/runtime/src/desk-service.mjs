import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Desk agent service definitions.
//
// The agent is installed per user, so every target uses a user-level unit:
// a systemd user service on Linux, a LaunchAgent on macOS and a logon task on
// Windows. Files are only rendered here; installation stays a manual step on
// the target machine, and no device token ever appears in a service file.
// ---------------------------------------------------------------------------

export const DESK_SERVICE_LABEL = "com.allroundai.desk";
export const DESK_TASK_NAME = "AllRoundAIDesk";

const POSIX = path.posix;
const WIN32 = path.win32;

function absolute(value, label, api) {
  if (typeof value !== "string" || !api.isAbsolute(value)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  if (/[\r\n"]/u.test(value)) throw new TypeError(`${label}不能包含换行或双引号`);
  return api.normalize(value);
}

function logPath(configPath, api, suffix) {
  const directory = api.dirname(configPath);
  return api.join(directory, `${suffix}.log`);
}

function xmlEscape(value) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function psQuote(value) {
  return `"${value.replace(/`/gu, "``").replace(/\$/gu, "`$")}"`;
}

export function renderSystemdUnit({ nodePath, mainPath, configPath }) {
  const node = absolute(nodePath, "Node 路径", POSIX);
  const main = absolute(mainPath, "desk-cli 路径", POSIX);
  const config = absolute(configPath, "设备配置路径", POSIX);
  const configDirectory = POSIX.dirname(config);
  return `[Unit]
Description=All Round AI desk agent
After=network-online.target

[Service]
Type=simple
ExecStart="${node}" "${main}" run --config "${config}"
WorkingDirectory="${POSIX.dirname(main)}"
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths="${configDirectory}"
StandardOutput=append:${logPath(config, POSIX, "desk-agent.out")}
StandardError=append:${logPath(config, POSIX, "desk-agent.err")}

[Install]
WantedBy=default.target
`;
}

export function renderLaunchAgent({ nodePath, mainPath, configPath }) {
  const node = absolute(nodePath, "Node 路径", POSIX);
  const main = absolute(mainPath, "desk-cli 路径", POSIX);
  const config = absolute(configPath, "设备配置路径", POSIX);
  const entries = [node, main, "run", "--config", config]
    .map((entry) => `    <string>${xmlEscape(entry)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DESK_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${entries}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath(config, POSIX, "desk-agent.out"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath(config, POSIX, "desk-agent.err"))}</string>
</dict>
</plist>
`;
}

export function renderWindowsTask({ nodePath, mainPath, configPath }) {
  const node = absolute(nodePath, "Node 路径", WIN32);
  const main = absolute(mainPath, "desk-cli 路径", WIN32);
  const config = absolute(configPath, "设备配置路径", WIN32);
  return `$ErrorActionPreference = "Stop"
$taskName = "${DESK_TASK_NAME}"
$node = ${psQuote(node)}
$main = ${psQuote(main)}
$config = ${psQuote(config)}
$arguments = '"' + $main + '" run --config "' + $config + '"'
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "All Round AI desk agent" -Force
Write-Output "Registered scheduled task ${DESK_TASK_NAME}"
`;
}

export function renderDeskService({ platform = process.platform, nodePath, mainPath, configPath }) {
  if (platform === "linux") {
    return {
      platform,
      files: [{ name: "all-round-ai-desk.service", content: renderSystemdUnit({ nodePath, mainPath, configPath }) }],
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      files: [{ name: `${DESK_SERVICE_LABEL}.plist`, content: renderLaunchAgent({ nodePath, mainPath, configPath }) }],
    };
  }
  if (platform === "win32") {
    return {
      platform,
      files: [{ name: "install-desk-task.ps1", content: renderWindowsTask({ nodePath, mainPath, configPath }) }],
    };
  }
  throw new Error(`不支持的平台：${platform}`);
}

export async function writeDeskService({ platform = process.platform, outDir, nodePath, mainPath, configPath }) {
  if (typeof outDir !== "string" || !path.isAbsolute(outDir)) {
    throw new TypeError("输出目录必须是绝对路径");
  }
  const rendered = renderDeskService({ platform, nodePath, mainPath, configPath });
  await mkdir(outDir, { recursive: true, mode: 0o755 });
  for (const file of rendered.files) {
    // Windows PowerShell 5.1 decodes a BOM-less script as ANSI, which mangles
    // non-ASCII paths; the BOM makes the UTF-8 encoding explicit.
    const content = file.name.endsWith(".ps1") ? `\uFEFF${file.content}` : file.content;
    await writeFile(path.join(outDir, file.name), content, { mode: 0o644 });
  }
  return { platform: rendered.platform, directory: outDir, files: rendered.files.map((file) => file.name) };
}
