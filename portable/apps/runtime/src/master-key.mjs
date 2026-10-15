import { access } from "node:fs/promises";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";
import { generateMasterKey } from "./config-store.mjs";

// The master key that protects stored secrets lives beside the data it
// protects, in the same 0600 file the other stores use. That keeps the user's
// API keys off the disk in plaintext and protects against accidental exposure
// (backups, screenshots, log scraping); it is not a defence against someone who
// can already read the user's own profile directory.
export async function loadOrCreateMasterKey(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, key: generateMasterKey() }),
    validate: (value) => {
      if (!value || value.version !== 1 || typeof value.key !== "string" || !/^[0-9a-f]{64}$/i.test(value.key)) {
        throw new Error("All Round AI master key file is unsupported or damaged");
      }
      return value;
    },
  });

  try {
    await access(filePath);
  } catch {
    // First run: persist the generated key instead of losing it on exit.
    return store.update((document) => document.key);
  }
  return (await store.read()).key;
}
