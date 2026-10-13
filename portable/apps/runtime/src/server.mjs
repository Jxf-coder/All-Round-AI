import { createServer } from "node:http";
import path from "node:path";

import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { createAppLogger } from "../../../packages/platform/src/logging.mjs";

const DEFAULT_PORT = 3141;

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

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ service: "all-round-ai", status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
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
