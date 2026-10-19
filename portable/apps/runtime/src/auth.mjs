import { createHash, randomBytes } from "node:crypto";

import { json, readJsonBody as bodyJson } from "./router.mjs";

const COOKIE = "all_round_ai_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 1000;
const DEFAULT_LOGIN_FAILURE_LIMIT = 5;
const DEFAULT_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_LOGIN_KEYS = 10_000;

function cookie(request) {
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === COOKIE) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

// Local installs only accept loopback origins. A server install behind a TLS
// proxy has a real hostname, so it either trusts a configured allowlist or
// accepts any http(s) origin that matches the request host.
function originAllowed(request, policy = {}) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (Array.isArray(policy.allowedOrigins) && policy.allowedOrigins.length) {
      return policy.allowedOrigins.includes(parsed.origin);
    }
    const requestHost = String(request.headers.host || "").toLowerCase();
    if (parsed.host.toLowerCase() !== requestHost) return false;
    if (policy.allowRemoteOrigin === true) {
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function safeUser(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = value.id ?? null;
  if (id !== null && typeof id !== "string" && typeof id !== "number") return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  return {
    id,
    name: value.name.trim().slice(0, 100),
    role: typeof value.role === "string" ? value.role.slice(0, 40) : "member",
    ...(typeof value.roleLabel === "string" ? { roleLabel: value.roleLabel.slice(0, 80) } : {}),
    source: ["all-round-ai", "local"].includes(value.source) ? value.source : "local",
    ...(typeof value.avatarUrl === "string" ? { avatarUrl: value.avatarUrl.slice(0, 2048) } : {}),
    mustChangePassword: Boolean(value.mustChangePassword),
  };
}

function safeGuestOf(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/.test(value) ? value : null;
}

function safePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "http://127.0.0.1");
    return url.origin === "http://127.0.0.1" ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

