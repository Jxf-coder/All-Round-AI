import { randomBytes } from "node:crypto";

const COOKIE = "all_round_ai_session";
const MAX_BODY = 16 * 1024;

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error("请求格式错误");
    error.status = 400;
    throw error;
  }
}

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

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && parsed.host.toLowerCase() === String(request.headers.host || "").toLowerCase()
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
  const sessions = new Map();
  const hasSession = (request) => {
    const id = cookie(request);
    return Boolean(id && sessions.has(id));
  };

  async function handle(request, response) {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/auth/status") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed" }, { allow: "GET" });
      } else {
        json(response, 200, { configured: Boolean(provider) });
      }
      return true;
    }
    if (pathname === "/api/auth/login") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" }, { allow: "POST" });
        return true;
      }
      if (!originAllowed(request)) {
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
        json(response, status, { error: error || "账号或密码错误" });
        return true;
      }
      const identity = safeUser(result.user);
      if (!identity) {
        json(response, 502, { error: "认证服务返回格式异常" });
        return true;
      }
      const id = randomBytes(32).toString("base64url");
      // Upstream session context stays server-side. This process-local store is for local testing only.
      sessions.set(id, { user: identity, context: result.context ?? null });
      const guestOf = safeGuestOf(result.guestOf);
      json(response, 200, {
        ok: true,
        user: identity,
        landing: safePath(result.landing),
        ...(guestOf ? { guestOf } : {}),
      }, {
        "set-cookie": COOKIE + "=" + id + "; Path=/; HttpOnly; SameSite=Lax",
      });
      return true;
    }
    if (pathname === "/api/auth/me") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed" }, { allow: "GET" });
        return true;
      }
      const id = cookie(request);
      const session = id ? sessions.get(id) : null;
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
      if (!originAllowed(request)) {
        json(response, 403, { error: "请求来源无效" });
        return true;
      }
      const id = cookie(request);
      if (id) sessions.delete(id);
      json(response, 200, { ok: true }, {
        "set-cookie": COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      });
      return true;
    }
    return false;
  }

  return Object.freeze({ enabled: Boolean(provider), handle, hasSession });
}
