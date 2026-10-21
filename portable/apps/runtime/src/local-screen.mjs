import { randomBytes } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runProcess } from "./local-process.mjs";

// ---------------------------------------------------------------------------
// Screen capture for the desk agent.
//
// Each platform has one fixed system utility; there is no user-supplied
// command here. The screenshot lands in a temporary file, is read back, and is
// deleted whatever happens. Only PNG is supported and the result is capped so
// a 4K screen cannot blow up the command channel.
// ---------------------------------------------------------------------------

export const MAX_SCREEN_BYTES = 4 * 1024 * 1024;
export const SCREEN_TIMEOUT_MS = 20_000;

export class LocalScreenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalScreenError";
    this.code = code;
  }
}

async function exists(file, existsImpl) {
  return existsImpl(file).then(() => true, () => false);
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsScript(target) {
  return `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save(${psQuote(target)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
}

async function findOnPath(name, { env, pathApi, platform, existsImpl }) {
  const directories = (env.PATH ?? "").split(pathApi.delimiter).filter(Boolean);
  const extensions = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`);
      if (await exists(candidate, existsImpl)) return candidate;
    }
  }
  return null;
}

async function resolveCapture({ platform, target, env, pathApi, existsImpl }) {
  if (platform === "win32") {
    const program = pathApi.join(
      env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (!(await exists(program, existsImpl))) {
      throw new LocalScreenError("NO_TOOL", "找不到 Windows PowerShell，无法截图");
    }
    return { program, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsScript(target)] };
  }
  if (platform === "darwin") {
    const program = "/usr/sbin/screencapture";
    if (!(await exists(program, existsImpl))) {
      throw new LocalScreenError("NO_TOOL", "找不到 screencapture，无法截图");
    }
    return { program, args: ["-x", target] };
  }
  if (platform === "linux") {
    const candidates = [
      { name: "grim", args: [target] },
      { name: "gnome-screenshot", args: ["-f", target] },
      { name: "scrot", args: [target] },
      { name: "import", args: ["-window", "root", target] },
    ];
    for (const candidate of candidates) {
      const program = await findOnPath(candidate.name, { env, pathApi, platform, existsImpl });
      if (program) return { program, args: candidate.args };
    }
    throw new LocalScreenError("NO_TOOL", "没有可用的截图工具（grim / gnome-screenshot / scrot / import）");
  }
  throw new LocalScreenError("UNSUPPORTED", `不支持的平台：${platform}`);
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function captureScreen({
  platform = process.platform,
  tmpDir = os.tmpdir(),
  maxBytes = MAX_SCREEN_BYTES,
  env = process.env,
  pathApi = platform === "win32" ? path.win32 : path.posix,
  run = runProcess,
  existsImpl = access,
  findCapture = resolveCapture,
  readFileImpl = readFile,
  unlinkImpl = unlink,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new LocalScreenError("BAD_LIMIT", "截图上限必须是正整数");
  }
  const target = pathApi.join(
    tmpDir,
    `allround-screen-${now().toString(36)}-${randomBytes(5).toString("hex")}.png`,
  );
  const capture = await findCapture({ platform, target, env, pathApi, existsImpl });
  try {
    const result = await run({ program: capture.program, args: capture.args, timeoutMs: SCREEN_TIMEOUT_MS });
    if (result?.timedOut) throw new LocalScreenError("TIMEOUT", "截图超时，请确认设备已登录桌面");
    if (result?.code !== 0) {
      const detail = typeof result?.stderr === "string" ? result.stderr.trim().slice(0, 200) : "";
      throw new LocalScreenError(
        "CAPTURE_FAILED",
        `截图失败${detail ? `：${detail}` : "（系统返回非零退出码）"}`,
      );
    }
    const buffer = await readFileImpl(target).catch(() => null);
    if (!buffer) throw new LocalScreenError("NO_OUTPUT", "截图没有生成文件");
    if (buffer.length === 0) throw new LocalScreenError("EMPTY", "截图内容为空");
    if (buffer.length > maxBytes) {
      throw new LocalScreenError("TOO_LARGE", `截图超过 ${maxBytes} 字节，拒绝回传`);
    }
    const size = pngSize(buffer);
    return {
      format: "png",
      bytes: buffer.length,
      width: size?.width ?? null,
      height: size?.height ?? null,
      data: buffer.toString("base64"),
    };
  } finally {
    await unlinkImpl(target).catch(() => {});
  }
}