export function createLocalAuth(options = {}) {
  const provider = options.provider ?? null;
  if (provider !== null && typeof provider !== "function") {
    throw new TypeError("Authentication provider must be a function");
  }
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
    throw new TypeError("Session TTL must be a positive safe integer");
  }
  const loginFailureLimit = options.loginFailureLimit ?? DEFAULT_LOGIN_FAILURE_LIMIT;
  const loginFailureWindowMs = options.loginFailureWindowMs ?? DEFAULT_LOGIN_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(loginFailureLimit) || loginFailureLimit < 1
    || !Number.isSafeInteger(loginFailureWindowMs) || loginFailureWindowMs < 1 || typeof now !== "function") {
    throw new TypeError("Login failure limit and window must be positive safe integers");
  }
  const sessions = options.initialState?.sessions ?? new Map();
  const loginFailures = options.initialState?.loginFailures ?? new Map();
  const stateStore = options.stateStore ?? null;
  const onPersistError = options.onPersistError ?? null;
  const secureCookies = options.secureCookies === true;
  const allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];
  const originPolicy = {
    allowRemoteOrigin: options.allowRemoteOrigin === true,
    allowedOrigins,
  };
  // `Secure` is only meaningful behind TLS; a local install stays plain HTTP on
  // loopback, where a Secure cookie would never be sent back.
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;
  let pendingPersist = Promise.resolve();

  // Session and throttle state is authoritative in memory and mirrored to disk
  // after each mutation, so a restart keeps everyone signed in. A failed write
  // degrades to in-memory-only state instead of failing the request, and is
  // reported through onPersistError so it cannot pass unnoticed.
  function persist() {
    if (!stateStore) return pendingPersist;
    pendingPersist = pendingPersist
      .then(() => stateStore.save({ sessions, loginFailures }))
      .catch((error) => {
        if (typeof onPersistError === "function") onPersistError(error);
      });
    return pendingPersist;
  }

  const loginKey = (username) => createHash("sha256")
    .update(username.normalize("NFKC").trim().toLowerCase())
    .digest("hex");
  const pruneLoginFailures = (at) => {
    let changed = false;
    for (const [key, failures] of loginFailures) {
      const recent = failures.filter((timestamp) => at - timestamp < loginFailureWindowMs);
      if (recent.length !== failures.length) changed = true;
      if (recent.length) loginFailures.set(key, recent);
      else loginFailures.delete(key);
    }
    while (loginFailures.size > MAX_TRACKED_LOGIN_KEYS) {
      loginFailures.delete(loginFailures.keys().next().value);
      changed = true;
    }
    return changed;
  };
  const readSession = (request) => {
    const id = cookie(request);
    const session = id ? sessions.get(id) : null;
    if (session && session.expiresAt <= Date.now()) {
      sessions.delete(id);
      void persist();
      return null;
    }
    return session;
  };
  const pruneSessions = () => {
    const at = Date.now();
    let changed = false;
    for (const [id, session] of sessions) {
      if (session.expiresAt <= at) {
        sessions.delete(id);
        changed = true;
      }
    }
    return changed;
  };
  // Expired state is dropped once at startup and written back if anything was
  // actually removed, so a long-idle install does not restore dead sessions.
  const prunedSessions = pruneSessions();
  const prunedFailures = pruneLoginFailures(now());
  if (prunedSessions || prunedFailures) void persist();
  const hasSession = (request) => Boolean(readSession(request));
  async function sessionIsValid(request) {
    const id = cookie(request);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (id && sessions.delete(id)) void persist();
      return false;
    }
    const version = session.context?.credentialVersion;
    if (Number.isSafeInteger(version) && typeof provider?.isSessionValid === "function") {
      try {
        if (await provider.isSessionValid(session.user.id, version)) return true;
      } catch {
        return false;
      }
      if (sessions.delete(id)) void persist();
      return false;
    }
    return true;
  }

  async function handle(request, response) {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/auth/status") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed" }, { allow: "GET" });
      } else {
        const status = typeof provider?.status === "function"
          ? await provider.status()
          : { configured: Boolean(provider), setupRequired: false };
        json(response, 200, status);
      }
      return true;
    }
    if (pathname === "/api/auth/login") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" }, { allow: "POST" });
        return true;
      }
      if (!originAllowed(request, originPolicy)) {
        json(response, 403, { error: "请求来源无效" });
        return true;
      }
      let body;
      try {
        body = await bodyJson(request);
      } catch (error) {
        json(response, error.status || 400, { error: error.message || "请求格式错误" });
        return true;
      }
      const user = String(body.user || "").trim();
      const password = String(body.password || "");
      if (!user || !password) {
        json(response, 400, { error: "请输入账号和密码" });
        return true;
      }
      if (!provider) {
        json(response, 503, { error: "登录服务尚未配置" });
        return true;
      }
      const throttleKey = loginKey(user);
      const attemptedAt = now();
      pruneLoginFailures(attemptedAt);
      const priorFailures = loginFailures.get(throttleKey) || [];
      if (priorFailures.length >= loginFailureLimit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((priorFailures[0] + loginFailureWindowMs - attemptedAt) / 1000));
        json(response, 429, { error: "登录尝试过多，请稍后重试" }, { "retry-after": String(retryAfterSeconds) });
        return true;
      }
      let result;
      try {
        result = await provider({ user, password });
      } catch {
        json(response, 502, { error: "认证服务暂时不可用" });
        return true;
      }
      if (!result || result.ok !== true) {
        // Preserve the source application's observable distinction: service
        // failures use 502; ordinary credential rejections use 401.
        const status = result?.status === 502 ? 502 : 401;
        const error = typeof result?.error === "string"
          ? result.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160)
          : "";
        if (status === 401) {
          const failures = loginFailures.get(throttleKey) || [];
          failures.push(attemptedAt);
          loginFailures.set(throttleKey, failures);
          pruneLoginFailures(attemptedAt);
          void persist();
        }
        json(response, status, { error: error || "账号或密码错误" });
        return true;
      }
      const identity = safeUser(result.user);
      if (!identity) {
        json(response, 502, { error: "认证服务返回格式异常" });
        return true;
      }
      loginFailures.delete(throttleKey);
      pruneSessions();
      if (sessions.size >= MAX_ACTIVE_SESSIONS) {
        json(response, 503, { error: "当前登录会话较多，请稍后重试" });
        return true;
      }
      const id = randomBytes(32).toString("base64url");
      // Private authentication context stays server-side: only the credential
      // version is persisted, never provider tokens or the raw context.
      sessions.set(id, {
        user: identity,
        context: result.context ?? null,
        expiresAt: Date.now() + sessionTtlMs,
      });
      void persist();
      const guestOf = safeGuestOf(result.guestOf);
      json(response, 200, {
        ok: true,
        user: identity,
        landing: safePath(result.landing),
        ...(guestOf ? { guestOf } : {}),
      }, {
        "set-cookie": COOKIE + "=" + id + "; " + cookieAttributes,
      });
      return true;
    }
    if (pathname === "/api/auth/change-password") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" }, { allow: "POST" });
        return true;
      }
      if (!originAllowed(request, originPolicy)) {
        json(response, 403, { error: "请求来源无效" });
        return true;
      }
      const currentSession = readSession(request);
      if (!currentSession || !(await sessionIsValid(request))) {
        json(response, 401, { error: "登录状态已失效，请重新登录" });
        return true;
      }
      let body;
      try {
        body = await bodyJson(request);
      } catch (error) {
        json(response, error.status || 400, { error: error.message || "请求格式错误" });
        return true;
      }
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      if ([...newPassword].length < 12 || newPassword.length > 1024) {
        json(response, 400, { error: "新密码长度必须为 12 至 1024 个字符" });
        return true;
      }
      if (typeof provider?.changePassword !== "function") {
        json(response, 503, { error: "当前认证服务不支持修改密码" });
        return true;
      }
      let result;
      try {
        result = await provider.changePassword(currentSession.user.id, currentPassword, newPassword);
      } catch {
        json(response, 502, { error: "密码暂时无法更新，请稍后重试" });
        return true;
      }
      if (!result?.ok) {
        const status = result?.reason === "invalid" || result?.reason === "same" ? 400 : 401;
        const message = result?.reason === "same" ? "新密码不能与当前密码相同"
          : result?.reason === "invalid" ? "密码格式无效"
            : "当前密码错误";
        json(response, status, { error: message });
        return true;
      }
      const identity = safeUser(result.user);
      if (!identity) {
        json(response, 502, { error: "账户服务返回格式异常" });
        return true;
      }
      for (const [id, session] of sessions) {
        if (session.user.id === identity.id) sessions.delete(id);
      }
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, {
        user: identity,
        context: result.context ?? { credentialVersion: result.credentialVersion },
        expiresAt: Date.now() + sessionTtlMs,
      });
      void persist();
      json(response, 200, { ok: true, user: identity }, {
        "set-cookie": COOKIE + "=" + id + "; " + cookieAttributes,
      });
      return true;
    }
    if (pathname === "/api/auth/me") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed" }, { allow: "GET" });
        return true;
      }
      const session = (await sessionIsValid(request)) ? readSession(request) : null;
      json(response, session ? 200 : 401, session
        ? { ok: true, user: session.user }
        : { error: "未登录" });
      return true;
    }
    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" }, { allow: "POST" });
        return true;
      }
      if (!originAllowed(request, originPolicy)) {
        json(response, 403, { error: "请求来源无效" });
        return true;
      }
      const id = cookie(request);
      if (id && sessions.delete(id)) void persist();
      json(response, 200, { ok: true }, {
        "set-cookie": COOKIE + "=; " + cookieAttributes + "; Max-Age=0",
      });
      return true;
    }
    return false;
  }

  return Object.freeze({
    enabled: Boolean(provider),
    handle,
    hasSession,
    sessionIsValid,
    // Awaits any state write still in flight, so a shutdown cannot lose the
    // session or throttle changes made by the last requests.
    async flush() {
      await pendingPersist;
    },
    async currentUser(request) {
      return (await sessionIsValid(request)) ? readSession(request)?.user ?? null : null;
    },
    mustChangePassword(request) {
      return readSession(request)?.user.mustChangePassword === true;
    },
  });
}
