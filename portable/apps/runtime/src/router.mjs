import { randomBytes } from "node:crypto";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// HTTP primitives shared across the runtime. These stay dependency-free and
// replace the scattered inline helpers that previously lived inside server.mjs
// and auth.mjs, so every handler can emit identical headers and error bodies.
// ---------------------------------------------------------------------------

export function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

export function text(response, status, value, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(value);
}

export async function readJsonBody(request, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
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

export function parseCookies(request) {
  const cookies = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = "";
    }
  }
  return cookies;
}

export function newRequestId() {
  return randomBytes(16).toString("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(pattern) {
  const names = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "*") {
        names.push("*");
        return "(.*)";
      }
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(segment);
    })
    .join("/");
  return { names, regex: new RegExp(`^${source}$`) };
}

// ---------------------------------------------------------------------------
// A small router. Semantics are uniform for middlewares and route handlers:
//   - return true  -> the response is complete, stop dispatching.
//   - return false / undefined -> not handled, keep going.
// Middlewares registered with `use` run in order before the first matching
// route. If no route matches (or every handler declined), the fallback runs.
// ---------------------------------------------------------------------------

export function createRouter({ fallback = null } = {}) {
  const middlewares = [];
  const routes = [];

  function register(method, pattern, handler) {
    if (typeof pattern !== "string" || !pattern.startsWith("/")) {
      throw new TypeError("Route patterns must be strings starting with '/'");
    }
    if (typeof handler !== "function") {
      throw new TypeError("A route handler function is required");
    }
    routes.push({ method: method.toUpperCase(), pattern, ...compilePattern(pattern), handler });
    return api;
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method.toUpperCase()) continue;
      const matched = pathname.match(route.regex);
      if (!matched) continue;
      const params = {};
      route.names.forEach((name, index) => {
        params[name === "*" ? "wildcard" : name] = decodeURIComponent(matched[index + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  function allowedMethods(pathname) {
    const methods = new Set();
    for (const route of routes) {
      if (route.regex.test(pathname)) methods.add(route.method);
    }
    return [...methods];
  }

  async function dispatch(request, response, context = {}) {
    const url = new URL(request.url, "http://127.0.0.1");
    const requestId = context.requestId ?? newRequestId();
    response.setHeader("x-request-id", requestId);
    const controller = new AbortController();
    if (typeof response.on === "function") response.on("close", () => controller.abort());
    const ctx = {
      ...context,
      request,
      response,
      url,
      query: url.searchParams,
      params: {},
      requestId,
      signal: controller.signal,
    };

    for (const middleware of middlewares) {
      if ((await middleware(ctx)) === true) return true;
    }

    const found = match(request.method, url.pathname);
    if (found) {
      ctx.params = found.params;
      if ((await found.handler(ctx)) === true) return true;
    } else {
      // A path that exists for other verbs yields a conventional 405 instead of
      // silently falling through to the static-file fallback.
      const methods = allowedMethods(url.pathname);
      if (methods.length > 0) {
        json(response, 405, { error: "Method not allowed" }, { allow: methods.join(", ") });
        return true;
      }
    }

    if (fallback && (await fallback(ctx)) === true) return true;
    return false;
  }

  const api = Object.freeze({
    dispatch,
    match,
    use(middleware) {
      if (typeof middleware !== "function") {
        throw new TypeError("A middleware function is required");
      }
      middlewares.push(middleware);
      return api;
    },
    get: (pattern, handler) => register("GET", pattern, handler),
    post: (pattern, handler) => register("POST", pattern, handler),
    put: (pattern, handler) => register("PUT", pattern, handler),
    patch: (pattern, handler) => register("PATCH", pattern, handler),
    delete: (pattern, handler) => register("DELETE", pattern, handler),
    head: (pattern, handler) => register("HEAD", pattern, handler),
    on: register,
  });

  return api;
}