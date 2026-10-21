import { createServer } from "node:http";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { createAppLogger } from "../../../packages/platform/src/logging.mjs";
import { runDataMigrations } from "../../../packages/platform/src/migrations.mjs";
import { RUNTIME_SCHEMA_MIGRATIONS } from "./migrations.mjs";
import { createAccountProvider, createAccountStore } from "./accounts.mjs";
import { createAuthStateStore } from "./auth-state.mjs";
import { createLocalAuth } from "./auth.mjs";
import { createConfigStore } from "./config-store.mjs";
import { createConversationStore } from "./conversations.mjs";
import { createDeviceRegistry, readDeviceToken } from "./devices.mjs";
import { createDeviceChannel } from "./device-channel.mjs";
import { loadOrCreateMasterKey } from "./master-key.mjs";
import { createProjectStore } from "./projects.mjs";
import { buildMemoryBlock, createMemoryStore } from "./memory.mjs";
import { buildKnowledgeBlock, createKnowledgeStore } from "./knowledge.mjs";
import { createHandover, latestHandover, readHandover } from "./handover.mjs";
import { forbiddenTerms, cleanIntake, DEFAULT_CATEGORIES, standardCardBody } from "./intake.mjs";
import { createSourceStore, resolveScoutRoot } from "./sources.mjs";
import { createScoutStore, detectSensitive, readCandidateText } from "./scout.mjs";
import {
  DISTILL_MAX_FILES,
  buildDistillPrompt as buildKnowledgeDistillPrompt,
  filterGroundedDrafts,
  parseDistillReply as parseKnowledgeDistillReply,
} from "./distill.mjs";
import { createMockAiProvider } from "./ai/mock-provider.mjs";
import { createOllamaProvider } from "./ai/ollama-provider.mjs";
import { createAiSettings } from "./ai/settings.mjs";
import { selectContextMessages } from "./ai/context.mjs";
import { TERMINAL_TURN_STATUSES, createTurnManager } from "./ai/turns.mjs";
import { describeEfforts, normalizeEffort, suggestEffort } from "./ai/effort.mjs";
import {
  buildDistillPrompt,
  buildSoulPrompt,
  cleanSoulDraft,
  formatCardsForSoul,
  parseDistillReply,
} from "./ai/memory-generate.mjs";
import { createProviderRegistry } from "./ai/registry.mjs";
import { createRouter, json, readJsonBody } from "./router.mjs";
import { displayHost, resolveRuntimeConfiguration } from "./runtime-profile.mjs";

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
  // `local` and `server` are two configurations of one application. Remote
  // exposure stays opt-in, and TLS proxy settings only change cookie/origin
  // behaviour — never a business branch.
  const runtimeConfig = resolveRuntimeConfiguration({
    profile: options.profile ?? env.ALLROUND_AI_PROFILE,
    host: options.host ?? env.ALLROUND_AI_HOST,
    secureCookies: options.secureCookies ?? env.ALLROUND_AI_SECURE_COOKIES,
    allowedOrigins: options.allowedOrigins ?? env.ALLROUND_AI_ALLOWED_ORIGINS,
    allowRemote: options.allowRemote ?? env.ALLROUND_AI_ALLOW_REMOTE,
  });
  const directories = await ensureAppDirectories(options);
  // The default source root is a plain folder users can drop files into; it is
  // created up front so the first scout run does not fail on a missing path.
  await mkdir(path.join(directories.data, "imports"), { recursive: true });
  const logger = createAppLogger(path.join(directories.logs, "runtime.jsonl"));
  // Migrations run before any store opens a document: the stores are
  // fail-closed, so reading an older shape first would make the instance
  // refuse to start instead of upgrading it.
  const migration = await runDataMigrations({
    dataDir: directories.data,
    migrations: RUNTIME_SCHEMA_MIGRATIONS,
  });
  if (migration.applied.length > 0) {
    await logger.info("Data schema migrated", {
      schemaVersion: migration.schemaVersion,
      applied: migration.applied.map((entry) => entry.version),
      backupDirectory: migration.backupDirectory,
    });
  }
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
    secureCookies: runtimeConfig.secureCookies,
    allowedOrigins: runtimeConfig.allowedOrigins,
    allowRemoteOrigin: runtimeConfig.allowRemoteOrigin,
    onPersistError: (error) => {
      void logger.warn("Auth state could not be written", { message: error.message });
    },
  });
  // Engines are providers. The registry keeps the switch honest: the default
  // provider owns the installation-wide model setting, while any additional
  // engine runs on its first advertised model until it gains its own settings.
  // Ollama is opt-in: without a URL the install stays on the mock and never
  // waits for a local service that may not exist.
  const ollamaUrl = options.ollamaUrl ?? env.ALLROUND_AI_OLLAMA_URL ?? env.OLLAMA_HOST;
  let configuredProviders;
  if (options.aiProviders) {
    configuredProviders = options.aiProviders;
  } else if (options.aiProvider) {
    configuredProviders = [options.aiProvider];
  } else {
    configuredProviders = [createMockAiProvider()];
    if (typeof ollamaUrl === "string" && ollamaUrl.trim()) {
      configuredProviders.push(createOllamaProvider({ baseUrl: ollamaUrl }));
    }
  }
  const providerRegistry = options.providerRegistry ?? createProviderRegistry({
    providers: configuredProviders,
    defaultId: options.defaultEngine ?? env.ALLROUND_AI_ENGINE,
  });
  const defaultProvider = providerRegistry.get(providerRegistry.defaultId);
  // Settings hold the chosen model plus a provider credential, so they go
  // through the encrypting config store backed by a per-installation key.
  const configStore = options.configStore ?? await createConfigStore(
    path.join(directories.config, "settings.json"),
    { masterKey: await loadOrCreateMasterKey(path.join(directories.config, "master-key.json")) },
  );
  const aiSettings = options.aiSettings ?? createAiSettings({ configStore, provider: defaultProvider });
  const conversationStore = options.conversationStore
    ?? await createConversationStore(path.join(directories.config, "conversations.json"));
  // Projects scope the chat history, so every conversation lives in one.
  const projectStore = options.projectStore
    ?? await createProjectStore(path.join(directories.config, "projects.json"));
  const memoryStore = options.memoryStore
    ?? await createMemoryStore(path.join(directories.config, "memory.json"));
  const knowledgeStore = options.knowledgeStore
    ?? await createKnowledgeStore(path.join(directories.config, "knowledge.json"));
  // Source roots and scout runs are installation-wide: a mounted share is the
  // same share for every project, and scout history is not project knowledge.
  const sourceStore = options.sourceStore
    ?? await createSourceStore(path.join(directories.config, "sources.json"), {
      defaultRoots: [path.join(directories.data, "imports")],
    });
  const scoutStore = options.scoutStore
    ?? await createScoutStore(path.join(directories.config, "scout.json"));
  // Handover bundles are exports, not live state, so they live beside config
  // rather than inside it. The directory is created on first export.
  const handoverDirectory = options.handoverDirectory ?? path.join(directories.data, "handover");
  // In-flight chat turns outlive the request that started them, so they get
  // their own log. Recovery closes turns that were running when the previous
  // process exited, instead of leaving them "running" forever.
  const turnStore = options.turnStore
    ?? createTurnManager({ filePath: path.join(directories.config, "chat-turns.json") });
  await turnStore.recover();
  // Desk agents pair once with a short-lived ticket and then heartbeat with
  // their own token. Only token hashes are persisted.
  const deviceRegistry = options.deviceRegistry
    ?? await createDeviceRegistry({ filePath: path.join(directories.config, "devices.json") });
  // Commands travel over the agent's outbound long-poll, so the runtime never
  // needs an inbound port on the desk.
  const deviceChannel = options.deviceChannel ?? createDeviceChannel();

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

  // Resolves the engine a turn should run on. An explicit engine wins; an
  // unknown one falls back to the default, which is what a client that never
  // sends an engine gets too.
  async function resolveEngineModel(requestedEngine) {
    const engine = providerRegistry.resolve(requestedEngine);
    const provider = providerRegistry.get(engine);
    const model = engine === providerRegistry.defaultId
      ? await aiSettings.currentModel()
      // Additional engines have no installation-wide model setting yet, so they
      // run on the first model they advertise.
      : (await provider.listModels())[0]?.id ?? "";
    return { engine, provider, model };
  }

  const PAGE_PANELS = new Set(["agent", "mcp", "skills", "automation", "database", "ops"]);

  // Page context is a hint, never content: an unknown panel is dropped instead
  // of being stored and offered back later.
  function normalizePageContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const panel = typeof value.panel === "string" ? value.panel.trim() : "";
    if (!PAGE_PANELS.has(panel)) return null;
    const label = typeof value.label === "string" ? value.label.trim().slice(0, 80) : "";
    return { panel, label };
  }

  // Opens a Server-Sent Events response and returns a guarded writer. Writing
  // after the client is gone is skipped rather than thrown, because a turn
  // deliberately keeps running when its browser disconnects.
  function openEventStream(ctx) {
    const { response } = ctx;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    return (payload) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
  }

  // Replays a running turn from `after`, then streams it live. Resolves once the
  // turn reaches a terminal state or the client goes away.
  function followTurn(ctx, turnId, after, send) {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const settle = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      };
      unsubscribe = turnStore.subscribe(turnId, (event) => {
        send(event);
        if (event.done) settle();
      }, { after });
      // `subscribe` replays synchronously, so a finished turn is already done.
      const status = turnStore.statusOf(turnId);
      if (status === undefined || TERMINAL_TURN_STATUSES.includes(status)) settle();
      ctx.signal.addEventListener("abort", settle, { once: true });
    });
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

  // Desk devices. Pairing is the only unauthenticated surface: the single-use
  // ticket is the credential, and the device token it returns is never stored
  // in plain text. Listing and revoking stay behind the normal account gate.
  router.get("/api/devices", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    json(ctx.response, 200, { devices: await deviceRegistry.list() });
    return true;
  });

  router.post("/api/devices/tickets", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    if (actor.role !== "admin") {
      json(ctx.response, 403, { error: "没有管理员权限" });
      return true;
    }
    json(ctx.response, 201, deviceRegistry.issueTicket({ actorId: actor.id }));
    return true;
  });

  router.post("/api/devices/pair", async (ctx) => {
    try {
      const body = await readJsonBody(ctx.request, { maxBytes: 8 * 1024 });
      const result = await deviceRegistry.pair({
        ticket: body.ticket,
        name: body.name,
        platform: body.platform,
        version: body.version,
        capabilities: body.capabilities,
      });
      json(ctx.response, 201, result);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "配对失败" });
    }
    return true;
  });

  router.post("/api/devices/heartbeat", async (ctx) => {
    const token = readDeviceToken(ctx.request);
    if (!token) {
      json(ctx.response, 401, { error: "缺少设备凭据" });
      return true;
    }
    try {
      const body = await readOptionalJsonBody(ctx, { maxBytes: 8 * 1024 });
      const device = await deviceRegistry.heartbeat({
        token,
        version: body.version,
        capabilities: body.capabilities,
      });
      json(ctx.response, 200, { device });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "心跳失败" });
    }
    return true;
  });

  // The agent long-polls for one command at a time and posts the result back.
  router.get("/api/devices/commands", async (ctx) => {
    const token = readDeviceToken(ctx.request);
    if (!token) {
      json(ctx.response, 401, { error: "缺少设备凭据" });
      return true;
    }
    try {
      const device = await deviceRegistry.authenticate({ token });
      const requested = Number(ctx.url.searchParams.get("wait") ?? "10000");
      const waitMs = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1_000), 30_000)
        : 10_000;
      const command = await deviceChannel.take({ deviceId: device.id, waitMs });
      json(ctx.response, 200, {
        command: command
          ? { id: command.id, type: command.type, payload: command.payload }
          : null,
      });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "读取命令失败" });
    }
    return true;
  });

  router.post("/api/devices/commands/:id/result", async (ctx) => {
    const token = readDeviceToken(ctx.request);
    if (!token) {
      json(ctx.response, 401, { error: "缺少设备凭据" });
      return true;
    }
    try {
      const device = await deviceRegistry.authenticate({ token });
      const body = await readJsonBody(ctx.request, { maxBytes: 1024 * 1024 });
      const accepted = deviceChannel.complete({
        deviceId: device.id,
        commandId: ctx.params.id,
        ok: body.ok === true,
        result: body.result,
        error: body.error,
      });
      json(ctx.response, 202, { accepted });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "回传结果失败" });
    }
    return true;
  });

  // Requiring a device id keeps typos from waiting out the command timeout.
  router.post("/api/devices/:id/commands", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    if (actor.role !== "admin") {
      json(ctx.response, 403, { error: "没有管理员权限" });
      return true;
    }
    try {
      const devices = await deviceRegistry.list();
      if (!devices.some((device) => device.id === ctx.params.id)) {
        json(ctx.response, 404, { error: "设备不存在" });
        return true;
      }
      const body = await readJsonBody(ctx.request, { maxBytes: 8 * 1024 });
      if (!["files.list", "files.read"].includes(body.type)) {
        json(ctx.response, 400, { error: "不支持的命令类型" });
        return true;
      }
      const target = body.path;
      if (typeof target !== "string" || target.trim() === "" || target.length > 4096
        || /[\r\n\0]/u.test(target)) {
        json(ctx.response, 400, { error: "路径无效" });
        return true;
      }
      const { wait } = deviceChannel.enqueue({
        deviceId: ctx.params.id,
        type: body.type,
        payload: { path: target },
      });
      const result = await wait;
      json(ctx.response, 200, { ok: true, result });
    } catch (error) {
      const status = error.code === "TIMEOUT" ? 504 : error.code === "BUSY" ? 429 : error.status || 400;
      json(ctx.response, status, { error: error.message || "命令失败" });
    }
    return true;
  });

  router.delete("/api/devices/:id", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    if (actor.role !== "admin") {
      json(ctx.response, 403, { error: "没有管理员权限" });
      return true;
    }
    try {
      const removed = await deviceRegistry.revoke(ctx.params.id);
      if (!removed) {
        json(ctx.response, 404, { error: "设备不存在" });
        return true;
      }
      json(ctx.response, 200, { removed: true });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "移除失败" });
    }
    return true;
  });

  // AI capability surface. Providers are pluggable: the default is a full mock,
  // and a real Trae provider will be swapped in here later without UI changes.
  router.get("/api/ai/models", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    // The engine list and effort levels travel with the models so the composer
    // renders from one source of truth instead of a second hard-coded copy.
    const engine = providerRegistry.resolve(ctx.url.searchParams.get("engine"));
    const provider = providerRegistry.get(engine);
    json(ctx.response, 200, {
      provider: engine,
      engines: providerRegistry.list(),
      models: await provider.listModels(),
      efforts: describeEfforts(),
    });
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
      const { provider, model } = await resolveEngineModel(body.engine);
      const result = await provider.chat({
        // An explicit model wins; otherwise the engine's default is the model.
        model: typeof body.model === "string" && body.model ? body.model : model,
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
  // tokens as they arrive. The turn is owned by the runtime rather than by this
  // connection: a refresh no longer cancels the answer, and only an explicit
  // cancel (POST /api/ai/chat/cancel) stops it, keeping the partial reply.
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
    const clientTurnId = typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId.slice(0, 80)
      : null;
    const retry = body.retry === true;

    // A resent request (same clientTurnId) is answered from the turn it already
    // started instead of generating a second reply and duplicating the question.
    if (clientTurnId) {
      const existing = await turnStore.findByClientTurnId({ ownerId, conversationId, clientTurnId });
      if (existing) {
        const send = openEventStream(ctx);
        send({
          meta: {
            turnId: existing.id,
            conversationId,
            clientTurnId,
            status: existing.status,
            effort: existing.effort,
            fast: existing.fast,
            engine: existing.engine,
            citations: existing.citations ?? [],
          },
        });
        if (TERMINAL_TURN_STATUSES.includes(existing.status)) {
          if (existing.text) send({ delta: existing.text });
          send({ done: true, status: existing.status, cancelled: existing.status === "cancelled" });
          if (!ctx.response.destroyed) ctx.response.end();
          return true;
        }
        await followTurn(ctx, existing.id, 0, send);
        if (!ctx.response.destroyed) ctx.response.end();
        return true;
      }
    }

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
    // Answer provenance: only cards that actually fed this turn are recorded,
    // so the reader can audit where the reply came from.
    const citations = cards.map((card) => ({ id: card.id, title: card.title, kind: card.kind }));
    if (messages.at(-1)?.role !== "user") {
      json(ctx.response, 400, { error: "没有可回复的消息" });
      return true;
    }

    // Thinking effort is chosen per turn. An explicit level wins; otherwise the
    // runtime picks one for the question ("自动"), which the composer shows back
    // to the user once the reply starts.
    const requestedEffort = typeof body.effort === "string" && body.effort.trim() ? body.effort : null;
    const effort = requestedEffort
      ? normalizeEffort(requestedEffort)
      : suggestEffort(question);
    const fast = body.fast === true;
    const { engine, provider, model } = await resolveEngineModel(body.engine);

    const turn = await turnStore.begin({
      ownerId,
      conversationId,
      projectId,
      clientTurnId,
      effort,
      fast,
      engine,
      citations,
    });
    const send = openEventStream(ctx);
    send({
      meta: {
        turnId: turn.id,
        conversationId,
        clientTurnId,
        status: "running",
        engine,
        model,
        effort,
        fast,
        citations,
      },
    });

    let answer = "";
    let outcome = "done";
    try {
      // Stage events drive the composer's live hint; they are not part of the
      // reply text, matching how the reference client treats them.
      send({ stage: true, status: "正在读取项目上下文与知识" });
      for await (const chunk of provider.streamChat({
        model,
        messages,
        effort,
        fast,
        // The turn's own signal, not the request's: a client disconnect must not
        // stop the reply.
        signal: turnStore.signalFor(turn.id),
      })) {
        if (chunk.delta) {
          answer += chunk.delta;
          turnStore.append(turn.id, { delta: chunk.delta });
          send({ delta: chunk.delta });
        }
        if (chunk.finishReason) {
          turnStore.append(turn.id, { finishReason: chunk.finishReason });
          send({ finishReason: chunk.finishReason });
        }
      }
    } catch (error) {
      if (error.name === "AbortError" || turnStore.isCancelled(turn.id)) outcome = "cancelled";
      else {
        outcome = "error";
        send({ error: "AI 服务暂时不可用" });
      }
    }
    // A partial reply is kept: stopping should not throw away what the user
    // already read. Because the turn outlives this connection, the answer is
    // stored even when the browser is already gone.
    if (answer.trim()) {
      try {
        await conversationStore.appendMessage(ownerId, conversationId, {
          role: "assistant",
          content: answer,
          citations,
        });
      } catch {
        // The conversation could have been deleted mid-stream; nothing to store.
      }
    }
    await turnStore.finish(turn.id, { status: outcome });
    send({ done: true, status: outcome, cancelled: outcome === "cancelled" });
    if (!ctx.response.destroyed) ctx.response.end();
    return true;
  });

  // Live turn surface. Without `stream=1` it answers with a JSON snapshot a
  // reattaching client uses to render what has been produced so far; with
  // `stream=1&after=<seq>` it replays buffered events and then follows the turn.
  router.get("/api/ai/chat/live", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    const ownerId = String(actor.id);
    const conversationId = ctx.url.searchParams.get("conversationId") ?? "";
    if (!conversationId) {
      json(ctx.response, 400, { error: "缺少 conversationId" });
      return true;
    }
    if (!(await conversationStore.get(ownerId, conversationId))) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    const turn = await turnStore.latestFor(ownerId, conversationId);
    if (ctx.url.searchParams.get("stream") !== "1") {
      json(ctx.response, 200, { turn: turn ?? null });
      return true;
    }
    const parsed = Number.parseInt(ctx.url.searchParams.get("after") ?? "0", 10);
    const after = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const send = openEventStream(ctx);
    if (!turn) {
      send({ done: true, status: "idle" });
      ctx.response.end();
      return true;
    }
    send({
      meta: {
        turnId: turn.id,
        conversationId,
        status: turn.status,
        effort: turn.effort,
        fast: turn.fast,
        engine: turn.engine,
      },
    });
    if (TERMINAL_TURN_STATUSES.includes(turn.status)) {
      send({ done: true, status: turn.status });
      ctx.response.end();
      return true;
    }
    await followTurn(ctx, turn.id, after, send);
    if (!ctx.response.destroyed) ctx.response.end();
    return true;
  });

  // Stopping is an explicit cancel of the turn rather than a socket close, so
  // the partial answer is kept and every attached client sees the terminal
  // state.
  router.post("/api/ai/chat/cancel", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
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
    if (!(await conversationStore.get(ownerId, conversationId))) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    const requested = typeof body.turnId === "string" && body.turnId ? body.turnId : null;
    const turnId = requested ?? (await turnStore.latestFor(ownerId, conversationId))?.id ?? null;
    json(ctx.response, 200, { ok: true, cancelled: turnId ? turnStore.cancel(turnId) : false });
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

  // Distilled memory waits in a confirmation queue: `add` appends candidates,
  // `confirm` moves one into MEMORY.md, `discard` drops it. Only confirmed
  // entries are injected into a chat turn.
  router.post("/api/memory/pending", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
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
    let result;
    try {
      if (body.action === "add") {
        result = await memoryStore.addPending(projectId, body.items);
      } else if (body.action === "confirm") {
        result = await memoryStore.confirmPending(projectId, body.id, {
          kind: body.kind,
          text: body.text,
        });
      } else if (body.action === "discard") {
        result = await memoryStore.discardPending(projectId, body.id);
      } else {
        json(ctx.response, 400, { error: "未知 action" });
        return true;
      }
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "记忆条目处理失败" });
      return true;
    }
    if (!result) {
      json(ctx.response, 404, { error: "记忆条目不存在" });
      return true;
    }
    json(ctx.response, 200, result);
    return true;
  });

  // Distilling a conversation proposes candidate memories; it never confirms
  // them. The provider is asked once and its reply must parse into entries,
  // otherwise nothing is queued and the client gets a clear error.
  router.post("/api/memory/distill", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx, { maxBytes: 32 * 1024 });
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!conversationId) {
      json(ctx.response, 400, { error: "缺少 conversationId" });
      return true;
    }
    const conversation = await conversationStore.get(String(actor.id), conversationId);
    if (!conversation) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    const projectId = conversation.projectId ?? await projectStore.defaultRootId();
    const { provider, model } = await resolveEngineModel(body.engine);
    let reply;
    try {
      reply = await provider.chat({
        model,
        messages: [{ role: "user", content: buildDistillPrompt(conversation.messages) }],
        effort: "low",
        fast: true,
        signal: ctx.signal,
      });
    } catch {
      json(ctx.response, 502, { error: "AI 服务暂时不可用" });
      return true;
    }
    const items = parseDistillReply(reply?.content ?? "");
    if (items.length === 0) {
      json(ctx.response, 422, { error: "模型没有返回可用的记忆条目" });
      return true;
    }
    try {
      const before = await memoryStore.get(projectId);
      const state = await memoryStore.addPending(projectId, items);
      json(ctx.response, 200, {
        queued: true,
        added: Math.max(0, state.pending.length - before.pending.length),
        conversationId,
        projectId,
        ...state,
      });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "记忆提炼失败" });
    }
    return true;
  });

  // SOUL generation returns a draft only. Saving stays an explicit action so a
  // model cannot overwrite a person's persona on its own.
  router.post("/api/memory/soul-draft", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const defaultProjectId = await projectStore.defaultRootId();
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : defaultProjectId;
    const project = await projectStore.get(projectId);
    if (!project) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const memory = await memoryStore.get(projectId);
    const knowledge = await knowledgeStore.list(projectId);
    const confirmed = knowledge.cards.filter((card) => card.status === "confirmed");
    const { provider, model } = await resolveEngineModel(body.engine);
    let reply;
    try {
      reply = await provider.chat({
        model,
        messages: [{
          role: "user",
          content: buildSoulPrompt({
            projectName: project.name,
            existingSoul: memory.soul,
            memory: memory.memory,
            cards: formatCardsForSoul(confirmed),
          }),
        }],
        effort: "low",
        fast: true,
        signal: ctx.signal,
      });
    } catch {
      json(ctx.response, 502, { error: "AI 服务暂时不可用" });
      return true;
    }
    try {
      json(ctx.response, 200, {
        draft: cleanSoulDraft(reply?.content ?? ""),
        existing: memory.soul,
      });
    } catch (error) {
      json(ctx.response, 422, { error: error.message || "人格初稿生成失败" });
    }
    return true;
  });

  // Project knowledge: 知识卡 and 缺口清单. The reference uses one action-based
  // POST for every mutation; that shape is kept here, but each response carries
  // the refreshed state so the UI does not need a follow-up read.
  router.get("/api/knowledge", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    const defaultProjectId = await projectStore.defaultRootId();
    const requested = ctx.url.searchParams.get("projectId");
    if (requested && !(await projectStore.get(requested))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const projectId = requested || defaultProjectId;
    // A single run is fetched by id for its report; the list stays small.
    const scoutId = ctx.url.searchParams.get("scout");
    if (scoutId) {
      const run = await scoutStore.get(projectId, scoutId);
      if (!run) {
        json(ctx.response, 404, { error: "没有这次巡读" });
        return true;
      }
      json(ctx.response, 200, { run });
      return true;
    }
    const [knowledge, sources, scouts] = await Promise.all([
      knowledgeStore.list(projectId),
      sourceStore.list(),
      scoutStore.list(projectId),
    ]);
    json(ctx.response, 200, {
      ...knowledge,
      sources: { ...sources, canEdit: actor.role === "admin" },
      scouts,
    });
    return true;
  });

  router.post("/api/knowledge", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
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
        case "intake":
          await knowledgeStore.setIntake(projectId, body.fields, actor.name);
          break;
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
        case "regressionAdd":
          await knowledgeStore.addRegressionQuestion(projectId, body.question);
          break;
        case "regressionRemove":
          missing = await knowledgeStore.removeRegressionQuestion(projectId, body.id) ? null : "回归题不存在";
          break;
        case "regressionRun": {
          const run = await knowledgeStore.runRegression(projectId, body.reason);
          if (!run) {
            json(ctx.response, 400, { error: "还没有回归题" });
            return true;
          }
          break;
        }
        case "sourcesSave":
          if (actor.role !== "admin") {
            json(ctx.response, 403, { error: "只有管理员可以修改来源目录" });
            return true;
          }
          await sourceStore.save(body.roots, actor.name);
          break;
        case "scoutRun": {
          const sourceState = await sourceStore.list();
          const root = await resolveScoutRoot(body.root, sourceState.roots);
          const intake = (await knowledgeStore.list(projectId)).intake;
          const run = await scoutStore.run({
            projectId,
            root,
            goal: body.goal,
            label: body.label,
            forbidden: forbiddenTerms(intake?.fields ?? null),
          });
          json(ctx.response, 200, { action: body.action, run, report: run.report });
          return true;
        }
        case "scoutDistill": {
          if (typeof body.runId !== "string" || !body.runId) {
            json(ctx.response, 400, { error: "请选择要提炼的巡读" });
            return true;
          }
          const run = await scoutStore.get(projectId, body.runId);
          if (!run) {
            json(ctx.response, 404, { error: "没有这次巡读" });
            return true;
          }
          if (run.kept.length === 0) {
            json(ctx.response, 400, { error: "这次巡读没有可提炼的候选文件" });
            return true;
          }
          const intake = (await knowledgeStore.list(projectId)).intake;
          const fields = cleanIntake(intake?.fields ?? {});
          const { provider, model } = await resolveEngineModel(body.engine);
          const summary = {
            at: new Date().toISOString(),
            files: 0,
            read: 0,
            cards: 0,
            merged: 0,
            dropped: 0,
            skipped: [],
            errors: [],
          };
          for (const file of run.kept.slice(0, DISTILL_MAX_FILES)) {
            summary.files += 1;
            let content;
            try {
              content = await readCandidateText(run.root, file.path);
            } catch (error) {
              summary.errors.push({ path: file.path, message: error.message || "读取失败" });
              continue;
            }
            const sensitive = detectSensitive(content.text);
            if (sensitive) {
              summary.skipped.push({ path: file.path, reason: sensitive });
              continue;
            }
            summary.read += 1;
            try {
              const reply = await provider.chat({
                model,
                messages: [{
                  role: "user",
                  content: buildKnowledgeDistillPrompt({
                    fileName: file.path,
                    text: content.text,
                    goal: run.goal,
                    product: fields.product,
                    categories: DEFAULT_CATEGORIES,
                    standard: standardCardBody(fields),
                    redLines: fields.redLines,
                    forbidden: forbiddenTerms(fields),
                  }),
                }],
                effort: "low",
                fast: true,
                signal: ctx.signal,
              });
              const drafts = parseKnowledgeDistillReply(reply?.content ?? "");
              const grounded = filterGroundedDrafts(drafts, content.text);
              summary.dropped += grounded.dropped;
              const result = await knowledgeStore.addExtractedCards(projectId, grounded.accepted, {
                source: file.path,
              });
              summary.cards += result.added.length;
              summary.merged += result.merged;
            } catch (error) {
              summary.errors.push({
                path: file.path,
                message: (error.message || "提炼失败").slice(0, 300),
              });
            }
          }
          const updated = await scoutStore.attachDistill(projectId, run.id, summary);
          json(ctx.response, 200, { action: body.action, run: updated, summary });
          return true;
        }
        default:
          json(ctx.response, 400, { error: "未知的 action" });
          return true;
      }
      if (missing) {
        json(ctx.response, 404, { error: missing });
        return true;
      }
      const [knowledge, sources, scouts] = await Promise.all([
        knowledgeStore.list(projectId),
        sourceStore.list(),
        scoutStore.list(projectId),
      ]);
      json(ctx.response, 200, {
        action: body.action,
        ...knowledge,
        sources: { ...sources, canEdit: actor.role === "admin" },
        scouts,
      });
    } catch (error) {
      json(ctx.response, 400, { error: error.message || "知识库操作失败" });
    }
    return true;
  });

  // Knowledge handover: one local JSON file containing cards, gaps, regression
  // questions and memory, so a person or another instance can take over
  // offline. Nothing is uploaded. A bundle that contains something shaped like
  // a credential is refused instead of being redacted silently — a handover
  // that quietly drops fields is worse than one that fails loudly.
  router.get("/api/handover/latest", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    const requested = ctx.url.searchParams.get("projectId");
    if (requested && !(await projectStore.get(requested))) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const info = await latestHandover(handoverDirectory);
    json(ctx.response, 200, {
      info: info && (!requested || info.projectId === requested) ? info : null,
    });
    return true;
  });

  router.post("/api/handover", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const defaultProjectId = await projectStore.defaultRootId();
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : defaultProjectId;
    const project = await projectStore.get(projectId);
    if (!project) {
      json(ctx.response, 404, { error: "项目不存在" });
      return true;
    }
    const [memory, knowledge] = await Promise.all([
      memoryStore.get(projectId),
      knowledgeStore.list(projectId),
    ]);
    try {
      const info = await createHandover({
        directory: handoverDirectory,
        project,
        memory,
        knowledge,
        generatedBy: String(actor.name ?? ""),
      });
      json(ctx.response, 200, { info });
    } catch (error) {
      if (error.code === "SECRET_DETECTED") {
        json(ctx.response, 409, { error: error.message });
        return true;
      }
      json(ctx.response, 500, { error: "交接包导出失败" });
    }
    return true;
  });

  // The file route only ever serves names that the export itself produces; the
  // pattern check is the path-traversal guard, so no path is joined first.
  router.get("/api/handover/:file", async (ctx) => {
    if (!(await requireActor(ctx))) return true;
    const body = await readHandover(handoverDirectory, ctx.params.file);
    if (!body) {
      json(ctx.response, 404, { error: "交接包不存在" });
      return true;
    }
    ctx.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${ctx.params.file}"`,
      "content-length": String(body.length),
      "x-content-type-options": "nosniff",
    });
    ctx.response.end(body);
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

  // Remembers which panel a conversation was last viewed in. Bookkeeping only:
  // it never changes message order or the conversation's updatedAt.
  router.post("/api/conversations/:id/context", async (ctx) => {
    const actor = await requireActor(ctx);
    if (!actor) return true;
    let body;
    try {
      body = await readOptionalJsonBody(ctx);
    } catch (error) {
      json(ctx.response, error.status || 400, { error: error.message || "请求格式错误" });
      return true;
    }
    const pageContext = normalizePageContext(body);
    if (!pageContext) {
      json(ctx.response, 400, { error: "页面上下文无效" });
      return true;
    }
    const saved = await conversationStore.setPageContext(String(actor.id), ctx.params.id, pageContext);
    if (!saved) {
      json(ctx.response, 404, { error: "对话不存在" });
      return true;
    }
    json(ctx.response, 200, { ok: true, pageContext: saved });
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
    server.listen({ host: runtimeConfig.host, port }, resolve);
  });

  const address = server.address();
  const url = `http://${displayHost(runtimeConfig.host)}:${address.port}`;
  await logger.info("Local runtime started", {
    port: address.port,
    profile: runtimeConfig.profile,
    host: runtimeConfig.host,
  });

  let closePromise;
  return Object.freeze({
    address,
    directories,
    profile: runtimeConfig.profile,
    schemaVersion: migration.schemaVersion,
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