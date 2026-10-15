import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

const scrypt = promisify(scryptCallback);
const HASH_BYTES = 32;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ROLES = new Set(["admin", "member"]);
const DUMMY_SALT = Buffer.alloc(16, 0x41);

function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.normalize("NFKC").trim().toLowerCase();
  if (username.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(username)) return null;
  const email = /^[^@]+@[^@]+\.[^@.]{2,}$/u.test(username);
  const phone = /^\+?\d{7,15}$/u.test(username);
  return email || phone ? username : null;
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.users)) {
    throw new Error("All Round AI account store format is unsupported or damaged");
  }
  const usernames = new Set();
  for (const user of value.users) {
    if (!user || typeof user !== "object"
      || typeof user.id !== "string"
      || normalizeUsername(user.username) !== user.username
      || typeof user.displayName !== "string"
      || !ROLES.has(user.role)
      || typeof user.salt !== "string"
      || !/^[A-Za-z0-9_-]{22}$/.test(user.salt)
      || typeof user.passwordHash !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(user.passwordHash)
      || (user.mustChangePassword !== undefined && typeof user.mustChangePassword !== "boolean")
      || (user.credentialVersion !== undefined && (!Number.isSafeInteger(user.credentialVersion) || user.credentialVersion < 1))
      || typeof user.createdAt !== "string") {
      throw new Error("All Round AI account store contains an invalid account record");
    }
    if (usernames.has(user.username)) throw new Error("All Round AI account store contains duplicate accounts");
    usernames.add(user.username);
  }
  return value;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.displayName,
    role: user.role,
    roleLabel: user.role === "admin" ? "管理员" : "成员",
    source: "all-round-ai",
    mustChangePassword: user.mustChangePassword === true,
  };
}

export async function createAccountStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, users: [] }),
    validate: validateDocument,
  });

  return Object.freeze({
    async count() {
      return (await store.read()).users.length;
    },
    async list() {
      const document = await store.read();
      return document.users.map((user) => ({
        ...publicUser(user),
        username: user.username,
        createdAt: user.createdAt,
      }));
    },
    async create({ username: rawUsername, password, role = "member", displayName } = {}) {
      const username = normalizeUsername(rawUsername);
      if (!username) throw new TypeError("账号必须是有效邮箱或国际格式手机号");
      if (typeof password !== "string" || [...password].length < 12 || password.length > 1024) {
        throw new TypeError("密码长度必须为 12 至 1024 个字符");
      }
      if (!ROLES.has(role)) throw new TypeError("角色只能是 admin 或 member");
      const name = typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 100)
        : username;

      return store.update(async (document) => {
        if (document.users.some((user) => user.username === username)) {
          throw new Error("All Round AI account already exists");
        }
        const salt = randomBytes(16);
        const passwordHash = await scrypt(password, salt, HASH_BYTES, SCRYPT_OPTIONS);
        const user = {
          id: randomUUID(),
          username,
          displayName: name,
          role,
          salt: salt.toString("base64url"),
          passwordHash: passwordHash.toString("base64url"),
          mustChangePassword: true,
          credentialVersion: 1,
          createdAt: new Date().toISOString(),
        };
        document.users.push(user);
        return publicUser(user);
      });
    },
    async authenticate(rawUsername, password) {
      const username = normalizeUsername(rawUsername);
      if (typeof password !== "string" || password.length > 1024) {
        return { ok: false, status: 401 };
      }
      const document = await store.read();
      const user = username ? document.users.find((candidate) => candidate.username === username) : null;
      const salt = user ? Buffer.from(user.salt, "base64url") : DUMMY_SALT;
      const expected = user ? Buffer.from(user.passwordHash, "base64url") : Buffer.alloc(HASH_BYTES);
      const actual = await scrypt(password, salt, HASH_BYTES, SCRYPT_OPTIONS);
      const matches = timingSafeEqual(actual, expected);
      if (!user || !matches) return { ok: false, status: 401 };
      return {
        ok: true,
        user: publicUser(user),
        context: { credentialVersion: user.credentialVersion ?? 1 },
        landing: "/",
      };
    },
    async changePassword(userId, currentPassword, newPassword) {
      if (typeof userId !== "string" || typeof currentPassword !== "string" || currentPassword.length > 1024
        || typeof newPassword !== "string" || [...newPassword].length < 12 || newPassword.length > 1024) {
        return { ok: false, reason: "invalid" };
      }
      return store.update(async (document) => {
        const user = document.users.find((candidate) => candidate.id === userId);
        if (!user) return { ok: false, reason: "unauthorized" };
        const salt = Buffer.from(user.salt, "base64url");
        const expected = Buffer.from(user.passwordHash, "base64url");
        const actual = await scrypt(currentPassword, salt, HASH_BYTES, SCRYPT_OPTIONS);
        if (!timingSafeEqual(actual, expected)) return { ok: false, reason: "unauthorized" };
        if (currentPassword === newPassword) return { ok: false, reason: "same" };
        const newSalt = randomBytes(16);
        const passwordHash = await scrypt(newPassword, newSalt, HASH_BYTES, SCRYPT_OPTIONS);
        user.salt = newSalt.toString("base64url");
        user.passwordHash = passwordHash.toString("base64url");
        user.mustChangePassword = false;
        user.credentialVersion = (user.credentialVersion ?? 1) + 1;
        return { ok: true, user: publicUser(user), credentialVersion: user.credentialVersion };
      });
    },
    async resetPassword(rawUsername, password) {
      const username = normalizeUsername(rawUsername);
      if (!username) throw new TypeError("账号必须是有效邮箱或国际格式手机号");
      if (typeof password !== "string" || [...password].length < 12 || password.length > 1024) {
        throw new TypeError("密码长度必须为 12 至 1024 个字符");
      }
      return store.update(async (document) => {
        const user = document.users.find((candidate) => candidate.username === username);
        if (!user) throw new Error("All Round AI account was not found");
        const salt = randomBytes(16);
        const passwordHash = await scrypt(password, salt, HASH_BYTES, SCRYPT_OPTIONS);
        user.salt = salt.toString("base64url");
        user.passwordHash = passwordHash.toString("base64url");
        user.mustChangePassword = true;
        user.credentialVersion = (user.credentialVersion ?? 1) + 1;
        return publicUser(user);
      });
    },
    async isSessionValid(userId, credentialVersion) {
      if (typeof userId !== "string" || !Number.isSafeInteger(credentialVersion)) return false;
      const document = await store.read();
      const user = document.users.find((candidate) => candidate.id === userId);
      return Boolean(user && (user.credentialVersion ?? 1) === credentialVersion);
    },
  });
}

export function createAccountProvider(store) {
  if (!store || typeof store.authenticate !== "function" || typeof store.count !== "function") {
    throw new TypeError("A valid All Round AI account store is required");
  }
  const provider = ({ user, password }) => store.authenticate(user, password);
  provider.status = async () => ({ configured: true, setupRequired: (await store.count()) === 0 });
  provider.changePassword = async (userId, currentPassword, newPassword) => {
    const result = await store.changePassword(userId, currentPassword, newPassword);
    return result.ok
      ? { ok: true, user: result.user, context: { credentialVersion: result.credentialVersion } }
      : result;
  };
  provider.isSessionValid = (userId, credentialVersion) =>
    store.isSessionValid(userId, credentialVersion);
  return provider;
}
