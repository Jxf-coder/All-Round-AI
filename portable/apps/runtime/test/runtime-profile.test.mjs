import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_HOST,
  displayHost,
  isLoopbackHost,
  parseAllowedOrigins,
  parseFlag,
  parseRuntimeProfile,
  resolveListenHost,
  resolveRuntimeConfiguration,
} from "../src/runtime-profile.mjs";
import { startLocalRuntime } from "../src/server.mjs";

test("runtime profiles default to local and reject unknown values", () => {
  assert.equal(parseRuntimeProfile(undefined), "local");
  assert.equal(parseRuntimeProfile(""), "local");
  assert.equal(parseRuntimeProfile("SERVER"), "server");
  assert.equal(parseRuntimeProfile(" local "), "local");
  assert.throws(() => parseRuntimeProfile("cluster"), /local or server/);
  assert.equal(parseFlag("1"), true);
  assert.equal(parseFlag("true"), true);
  assert.equal(parseFlag(true), true);
  assert.equal(parseFlag("0"), false);
  assert.equal(parseFlag(undefined), false);
});

test("loopback detection and the listen host gate", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.5"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("192.168.1.10"), false);

  // Default stays local.
  assert.equal(resolveListenHost(undefined), "127.0.0.1");
  // A non-loopback address requires an explicit opt-in.
  assert.throws(() => resolveListenHost("0.0.0.0"), /ALLROUND_AI_ALLOW_REMOTE=1/);
  assert.throws(() => resolveListenHost("192.168.1.10"), /ALLROUND_AI_ALLOW_REMOTE=1/);
  assert.equal(resolveListenHost("0.0.0.0", { allowRemote: true }), "0.0.0.0");
  assert.equal(resolveListenHost("192.168.1.10", { allowRemote: true }), "192.168.1.10");
  // A hostname would need DNS resolution and is not a valid bind target here.
  assert.throws(() => resolveListenHost("work.example.com", { allowRemote: true }), /IP address/);
  // 0.0.0.0 is not openable by a human, so the printed URL uses loopback.
  assert.equal(displayHost("0.0.0.0"), "127.0.0.1");
  assert.equal(displayHost("::"), "127.0.0.1");
  assert.equal(displayHost("192.168.1.10"), "192.168.1.10");
});

test("allowed origins are normalised and must be bare origins", () => {
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins("https://a.example.com"), ["https://a.example.com"]);
  assert.deepEqual(
    parseAllowedOrigins(" https://a.example.com , http://b.example.com:8080 "),
    ["https://a.example.com", "http://b.example.com:8080"],
  );
  assert.deepEqual(parseAllowedOrigins(["https://a.example.com"]), ["https://a.example.com"]);
  assert.throws(() => parseAllowedOrigins("https://a.example.com/path"), /without a path/);
  assert.throws(() => parseAllowedOrigins("https://a.example.com?a=1"), /without a path/);
  assert.throws(() => parseAllowedOrigins("not-a-url"), /origins such as/);
});

test("a server configuration enables proxy-friendly cookies and origins", () => {
  const local = resolveRuntimeConfiguration({});
  assert.equal(local.profile, "local");
  assert.equal(local.loopback, true);
  assert.equal(local.secureCookies, false);
  assert.equal(local.allowRemoteOrigin, false);

  const server = resolveRuntimeConfiguration({ profile: "server", secureCookies: true });
  assert.equal(server.profile, "server");
  assert.equal(server.secureCookies, true);
  assert.equal(server.allowRemoteOrigin, true, "a server install sits behind a TLS proxy");
});

test("a remote bind address is refused before anything is created", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-profile-"));
  try {
    await assert.rejects(
      startLocalRuntime({
        host: "0.0.0.0",
        env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
        home: temporaryRoot,
        port: 0,
      }),
      /ALLROUND_AI_ALLOW_REMOTE=1/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function withServerRuntime(options, run) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-profile-run-"));
  let runtime;
  try {
    runtime = await startLocalRuntime({
      authProvider: async ({ user }) => ({
        ok: true,
        user: { id: user, name: user, role: "admin", source: "all-round-ai" },
        landing: "/",
      }),
      env: { ALLROUND_AI_DATA_DIR: path.join(temporaryRoot, "data") },
      home: temporaryRoot,
      port: 0,
      ...options,
    });
    await run(runtime);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("server mode issues Secure cookies and honours the origin allowlist", async () => {
  await withServerRuntime(
    { profile: "server", secureCookies: true, allowedOrigins: "https://work.example.com" },
    async (runtime) => {
      assert.equal(runtime.profile, "server");
      const login = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://work.example.com" },
        body: JSON.stringify({ user: "server@example.test", password: "synthetic-test-password" }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie");
      assert.match(cookie, /Secure/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);

      // An origin outside the allowlist is still refused.
      const rejected = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example.com" },
        body: JSON.stringify({ user: "server@example.test", password: "synthetic-test-password" }),
      });
      assert.equal(rejected.status, 403);
    },
  );
});

test("local mode still rejects non-loopback origins and omits Secure", async () => {
  await withServerRuntime({}, async (runtime) => {
    assert.equal(runtime.profile, "local");
    const rejected = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://work.example.com" },
      body: JSON.stringify({ user: "local@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(rejected.status, 403);

    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "local@example.test", password: "synthetic-test-password" }),
    });
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.headers.get("set-cookie"), /Secure/);
  });
});
