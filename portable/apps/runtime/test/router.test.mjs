import assert from "node:assert/strict";
import test from "node:test";

import { createRouter, json, readJsonBody } from "../src/router.mjs";

function createMockResponse() {
  return {
    status: null,
    headers: {},
    body: "",
    headersSent: false,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = value;
      }
      this.headersSent = true;
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.ended = true;
      this.headersSent = true;
    },
  };
}

function createMockRequest({ method = "GET", url = "/", body, contentType = "application/json", headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  return {
    method,
    url,
    headers: { ...(body === undefined ? {} : { "content-type": contentType }), ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

test("router matches static patterns and extracts named parameters", () => {
  const router = createRouter();
  router.get("/api/items/:id", () => true);
  const matched = router.match("GET", "/api/items/42");
  assert.equal(matched.params.id, "42");
  assert.equal(router.match("GET", "/api/items"), null);
  assert.equal(router.match("POST", "/api/items/42"), null);
});

test("router supports wildcard segments for client-side routes", () => {
  const router = createRouter();
  router.get("/workbench/*", () => true);
  assert.equal(router.match("GET", "/workbench"), null);
  assert.equal(router.match("GET", "/workbench/chat/1").params.wildcard, "chat/1");
});

test("dispatch runs middlewares in order and stops on a handled response", async () => {
  const router = createRouter();
  const order = [];
  router.use(() => { order.push("first"); });
  router.use((ctx) => {
    order.push("second");
    json(ctx.response, 200, { ok: true });
    return true;
  });
  router.get("/never", () => { order.push("route"); });
  const response = createMockResponse();
  const handled = await router.dispatch(createMockRequest({ url: "/never" }), response);
  assert.equal(handled, true);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(response.status, 200);
});

test("dispatch falls back when no route matches and reports unhandled", async () => {
  let fallbackContext = null;
  const router = createRouter({
    fallback: (ctx) => {
      fallbackContext = ctx;
      return false;
    },
  });
  router.get("/known", () => true);
  const response = createMockResponse();
  const handled = await router.dispatch(createMockRequest({ url: "/unknown?x=1" }), response);
  assert.equal(handled, false);
  assert.equal(fallbackContext.query.get("x"), "1");
});

test("dispatch answers 405 with an allow header for an existing path", async () => {
  const router = createRouter();
  router.get("/api/only-get", () => true);
  const response = createMockResponse();
  const handled = await router.dispatch(createMockRequest({ method: "POST", url: "/api/only-get" }), response);
  assert.equal(handled, true);
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET");
});

test("dispatch always tags responses with a request id", async () => {
  const router = createRouter();
  let seen = null;
  router.get("/ping", (ctx) => {
    seen = ctx.requestId;
    json(ctx.response, 200, { ok: true });
    return true;
  });
  const response = createMockResponse();
  await router.dispatch(createMockRequest({ url: "/ping" }), response);
  assert.match(seen, /^[0-9a-f]{32}$/);
  assert.equal(response.headers["x-request-id"], seen);
});

test("readJsonBody parses objects and rejects malformed input", async () => {
  assert.deepEqual(
    await readJsonBody(createMockRequest({ method: "POST", body: { hello: "world" } })),
    { hello: "world" },
  );

  await assert.rejects(
    readJsonBody(createMockRequest({ method: "POST", body: "not-json" })),
    (error) => error.status === 400,
  );
  await assert.rejects(
    readJsonBody(createMockRequest({ method: "POST", body: { a: 1 }, contentType: "text/plain" })),
    (error) => error.status === 415,
  );
  await assert.rejects(
    readJsonBody(createMockRequest({ method: "POST", body: { a: 1 } }), { maxBytes: 2 }),
    (error) => error.status === 413,
  );
  await assert.rejects(
    readJsonBody(createMockRequest({ method: "POST", body: [1, 2] })),
    (error) => error.status === 400,
  );
});
