import { randomBytes } from "node:crypto";
import path from "node:path";

import { createAccountStore } from "./accounts.mjs";
import { createAuditLog } from "./audit.mjs";
import { ensureAppDirectories } from "../../../packages/platform/src/directories.mjs";
import { runDataMigrations } from "../../../packages/platform/src/migrations.mjs";
import { RUNTIME_SCHEMA_MIGRATIONS } from "./migrations.mjs";

const [command, rawUsername] = process.argv.slice(2);
const role = command === "create-admin" ? "admin" : command === "create-member" ? "member" : null;
const action = command === "reset-password" ? "account.reset-password" : "account.create";
// Account provisioning happens in its own process, so it cannot go through the
// runtime's audit writer; the file format is the same and reads back in the
// workbench. A write failure is reported but never blocks provisioning.
let auditLog = null;
async function recordAudit(entry) {
  if (!auditLog) return;
  try {
    await auditLog.append(entry);
  } catch (error) {
    process.stderr.write(`Audit entry could not be written: ${error.message}\n`);
  }
}
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
    auditLog = createAuditLog({ filePath: path.join(directories.logs, "audit.jsonl") });
    const store = await createAccountStore(path.join(directories.config, "accounts.json"));
    const password = randomBytes(24).toString("base64url");
    if (command === "reset-password") {
      const user = await store.resetPassword(rawUsername, password);
      await recordAudit({ actor: "cli", action, outcome: "ok", detail: `重置密码：${user.name}` });
      process.stdout.write(`All Round AI account password reset.\nAccount: ${user.name}\nTemporary password: ${password}\nThe user must change this password at the next login.\nSave this password now. It will not be printed again.\n`);
    } else {
      const user = await store.create({ username: rawUsername, password, role });
      await recordAudit({ actor: "cli", action, target: role, outcome: "ok", detail: `创建 ${role} 账号：${user.name}` });
      process.stdout.write(`All Round AI ${role} account created.\nAccount: ${user.name}\nInitial password: ${password}\nSave this password now. It will not be printed again.\n`);
    }
  } catch (error) {
    await recordAudit({ actor: "cli", action, target: role, outcome: "error", detail: error.message });
    process.stderr.write(`Account setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
