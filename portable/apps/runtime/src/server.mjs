import { createServer } from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { createAppLogger } from "../../../packages/platform/src/logging.mjs";
import { createAccountProvider, createAccountStore } from "./accounts.mjs";
import { createAuthStateStore } from "./auth-state.mjs";
import { createLocalAuth } from "./auth.mjs";
import { createConfigStore } from "./config-store.mjs";
import { createConversationStore } from "./conversations.mjs";
import { loadOrCreateMasterKey } from "./master-key.mjs";
import { createProjectStore } from "./projects.mjs";
import { buildMemoryBlock, createMemoryStore } from "./memory.mjs";
import { buildKnowledgeBlock, createKnowledgeStore } from "./knowledge.mjs";
import { createMockAiProvider } from "./ai/mock-provider.mjs";
import { createAiSettings } from "./ai/settings.mjs";
import { selectContextMessages } from "./ai/context.mjs";
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
  // Settings hold the chosen model plus a provider credential, so they go
  // through the encrypting config store backed by a per-installation key.
  const configStore = options.configStore ?? await createConfigStore(
    path.join(directories.config, "settings.json"),
    { masterKey: await loadOrCreateMasterKey(path.join(directories.config, "master-key.json")) },
  );
  const aiSettings = options.aiSettings ?? createAiSettings({ configStore, provider: aiProvider });
  const conversationStore = options.conversationStore
    ?? await createConversationStore(path.join(directories.config, "conversations.json"));
  // Projects scope the chat history, so every conversation lives in one.
  const projectStore = options.projectStore
    ?? await createProjectStore(path.join(directories.config, "projects.json"));
  const memoryStore = options.memoryStore
    ?? await createMemoryStore(path.join(directories.config, "memory.json"));
  const knowledgeStore = options.knowledgeStore
    ?? await createKnowledgeStore(path.join(directories.config, "knowledge.json"));

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

  async function readOptionalJsonBody(ctx, options) {
    if (!ctx.request.headers["content-type"]) return {};
    return readJsonBody(ctx.request, options);
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

  // Model and credential settings. Everyone signed in can read them so the
  // workbench can label the active model; changing them is an admin action
  // because they are installation-wide.
  router.get("/api/settings/ai", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    json(ctx.response, 200, await aiSettings.describe());
    return true;
  });

  router.put("/api/settings/ai", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    if (actor.role !== "admin") {
      json(ctx.response, 403, { error: "没有管理员权限" });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(ctx.request);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    try {
      json(ctx.response, 200, await aiSettings.update({ model: body.model, apiKey: body.apiKey }));
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "设置无效" });
    }
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
        // An explicit model wins; otherwise the configured model is the default.
        model: typeof body.model === "string" && body.model ? body.model : await aiSettings.currentModel(),
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
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readJsonBody(ctx.request);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const ownerId = String(actor.id);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!conversationId) {
      json(ctx.response, 400, { error: "缺少 conversationId" });
      return true;
    }
    const retry = body.retry === true;
    if (retry) {
      // Regenerate the last answer: drop it first so the user turn is not
      // duplicated, then reply from the remaining history.
      const dropped = await conversationStore.dropTrailingAssistant(ownerId, conversationId);
      if (dropped === null) {
        json(ctx.response, 404, { error: "对话不存在" });
        return true;
      }
    } else {
      let appended;
      try {
        appended = await conversationStore.appendMessage(ownerId, conversationId, {
          role: "user",
          content: body.content,
        });
      } catch (error) {
        json(ctx.response, 400, { error: error.message || "消息格式错误" });
        return true;
      }
      if (!appended) {
        json(ctx.response, 404, { error: "对话不存在" });
        return true;
      }
    }

    // The stored conversation is the single source of truth for context, so the
    // client cannot disagree with what was actually said.
    const conversation = await conversationStore.get(ownerId, conversationId);
    const projectId = conversation.projectId ?? await projectStore.defaultRootId();
    const context = selectContextMessages(conversation.messages);
    const question = context.at(-1)?.content ?? "";
    // Knowledge is retrieved per turn: only cards that match this question are
    // replayed, and only confirmed ones (a pending proposal is not context yet).
    const [memory, cards] = await Promise.all([
      memoryStore.get(projectId),
      knowledgeStore.retrieve(projectId, question),
    ]);
    const block = [buildMemoryBlock(memory), buildKnowledgeBlock(cards)].filter(Boolean).join("\n\n");
    const messages = [...(block ? [{ role: "system", content: block }] : []), ...context];
    if (messages.at(-1)?.role !== "user") {
      json(ctx.response, 400, { error: "没有可回复的消息" });
      return true;
    }

    const { response } = ctx;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    const send = (payload) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    let answer = "";
    let cancelled = false;
    try {
      for await (const chunk of aiProvider.streamChat({
        model: await aiSettings.currentModel(),
        messages,
        signal: ctx.signal,
      })) {
        if (chunk.delta) {
          answer += chunk.delta;
          send({ delta: chunk.delta });
        }
        if (chunk.finishReason) send({ finishReason: chunk.finishReason });
      }
    } catch (error) {
      if (error.name === "AbortError") cancelled = true;
      else send({ error: "AI 服务暂时不可用" });
    }
    // A partial reply is kept: stopping should not throw away what the user
    // already read, and a cancelled turn stays inspectable.
    if (answer.trim()) {
      try {
        await conversationStore.appendMessage(ownerId, conversationId, { role: "assistant", content: answer });
      } catch {
        // The conversation could have been deleted mid-stream; nothing to store.
      }
    }
    send({ done: true, cancelled });
    if (!response.destroyed) response.end();
    return true;
  });

  // Projects (公司根项目 / 岗位 / 子岗位). They scope chat history; the reference
  // workbench additionally filters them by tenant and hired roles, which has no
  // portable equivalent yet, so every signed-in account sees the same tree.
  router.get("/api/projects", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    const [projects, tree, defaultProjectId] = await Promise.all([
      projectStore.list(),
      projectStore.tree(),
      projectStore.defaultRootId(),
    ]);
    json(ctx.response, 200, { projects, tree, defaultProjectId });
    return true;
  });

  router.post("/api/projects", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    try {
      const project = await projectStore.create({
        name: body.name,
        type: body.type ?? "root",
        parentId: typeof body.parentId === "string" && body.parentId ? body.parentId : null,
      });
      json(ctx.response, 201, { project });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "创建项目失败" });
    }
    return true;
  });

  // Agent memory (人格 SOUL.md / 长期记忆 MEMORY.md) is stored per project and
  // replayed into every chat turn of that project.
  router.get("/api/memory", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    const defaultProjectId = await projectStore.defaultRootId();
    const requested = ctx.url.searchParams.get("projectId");
    if (requested && !(await projectStore.get(requested))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const projectId = requested || defaultProjectId;
    json(ctx.response, 200, await memoryStore.get(projectId));
    return true;
  });

  // Saving mirrors the reference workbench, which posts to the same path it
  // reads from with both documents in the body.
  router.post("/api/memory", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      // Two long documents do not fit the shared 16 KiB request limit, so this
      // endpoint raises it; the per-document cap still bounds what is stored.
      body = await readOptionalJsonBody(ctx, { maxBytes: 128 * 1024 });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const defaultProjectId = await projectStore.defaultRootId();
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : defaultProjectId;
    if (!(await projectStore.get(projectId))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    try {
      json(ctx.response, 200, await memoryStore.save(projectId, { soul: body.soul, memory: body.memory }));
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "记忆保存失败" });
    }
    return true;
  });

  // Project knowledge: 知识卡 and 缺口清单. The reference uses one action-based
  // POST for every mutation; that shape is kept here, but each response carries
  // the refreshed state so the UI does not need a follow-up read.
  router.get("/api/knowledge", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    const defaultProjectId = await projectStore.defaultRootId();
    const requested = ctx.url.searchParams.get("projectId");
    if (requested && !(await projectStore.get(requested))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    json(ctx.response, 200, await knowledgeStore.list(requested || defaultProjectId));
    return true;
  });

  router.post("/api/knowledge", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx, { maxBytes: 64 * 1024 });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const defaultProjectId = await projectStore.defaultRootId();
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : defaultProjectId;
    if (!(await projectStore.get(projectId))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    try {
      let missing = null;
      switch (body.action) {
        case "card":
          await knowledgeStore.addCard(projectId, body);
          break;
        case "cardStatus":
          missing = await knowledgeStore.setCardStatus(projectId, body.id, body.status) ? null : "知识卡不存在";
          break;
        case "cardRemove":
          missing = await knowledgeStore.removeCard(projectId, body.id) ? null : "知识卡不存在";
          break;
        case "gapAdd":
          await knowledgeStore.addGap(projectId, body);
          break;
        case "gapClose":
          missing = await knowledgeStore.setGapStatus(projectId, body.id, "closed", body.note) ? null : "缺口不存在";
          break;
        case "gapReopen":
          missing = await knowledgeStore.setGapStatus(projectId, body.id, "open", body.note) ? null : "缺口不存在";
          break;
        default:
          json(ctx.response, 400, { error: "未知的 action" });
          return true;
      }
      if (missing) {
        json(ctx.response, 404, { error: missing });
        return true;
      }
      json(ctx.response, 200, { action: body.action, ...(await knowledgeStore.list(projectId)) });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "知识库操作失败" });
    }
    return true;
  });

  // Conversation history. Documents are scoped to the signed-in account so one
  // user can never read or mutate another user's conversations.
  router.get("/api/conversations", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    const defaultProjectId = await projectStore.defaultRootId();
    const requested = ctx.url.searchParams.get("projectId");
    if (requested && !(await projectStore.get(requested))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const projectId = requested || defaultProjectId;
    json(ctx.response, 200, {
      projectId,
      conversations: await conversationStore.list(String(actor.id), {
        projectId,
        unassignedProjectId: defaultProjectId,
      }),
    });
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
    const projectId = typeof body.projectId === "string" && body.projectId
      ? body.projectId
      : await projectStore.defaultRootId();
    if (!(await projectStore.get(projectId))) {
      json(ctx.response, 400, { error: "项目不存在" });
      return true;
    }
    let conversation;
    try {
      conversation = await conversationStore.create(String(actor.id), { title: body.title, projectId });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "创建对话失败" });
      return true;
    }
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