import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../src/server.mjs";

async function withRuntime(options, callback) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-auth-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      ...options,
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
    });
    await callback(runtime);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("auth defaults to disabled and never forwards credentials", async () => {
  await withRuntime({}, async (runtime) => {
    const status = await fetch(`${runtime.url}/api/auth/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false });

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "person@example.test", password: "not-a-real-secret" }),
    });
    assert.equal(login.status, 503);
    assert.match((await login.json()).error, /尚未配置/);
    const workbench = await fetch(`${runtime.url}/`, { redirect: "manual" });
    assert.equal(workbench.status, 200);
  });
});

test("mock provider covers rejected credentials, cookie session, safe landing and logout", async () => {
  const received = [];
  const authProvider = async (credentials) => {
    received.push(credentials);
    if (credentials.password !== "test-only-password") return { ok: false, status: 401 };
    return {
      ok: true,
      user: { id: "u-1", name: "Test User", role: "admin", source: "local" },
      landing: "https://outside.example/steal",
      context: { token: "never-return-this" },
    };
  };
  await withRuntime({ authProvider }, async (runtime) => {
    const status = await fetch(`${runtime.url}/api/auth/status`);
    assert.deepEqual(await status.json(), { configured: true });

    const denied = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "person@example.test", password: "wrong" }),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "账号或密码错误" });

    const badOrigin = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://outside.example" },
      body: JSON.stringify({ user: "person@example.test", password: "test-only-password" }),
    });
    assert.equal(badOrigin.status, 403);

    const accepted = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: " person@example.test ", password: "test-only-password" }),
    });
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.equal(result.landing, "/");
    assert.equal(result.user.name, "Test User");
    assert.equal(JSON.stringify(result).includes("never-return-this"), false);
    const setCookie = accepted.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    const sessionCookie = setCookie.split(";")[0];

    const whoami = await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie: sessionCookie } });
    assert.equal(whoami.status, 200);
    assert.deepEqual((await whoami.json()).user, result.user);

    const protectedPage = await fetch(`${runtime.url}/`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    assert.equal(protectedPage.status, 200);

    const logout = await fetch(`${runtime.url}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: runtime.url },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    const afterLogout = await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie: sessionCookie } });
    assert.equal(afterLogout.status, 401);

    const unauthenticated = await fetch(`${runtime.url}/workbench.html`, { redirect: "manual" });
    assert.equal(unauthenticated.status, 302);
    assert.match(unauthenticated.headers.get("location"), /^\/login\?next=/);
    assert.equal(received.length, 2);
    assert.equal(received[1].user, "person@example.test");
  });
});

test("auth endpoints validate method, content type, JSON body and required fields", async () => {
  await withRuntime({ authProvider: async () => ({ ok: true, user: { name: "unused" } }) }, async (runtime) => {
    const method = await fetch(`${runtime.url}/api/auth/login`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");

    const mediaType = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(mediaType.status, 415);

    const malformed = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const emptyCredentials = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "", password: "" }),
    });
    assert.equal(emptyCredentials.status, 400);

    const origin = await fetch(`${runtime.url}/api/auth/logout`, {
      method: "POST",
      headers: { origin: "https://outside.example" },
    });
    assert.equal(origin.status, 403);

    const malformedCookie = await fetch(`${runtime.url}/api/auth/me`, {
      headers: { cookie: "all_round_ai_session=%ZZ" },
    });
    assert.equal(malformedCookie.status, 401);
  });
});
