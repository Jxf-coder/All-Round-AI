import os from "node:os";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);

function pathApi(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("Unsupported operating system: " + platform);
  }
  return platform === "win32" ? path.win32 : path.posix;
}

function absoluteOrNull(value, api) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const candidate = value.trim();
  return api.isAbsolute(candidate) ? api.normalize(candidate) : null;
}

export function resolveDataDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = pathApi(platform);
  const homeValue =
    options.home ??
    (platform === "win32"
      ? env.USERPROFILE || env.HOME
      : env.HOME) ??
    os.homedir();
  const home = absoluteOrNull(homeValue, api);

  const override = env.ALLROUND_AI_DATA_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    const absoluteOverride = absoluteOrNull(override, api);
    if (!absoluteOverride) {
      throw new TypeError("ALLROUND_AI_DATA_DIR must be an absolute path");
    }
    return api.resolve(absoluteOverride);
  }

  if (!home) {
    throw new TypeError("A valid absolute home directory is required");
  }

  if (platform === "win32") {
    const appData = absoluteOrNull(env.APPDATA, api);
    return api.join(appData ?? api.join(home, "AppData", "Roaming"), "All-Round-AI");
  }

  if (platform === "darwin") {
    return api.join(home, "Library", "Application Support", "All-Round-AI");
  }

  const xdgData = absoluteOrNull(env.XDG_DATA_HOME, api);
  return api.join(xdgData ?? api.join(home, ".local", "share"), "all-round-ai");
}

export function resolveDataPath(relativePath, options = {}) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new TypeError("A non-empty relative data path is required");
  }

  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  if (api.isAbsolute(relativePath)) {
    throw new TypeError("Data paths must be relative to the application data directory");
  }

  const root = resolveDataDirectory(options);
  const candidate = api.resolve(root, relativePath);
  const relative = api.relative(root, candidate);
  if (
    relative === "" ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith(".." + api.sep) ||
    api.isAbsolute(relative)
  ) {
    throw new RangeError("Data path escapes the application data directory");
  }
  return candidate;
}

export function buildSpawnOptions(platform = process.platform, options = {}) {
  pathApi(platform);
  return {
    ...options,
    shell: false,
    ...(platform === "win32" ? { windowsHide: true } : {}),
  };
}
