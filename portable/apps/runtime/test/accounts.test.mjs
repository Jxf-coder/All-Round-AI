import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAccountProvider, createAccountStore } from "../src/accounts.mjs";
import { startLocalRuntime } from "../src/server.mjs";

test("native accounts normalize email and phone, persist only salted password hashes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-accounts-"));
  const filePath = path.join(temporaryRoot, "config", "accounts.json");
  const store = await createAccountStore(filePath);
  const password = "synthetic-account-password";
  try {
    assert.equal(await store.count(), 0);
    const created = await store.create({
      username: "  USER@Example.Test ",
      displayName: "Workspace Owner",
      password,
      role: "admin",
    });
    assert.equal(created.name, "Workspace Owner");
    assert.equal(created.role, "admin");
    assert.equal(created.source, "all-round-ai");
    assert.equal(created.mustChangePassword, true);
    assert.equal(await store.count(), 1);
    assert.deepEqual(await store.list(), [{
      ...created,
      username: "user@example.test",
      createdAt: (await store.list())[0].createdAt,
    }]);
    const persisted = await readFile(filePath, "utf8");
    assert.equal(persisted.includes(password), false);
    assert.match(persisted, /"salt"/);
    assert.match(persisted, /"passwordHash"/);

    assert.equal((await store.authenticate("user@example.test", password)).ok, true);
    assert.deepEqual(await store.authenticate("USER@example.test", "wrong-password"), { ok: false, status: 401 });
    assert.deepEqual(await store.authenticate("missing@example.test", "wrong-password"), { ok: false, status: 401 });
    await assert.rejects(
      store.create({ username: "user@example.test", password, role: "admin" }),
      /already exists/,
    );
    await assert.rejects(
      store.create({ username: "not an account", password, role: "admin" }),
      /有效邮箱或国际格式手机号/,
    );
    await assert.rejects(
      store.create({ username: "+8613800138000", password: "short", role: "admin" }),
      /12 至 1024/,
    );
    assert.equal((await store.create({ username: "+8613800138000", password, role: "member" })).role, "member");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("native login and its session survive a runtime restart", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-native-login-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const accountPath = path.join(dataRoot, "config", "accounts.json");
  const store = await createAccountStore(accountPath);
  const username = "owner@example.test";
  const password = "local-owner-password-2026";
  let runtime;
  try {
    const initialProvider = createAccountProvider(store);
    assert.deepEqual(await initialProvider.status(), { configured: true, setupRequired: true });
    await store.create({ username, password, role: "admin" });

    runtime = await startLocalRuntime({
      accountStore: store,
      env: { ALLROUND_AI_DATA_DIR: dataRoot },
      home: temporaryRoot,
      port: 0,
    });
    const status = await fetch(`${runtime.url}/api/auth/status`);
    assert.deepEqual(await status.json(), { configured: true, setupRequired: false });
    const rejected = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: username, password: "incorrect" }),
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: username, password }),
    });
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers.get("set-cookie").split(";")[0];
    const currentUser = await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie } });
    const loginPayload = await accepted.json();
    assert.deepEqual((await currentUser.json()).user, loginPayload.user);
    await runtime.close();
    runtime = null;

    const reloadedStore = await createAccountStore(accountPath);
    assert.equal((await reloadedStore.authenticate(username, password)).ok, true);
    runtime = await startLocalRuntime({
      accountStore: reloadedStore,
      env: { ALLROUND_AI_DATA_DIR: dataRoot },
      home: temporaryRoot,
      port: 0,
    });
    // Sessions are mirrored to disk, so the cookie obtained before the restart
    // is still valid afterwards instead of forcing another sign-in.
    const resumedSession = await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie } });
    assert.equal(resumedSession.status, 200);
    assert.deepEqual((await resumedSession.json()).user, loginPayload.user);
    // The admin still owes a password change, so the page redirect is the
    // forced change rather than a bounce back to the login page.
    const resumedPage = await fetch(`${runtime.url}/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(resumedPage.status, 302);
    assert.match(resumedPage.headers.get("location"), /^\/change-password\?next=/);
    // The persisted state never carries provider context beyond the credential
    // version, so no credential material can end up on disk.
    const persistedAuthState = await readFile(path.join(dataRoot, "config", "auth-state.json"), "utf8");
    assert.equal(persistedAuthState.includes(password), false);
    assert.equal(persistedAuthState.includes("credentialVersion"), true);
    const freshLogin = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: username, password }),
    });
    assert.equal(freshLogin.status, 200);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("corrupt native account data fails closed instead of resetting accounts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-corrupt-accounts-"));
  const filePath = path.join(temporaryRoot, "accounts.json");
  try {
    await writeFile(filePath, "{broken", "utf8");
    const store = await createAccountStore(filePath);
    await assert.rejects(store.count(), /JSON|position|property/i);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("account setup command provisions an admin without putting a password in its arguments", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-account-cli-"));
  const dataDirectory = path.join(temporaryRoot, "app data");
  const cliPath = fileURLToPath(new URL("../src/accounts-cli.mjs", import.meta.url));
  let runtime;
  try {
    const result = spawnSync(process.execPath, [cliPath, "create-admin", "Owner@Example.Test"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLROUND_AI_DATA_DIR: dataDirectory,
        LOCALAPPDATA: temporaryRoot,
      },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Account: owner@example\.test/);
    assert.match(result.stdout, /Initial password: [A-Za-z0-9_-]{32}/);
    const password = /Initial password: ([A-Za-z0-9_-]{32})/.exec(result.stdout)?.[1];
    assert.ok(password);
    const store = await createAccountStore(path.join(dataDirectory, "config", "accounts.json"));
    assert.equal((await store.authenticate("owner@example.test", password)).ok, true);
    assert.equal((await store.authenticate("owner@example.test", "incorrect-password")).ok, false);

    runtime = await startLocalRuntime({
      env: { ALLROUND_AI_DATA_DIR: dataDirectory, LOCALAPPDATA: temporaryRoot },
      home: temporaryRoot,
      port: 0,
    });
    const login = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "OWNER@example.test", password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const loginBody = await login.json();
    assert.equal(loginBody.user.mustChangePassword, true);
    const forcedChange = await fetch(`${runtime.url}/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(forcedChange.status, 302);
    assert.match(forcedChange.headers.get("location"), /^\/change-password\?next=/);
    const changePage = await fetch(`${runtime.url}/change-password`, { headers: { cookie } });
    assert.equal(changePage.status, 200);
    const changePageHtml = await changePage.text();
    assert.match(changePageHtml, /修改初始密码/);
    assert.match(changePageHtml, /href="login\.css"/);
    assert.match(changePageHtml, /src="change-password\.js"/);
    const changePageCss = await fetch(`${runtime.url}/login.css`, { headers: { cookie }, redirect: "manual" });
    assert.equal(changePageCss.status, 200);
    assert.match(changePageCss.headers.get("content-type"), /text\/css/);
    assert.match(await changePageCss.text(), /\.login-form/);
    const changePageScript = await fetch(`${runtime.url}/change-password.js`, { headers: { cookie }, redirect: "manual" });
    assert.equal(changePageScript.status, 200);
    assert.match(changePageScript.headers.get("content-type"), /javascript/);
    assert.match(await changePageScript.text(), /api\/auth\/change-password/);
    const changeTrailingSlash = await fetch(`${runtime.url}/change-password/?next=%2F`, {
      headers: { cookie }, redirect: "manual",
    });
    assert.equal(changeTrailingSlash.status, 308);
    assert.equal(changeTrailingSlash.headers.get("location"), "/change-password?next=%2F");
    const otherLogin = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password }),
    });
    const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
    const wrongCurrent = await fetch(`${runtime.url}/api/auth/change-password`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ currentPassword: "incorrect-current-password", newPassword: "new-account-password-2026" }),
    });
    assert.equal(wrongCurrent.status, 401);
    assert.match((await wrongCurrent.json()).error, /当前密码错误/);
    const shortPassword = await fetch(`${runtime.url}/api/auth/change-password`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ currentPassword: password, newPassword: "too-short" }),
    });
    assert.equal(shortPassword.status, 400);
    const changedPassword = "new-account-password-2026";
    const changed = await fetch(`${runtime.url}/api/auth/change-password`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ currentPassword: password, newPassword: changedPassword }),
    });
    assert.equal(changed.status, 200);
    const changedBody = await changed.json();
    assert.equal(changedBody.user.mustChangePassword, false);
    assert.equal(JSON.stringify(changedBody).includes(changedPassword), false);
    const renewedCookie = changed.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${runtime.url}/`, { headers: { cookie: renewedCookie } })).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie: otherCookie } })).status, 401);
    const stalePassword = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password }),
    });
    assert.equal(stalePassword.status, 401);
    const newLogin = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: changedPassword }),
    });
    assert.equal(newLogin.status, 200);
    assert.equal((await newLogin.json()).user.mustChangePassword, false);
    const activeCookie = newLogin.headers.get("set-cookie").split(";")[0];
    const anonymousChange = await fetch(`${runtime.url}/api/auth/change-password`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ currentPassword: password, newPassword: changedPassword }),
    });
    assert.equal(anonymousChange.status, 401);

    const resetResult = spawnSync(process.execPath, [cliPath, "reset-password", "OWNER@example.test"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLROUND_AI_DATA_DIR: dataDirectory,
        LOCALAPPDATA: temporaryRoot,
      },
      windowsHide: true,
    });
    assert.equal(resetResult.status, 0, resetResult.stderr);
    assert.match(resetResult.stdout, /account password reset/);
    assert.match(resetResult.stdout, /must change this password at the next login/);
    const temporaryPassword = /Temporary password: ([A-Za-z0-9_-]{32})/.exec(resetResult.stdout)?.[1];
    assert.ok(temporaryPassword);
    assert.equal((await fetch(`${runtime.url}/api/auth/me`, { headers: { cookie: activeCookie } })).status, 401);
    assert.equal((await fetch(`${runtime.url}/`, { headers: { cookie: activeCookie }, redirect: "manual" })).status, 302);
    const beforeResetPassword = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: changedPassword }),
    });
    assert.equal(beforeResetPassword.status, 401);
    const resetLogin = await fetch(`${runtime.url}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.url },
      body: JSON.stringify({ user: "owner@example.test", password: temporaryPassword }),
    });
    assert.equal(resetLogin.status, 200);
    assert.equal((await resetLogin.json()).user.mustChangePassword, true);
    assert.equal((await readFile(path.join(dataDirectory, "config", "accounts.json"), "utf8"))
      .includes(temporaryPassword), false);

    const memberResult = spawnSync(process.execPath, [cliPath, "create-member", "+8613800138000"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLROUND_AI_DATA_DIR: dataDirectory,
        LOCALAPPDATA: temporaryRoot,
      },
      windowsHide: true,
    });
    assert.equal(memberResult.status, 0, memberResult.stderr);
    assert.match(memberResult.stdout, /All Round AI member account created/);
    assert.equal(await store.count(), 2);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("account directory requires a changed admin password, enforces roles and omits credential material", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "allround-account-directory-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const store = await createAccountStore(path.join(dataDirectory, "config", "accounts.json"));
  const adminPassword = "initial-admin-password-2026";
  const memberPassword = "initial-member-password-2026";
  await store.create({ username: "admin@example.test", password: adminPassword, role: "admin" });
  await store.create({ username: "member@example.test", password: memberPassword, role: "member" });
  let runtime;

  try {
    runtime = await startLocalRuntime({
      accountStore: store,
      env: { ALLROUND_AI_DATA_DIR: dataDirectory, LOCALAPPDATA: temporaryRoot },
      home: temporaryRoot,
      port: 0,
    });

    const endpoint = `${runtime.url}/api/admin/accounts`;
    assert.equal((await fetch(endpoint)).status, 401);

    async function login(username, password) {
      const response = await fetch(`${runtime.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: runtime.url },
        body: JSON.stringify({ user: username, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }

    async function changePassword(cookie, currentPassword, newPassword) {
      const response = await fetch(`${runtime.url}/api/auth/change-password`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: runtime.url },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }

    const firstAdminCookie = await login("admin@example.test", adminPassword);
    const firstLoginList = await fetch(endpoint, { headers: { cookie: firstAdminCookie } });
    assert.equal(firstLoginList.status, 403);
    assert.match((await firstLoginList.json()).error, /修改初始密码/);

    const adminCookie = await changePassword(firstAdminCookie, adminPassword, "updated-admin-password-2026");
    const adminList = await fetch(endpoint, { headers: { cookie: adminCookie } });
    assert.equal(adminList.status, 200);
    const { accounts } = await adminList.json();
    assert.equal(accounts.length, 2);
    assert.deepEqual(accounts.map(({ username, role }) => ({ username, role })), [
      { username: "admin@example.test", role: "admin" },
      { username: "member@example.test", role: "member" },
    ]);
    assert.ok(accounts.every((account) => typeof account.createdAt === "string"));
    assert.equal(JSON.stringify(accounts).includes("passwordHash"), false);
    assert.equal(JSON.stringify(accounts).includes("salt"), false);

    const firstMemberCookie = await login("member@example.test", memberPassword);
    const memberCookie = await changePassword(firstMemberCookie, memberPassword, "updated-member-password-2026");
    const memberList = await fetch(endpoint, { headers: { cookie: memberCookie } });
    assert.equal(memberList.status, 403);
    assert.match((await memberList.json()).error, /管理员权限/);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
