import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

const MASTER_KEY_BYTES = 32;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function resolveMasterKey(masterKey) {
  if (masterKey === null || masterKey === undefined) return null;
  if (Buffer.isBuffer(masterKey)) {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new TypeError("Master key must be exactly 32 bytes");
    }
    return masterKey;
  }
  if (typeof masterKey !== "string") {
    throw new TypeError("Master key must be a 32-byte buffer or hex/base64 string");
  }
  if (/^[0-9a-f]{64}$/i.test(masterKey)) {
    return Buffer.from(masterKey, "hex");
  }
  const decoded = Buffer.from(masterKey, "base64");
  if (decoded.length === MASTER_KEY_BYTES) return decoded;
  throw new TypeError("Master key must be a 64-character hex or 32-byte base64 string");
}

function validateDocument(value) {
  if (!value || value.version !== 1
    || (value.values && (typeof value.values !== "object" || Array.isArray(value.values)))
    || (value.secrets && (typeof value.secrets !== "object" || Array.isArray(value.secrets)))) {
    throw new Error("All Round AI config store format is unsupported or damaged");
  }
  return value;
}

function encryptRecord(masterKey, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: ALGORITHM,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptRecord(masterKey, record) {
  if (!record || record.algorithm !== ALGORITHM
    || typeof record.iv !== "string" || typeof record.tag !== "string" || typeof record.ciphertext !== "string") {
    throw new Error("All Round AI config secret record is unsupported or damaged");
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function generateMasterKey() {
  return randomBytes(MASTER_KEY_BYTES).toString("hex");
}

export async function createConfigStore(filePath, options = {}) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, values: {}, secrets: {} }),
    validate: validateDocument,
  });
  const masterKey = resolveMasterKey(options.masterKey);

  function assertKeyAvailable(action) {
    if (!masterKey) {
      throw new Error(`A master key is required to ${action} secrets`);
    }
    return masterKey;
  }

  function assertKeyName(key) {
    if (typeof key !== "string" || !key.trim()) {
      throw new TypeError("A non-empty config key is required");
    }
  }

  return Object.freeze({
    async get(key) {
      return (await store.read()).values?.[key];
    },
    async set(key, value) {
      assertKeyName(key);
      return store.update((document) => {
        document.values[key] = value;
      });
    },
    async getSecret(key) {
      assertKeyAvailable("read");
      const record = (await store.read()).secrets?.[key];
      if (!record) return undefined;
      return decryptRecord(masterKey, record);
    },
    async setSecret(key, plaintext) {
      assertKeyAvailable("store");
      assertKeyName(key);
      if (typeof plaintext !== "string") {
        throw new TypeError("Secrets must be strings");
      }
      return store.update((document) => {
        document.secrets[key] = encryptRecord(masterKey, plaintext);
      });
    },
    async deleteSecret(key) {
      return store.update((document) => {
        delete document.secrets[key];
      });
    },
  });
}
