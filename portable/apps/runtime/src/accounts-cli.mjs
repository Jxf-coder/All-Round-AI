import { randomBytes } from "node:crypto";
import path from "node:path";

import { createAccountStore } from "./accounts.mjs";
import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";

const [command, rawUsername] = process.argv.slice(2);
const role = command === "create-admin" ? "admin" : command === "create-member" ? "member" : null;
if (!role || !rawUsername) {
  process.stderr.write("Usage: npm run account:create -- <create-admin|create-member> <email-or-phone>\n");
  process.exitCode = 2;
} else {
  try {
    const directories = await ensureAppDirectories();
    const store = await createAccountStore(path.join(directories.config, "accounts.json"));
    const password = randomBytes(24).toString("base64url");
    await store.create({ username: rawUsername, password, role });
    process.stdout.write(`All Round AI ${role} account created.\nAccount: ${rawUsername.trim().toLowerCase()}\nInitial password: ${password}\nSave this password now. It will not be printed again.\n`);
  } catch (error) {
    process.stderr.write(`Account setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
