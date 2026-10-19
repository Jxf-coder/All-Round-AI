import { randomBytes } from "node:crypto";
import path from "node:path";

import { createAccountStore } from "./accounts.mjs";
import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { runDataMigrations } from "../../../packages/platform/src/migrations.mjs";
import { RUNTIME_SCHEMA_MIGRATIONS } from "./migrations.mjs";

const [command, rawUsername] = process.argv.slice(2);
const role = command === "create-admin" ? "admin" : command === "create-member" ? "member" : null;
if ((!role && command !== "reset-password") || !rawUsername) {
  process.stderr.write("Usage: npm run account:create -- <create-admin|create-member|reset-password> <email-or-phone>\n");
  process.exitCode = 2;
} else {
  try {
    const directories = await ensureAppDirectories();
    await runDataMigrations({
      dataDir: directories.data,
      migrations: RUNTIME_SCHEMA_MIGRATIONS,
    });
    const store = await createAccountStore(path.join(directories.config, "accounts.json"));
    const password = randomBytes(24).toString("base64url");
    if (command === "reset-password") {
      const user = await store.resetPassword(rawUsername, password);
      process.stdout.write(`All Round AI account password reset.\nAccount: ${user.name}\nTemporary password: ${password}\nThe user must change this password at the next login.\nSave this password now. It will not be printed again.\n`);
    } else {
      const user = await store.create({ username: rawUsername, password, role });
      process.stdout.write(`All Round AI ${role} account created.\nAccount: ${user.name}\nInitial password: ${password}\nSave this password now. It will not be printed again.\n`);
    }
  } catch (error) {
    process.stderr.write(`Account setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
