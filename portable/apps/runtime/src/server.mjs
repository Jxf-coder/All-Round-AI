import { createServer } from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { createAppLogger } from "../../../packages/platform/src/logging.mjs";
import { createAccountProvider, createAccountStore } from "./accounts.mjs";
import { createAuthStateStore } from "./auth-state.mjs";
import { createLocalAuth } from "./auth.mjs";
import { createConversationStore } from "./conversations.mjs";
import { createMockAiProvider } from "./ai/mock-provider.mjs";
import { createRouter, json, readJsonBody } from "./router.mjs";

const DEFAULT_PORT = 3141;
const WORKBENCH_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// Client-side routes rendered inside the workbench shell. These paths have no
// dedicated static file and must fall back to workbench.html so the frontend
// router can take over. Extend this list as pages are ported.
const CLIENT_ROUTE_PREFIXES = ["/workbench"];

function isClientRoute(pathname) {
  return CLIENT_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isProtectedPage(pathname) {
  return pathname === "/" || isClientRoute(pathname) || pathname === "/workbench.html"
    || pathname === "/change-password";
}

function isPublicAuthAsset(pathname) {
  return pathname === "/login.css" || pathname === "/login.js" || pathname === "/change-password.js";
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("Port must be an integer between 0 and 65535");
  }
  return port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function serveWorkbench(ctx) {
  const { request, response, url } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = url.pathname;
  if (pathname === "/login/") {
    response.writeHead(308, {
      "cache-control": "no-store",
      location: `/login${url.search}`,
    });
    response.end();
    return true;
  }
  const relative = pathname === "/" || isClientRoute(pathname)
    ? "workbench.html"
    : pathname === "/login" || pathname === "/login/"
      ? "login.html"
      : pathname === "/change-password"
        ? "change-password.html"
      : decodeURIComponent(pathname.slice(1));
  const target = path.resolve(WORKBENCH_ROOT, relative);
  if (target !== WORKBENCH_ROOT && !target.startsWith(`${WORKBENCH_ROOT}${path.sep}`)) {
    response.writeHead(404);
    response.end();
    return true;
  }
  try {
    const body = await readFile(target);
    const type = CONTENT_TYPES.get(path.extname(target).toLowerCase());
    if (!type) {
      response.writeHead(404);
      response.end();
      return true;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": CONTENT_SECURITY_POLICY,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    response.writeHead(404);
    response.end();
  }
  return true;
}

function redirect(response, location, status = 302) {
  response.writeHead(status, { "cache-control": "no-store", location });
  response.end();
}

export async function startLocalRuntime(options = {}) {
  const env = options.env ?? process.env;
  const port = parsePort(options.port ?? env.ALLROUND_AI_PORT ?? DEFAULT_PORT);
  const directories = await ensureAppDirectories(options);
  const logger = createAppLogger(path.join(directories.logs, "runtime.jsonl"));
  const accountStore = options.accountStore ?? await createAccountStore(path.join(directories.config, "accounts.json"));
  // Session and login-throttle state is hydrated from disk so a restart no
  // longer signs everyone out or clears the login throttle.
  const authStateStore = options.authStateStore
    ?? createAuthStateStore(path.join(directories.config, "auth-state.json"));
  const authState = await authStateStore.load();
  const auth = createLocalAuth({
    provider: options.authProvider ?? createAccountProvider(accountStore),
    sessionTtlMs: options.authSessionTtlMs,
    loginFailureLimit: options.loginFailureLimit,
    loginFailureWindowMs: options.loginFailureWindowMs,
    now: options.authNow,
    stateStore: authStateStore,
    initialState: authState,
    onPersistError: (error) => {
      void logger.warn("Auth state could not be written", { message: error.message });
    },
  });
  const aiProvider = options.aiProvider ?? createMockAiProvider();
  const conversationStore = options.conversationStore
    ?? await createConversationStore(path.join(directories.config, "conversations.json"));

  // Every authenticated API shares the same gate: a valid session, and a
  // completed first-login password change. Handlers stay free of auth details.
  async function requireActor(ctx) {
    const actor = await auth.currentUser(ctx.request);
    if (!actor) {
      json(ctx.response, 401, { error: "请先登录" });
      return null;
    }
    if (auth.mustChangePassword(ctx.request)) {
      json(ctx.response, 403, { error: "请先修改初始密码" });
      return null;
    }
    return actor;
  }

  async function readOptionalJsonBody(ctx) {
    if (!ctx.request.headers["content-type"]) return {};
    return readJsonBody(ctx.request);
  }

  const router = createRouter({ fallback: guardedWorkbench });

  // Page-level guards run after API routes and before static files, matching
  // the original dispatch order: an authenticated API handler must be able to
  // answer its own 401/403 instead of being replaced by a page redirect.
  async function guardedWorkbench(ctx) {
    const pathname = ctx.url.pathname;
    if (auth.enabled && isProtectedPage(pathname) && !(await auth.sessionIsValid(ctx.request))) {
      redirect(ctx.response, `/login?next=${encodeURIComponent(pathname + ctx.url.search)}`);
      return true;
    }
    if (auth.enabled && auth.mustChangePassword(ctx.request)
      && pathname !== "/change-password" && !isPublicAuthAsset(pathname)) {
      redirect(ctx.response, `/change-password?next=${encodeURIComponent(pathname + ctx.url.search)}`);
      return true;
    }
    return serveWorkbench(ctx);
  }

  // Health check stays first and unauthenticated, matching the original order.
  router.use((ctx) => {
    if (ctx.request.method === "GET" && ctx.url.pathname === "/health") {
      json(ctx.response, 200, { service: "all-round-ai", status: "ok" });
      return true;
    }
  });

  // Normalise the change-password trailing slash before authentication, so
  // deep links are redirected early and never dip into protected-page logic.
  router.use((ctx) => {
    if ((ctx.request.method === "GET" || ctx.request.method === "HEAD")
      && ctx.url.pathname === "/change-password/") {
      redirect(ctx.response, `/change-password${ctx.url.search}`, 308);
      return true;
    }
  });

  // Authentication endpoints (/api/auth/*) are self-dispatching.
  router.use((ctx) => auth.handle(ctx.request, ctx.response));

  // Admin API routes. New /api/* routes are registered here as stage 2 grows;
  // this replaces the previous inline if-else chain.
  router.get("/api/admin/accounts", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    if (actor.role !== "admin") {
      json(ctx.response, 403, { error: "没有管理员权限" });
      return true;
    }
    const accounts = await accountStore.list();
    json(ctx.response, 200, { accounts });
    return true;
  });

  // AI capability surface. Providers are pluggable: the default is a full mock,
  // and a real Trae provider will be swapped in here later without UI changes.
  router.get("/api/ai/models", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    json(ctx.response, 200, { provider: aiProvider.id, models: await aiProvider.listModels() });
    return true;
  });

  router.post("/api/ai/chat", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readJsonBody(ctx.request);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    try {
      const result = await aiProvider.chat({
        model: body.model,
        messages: body.messages,
        signal: ctx.signal,
      });
      if (!ctx.response.destroyed) json(ctx.response, 200, result);
    } catch (error) {
      // The client may already be gone when a cancellation lands; writing to a
      // destroyed response would throw, so the reply is skipped in that case.
      if (!ctx.response.destroyed) {
        // 499 mirrors the "client closed request" convention used by proxies.
        json(ctx.response, error.name === "AbortError" ? 499 : 502,
          error.name === "AbortError" ? { error: "请求已取消" } : { error: "AI 服务暂时不可用" });
      }
    }
    return true;
  });

  // Streaming variant. Emits Server-Sent Events so the workbench can render
  // tokens as they arrive. Aborts propagate through the request signal, which
  // cancels the underlying provider generator.
  router.post("/api/ai/chat/stream", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readJsonBody(ctx.request);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const { response } = ctx;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
      "connection": "keep-alive",
    });
    const send = (payload) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    try {
      for await (const chunk of aiProvider.streamChat({
        model: body.model,
        messages: body.messages,
        signal: ctx.signal,
      })) {
        if (chunk.delta) send({ delta: chunk.delta });
        if (chunk.finishReason) send({ finishReason: chunk.finishReason });
      }
    } catch (error) {
      if (error.name !== "AbortError") send({ error: "AI 服务暂时不可用" });
    }
    if (!response.destroyed) response.end();
    return true;
  });

  // Conversation history. Documents are scoped to the signed-in account so one
  // user can never read or mutate another user's conversations.
  router.get("/api/conversations", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    json(ctx.response, 200, { conversations: await conversationStore.list(String(actor.id)) });
    return true;
  });

  router.post("/api/conversations", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const conversation = await conversationStore.create(String(actor.id), { title: body.title });
    json(ctx.response, 201, { conversation });
    return true;
  });

  router.get("/api/conversations/:id", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    const conversation = await conversationStore.get(String(actor.id), ctx.params.id);
    if (!conversation) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    json(ctx.response, 200, { conversation });
    return true;
  });

  router.post("/api/conversations/:id/messages", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readJsonBody(ctx.request);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    let message;
    try {
      message = await conversationStore.appendMessage(String(actor.id), ctx.params.id, {
        role: body.role,
        content: body.content,
      });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "消息格式错误" });
      return true;
    }
    if (!message) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    json(ctx.response, 201, { message });
    return true;
  });

  router.delete("/api/conversations/:id", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    const removed = await conversationStore.remove(String(actor.id), ctx.params.id);
    json(ctx.response, removed ? 200 : 404, removed ? { ok: true } : { error: "对话不存在" });
    return true;
  });

  const server = createServer((request, response) => {
    void (async () => {
      const handled = await router.dispatch(request, response, { logger, auth, accountStore });
      if (!handled && !response.headersSent) {
        json(response, 404, { error: "Not found" });
      }
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      void logger.error("Request failed", { message: error.message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  await logger.info("Local runtime started", { port: address.port });

  let closePromise;
  return Object.freeze({
    address,
    directories,
    url,
    close() {
      closePromise ??= closeServer(server).then(async () => {
        // The listener is down, so no further state changes can arrive; flush
        // the last session/throttle write before reporting a clean stop.
        await auth.flush();
        await logger.info("Local runtime stopped", { port: address.port });
      });
      return closePromise;
    },
  });
}