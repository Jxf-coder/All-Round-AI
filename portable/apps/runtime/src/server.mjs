import { createServer } from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { createAppLogger } from "../../../packages/platform/src/logging.mjs";
import { createAccountProvider, createAccountStore } from "./accounts.mjs";
import { createLocalAuth } from "./auth.mjs";

const DEFAULT_PORT = 3141;
const WORKBENCH_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

async function serveWorkbench(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname;
  if (pathname === "/login/") {
    response.writeHead(308, {
      "cache-control": "no-store",
      location: `/login${requestUrl.search}`,
    });
    response.end();
    return true;
  }
  const relative = pathname === "/"
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
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    response.writeHead(404);
    response.end();
  }
  return true;
}

function isProtectedPage(pathname) {
  return pathname === "/" || pathname === "/workbench" || pathname === "/workbench.html"
    || pathname.startsWith("/workbench/") || pathname === "/change-password";
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

export async function startLocalRuntime(options = {}) {
  const env = options.env ?? process.env;
  const port = parsePort(options.port ?? env.ALLROUND_AI_PORT ?? DEFAULT_PORT);
  const directories = await ensureAppDirectories(options);
  const logger = createAppLogger(path.join(directories.logs, "runtime.jsonl"));
  const accountStore = options.accountStore ?? await createAccountStore(path.join(directories.config, "accounts.json"));
  const auth = createLocalAuth({
    provider: options.authProvider ?? createAccountProvider(accountStore),
    sessionTtlMs: options.authSessionTtlMs,
  });

  const server = createServer((request, response) => {
    void (async () => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ service: "all-round-ai", status: "ok" }));
      return;
    }
    if (await auth.handle(request, response)) return;
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (auth.enabled && isProtectedPage(requestUrl.pathname) && !auth.hasSession(request)) {
      response.writeHead(302, { "cache-control": "no-store", location: "/login?next=" + encodeURIComponent(requestUrl.pathname + requestUrl.search) });
      response.end();
      return;
    }
    if (auth.enabled && auth.mustChangePassword(request) && requestUrl.pathname !== "/change-password") {
      response.writeHead(302, {
        "cache-control": "no-store",
        location: "/change-password?next=" + encodeURIComponent(requestUrl.pathname + requestUrl.search),
      });
      response.end();
      return;
    }
    if (await serveWorkbench(request, response)) return;
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
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
        await logger.info("Local runtime stopped", { port: address.port });
      });
      return closePromise;
    },
  });
}
