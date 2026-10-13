import { access, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveDataDirectory } from "./paths.mjs";

function resolveCacheDirectory(options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = platform === "win32" ? path.win32 : path.posix;
  const homeValue =
    options.home ??
    (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) ??
    os.homedir();
  if (typeof homeValue !== "string" || !api.isAbsolute(homeValue)) {
    throw new TypeError("A valid absolute home directory is required");
  }
  const home = api.normalize(homeValue);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData && api.isAbsolute(localAppData)) {
      return path.win32.join(localAppData, "All-Round-AI", "Cache");
    }
    return path.win32.join(home, "AppData", "Local", "All-Round-AI", "Cache");
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Caches", "All-Round-AI");
  }
  const xdgCache = env.XDG_CACHE_HOME;
  return path.posix.join(
    xdgCache && api.isAbsolute(xdgCache) ? xdgCache : path.posix.join(home, ".cache"),
    "all-round-ai",
  );
}

export function resolveAppDirectories(options = {}) {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const data = resolveDataDirectory(options);
  const cache = resolveCacheDirectory(options);
  return Object.freeze({
    data,
    config: api.join(data, "config"),
    logs: api.join(data, "logs"),
    cache,
    temp: api.join(cache, "tmp"),
  });
}

export async function ensureAppDirectories(options = {}) {
  const directories = resolveAppDirectories(options);
  for (const [name, directory] of Object.entries(directories)) {
    await mkdir(directory, { recursive: true });
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new TypeError(`Application ${name} path is not a directory`);
    }
    await access(directory, 2);
  }
  return directories;
}
