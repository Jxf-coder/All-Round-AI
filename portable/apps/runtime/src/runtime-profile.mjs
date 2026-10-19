// ---------------------------------------------------------------------------
// Runtime profile.
//
// The same application runs in two shapes:
//   - local  : a single-user desktop install; loopback only, no TLS.
//   - server : one customer's own server; listens on a configured address behind
//              a reverse proxy that terminates TLS.
// The difference is configuration plus a deployment adapter, never a business
// branch. Widening network exposure always needs an explicit opt-in, so a
// misconfigured install cannot silently become reachable from the network.
// ---------------------------------------------------------------------------

import { isIP } from "node:net";

export const RUNTIME_PROFILES = Object.freeze(["local", "server"]);
export const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function parseFlag(value) {
  return value === true || value === "1" || value === "true";
}

export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_NAMES.has(normalized) || normalized.startsWith("127.");
}

export function parseRuntimeProfile(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return "local";
  if (!RUNTIME_PROFILES.includes(normalized)) {
    throw new RangeError("ALLROUND_AI_PROFILE must be local or server");
  }
  return normalized;
}

export function resolveListenHost(value, { allowRemote = false } = {}) {
  const host = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_HOST;
  if (isLoopbackHost(host)) return host;
  if (!isIP(host)) {
    throw new RangeError(
      "ALLROUND_AI_HOST must be an IP address (for example 127.0.0.1, 192.168.1.10 or 0.0.0.0)",
    );
  }
  if (!allowRemote) {
    throw new RangeError(
      "Refusing to listen on a non-loopback address without ALLROUND_AI_ALLOW_REMOTE=1",
    );
  }
  return host;
}

// Binding to 0.0.0.0 / :: does not give a human-openable address, so the printed
// URL falls back to loopback.
export function displayHost(host) {
  const normalized = typeof host === "string" && host.trim() ? host.trim() : DEFAULT_HOST;
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") return "127.0.0.1";
  return normalized;
}

export function parseAllowedOrigins(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? value.split(",")
      : [];
  const origins = [];
  for (const item of raw) {
    const candidate = String(item).trim();
    if (!candidate) continue;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new RangeError(
        "ALLROUND_AI_ALLOWED_ORIGINS must contain origins such as https://work.example.com",
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new RangeError(
        "ALLROUND_AI_ALLOWED_ORIGINS must contain origins without a path, query or hash",
      );
    }
    origins.push(parsed.origin);
  }
  return origins;
}

export function resolveRuntimeConfiguration(options = {}) {
  const profile = parseRuntimeProfile(options.profile);
  const allowRemote = parseFlag(options.allowRemote);
  const host = resolveListenHost(options.host, { allowRemote });
  return Object.freeze({
    profile,
    host,
    loopback: isLoopbackHost(host),
    secureCookies: parseFlag(options.secureCookies),
    allowedOrigins: parseAllowedOrigins(options.allowedOrigins),
    // A server install behind a TLS-terminating proxy legitimately has a
    // non-loopback Origin; local installs stay restricted to loopback.
    allowRemoteOrigin: profile === "server" || allowRemote,
  });
}
