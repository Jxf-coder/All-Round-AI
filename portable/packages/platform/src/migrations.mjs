import { cp, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { createJsonFileStore, writeJsonFile } from "./storage.mjs";

const MANIFEST_FILE = "schema.json";
const MANIFEST_VERSION = 1;
const LOCK_FILE = "schema.lock";

// The manifest records which data-schema versions have already been applied.
// It is itself a versioned document so a future change to the bookkeeping
// format can be migrated instead of guessed at.
function validateManifest(value) {
  if (!value || value.version !== MANIFEST_VERSION
    || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 0
    || !Array.isArray(value.applied)) {
    throw new Error("All Round AI data schema manifest is unsupported or damaged");
  }
  for (const entry of value.applied) {
    if (!entry || typeof entry !== "object"
      || !Number.isSafeInteger(entry.version) || entry.version < 1
      || typeof entry.name !== "string" || entry.name.length === 0
      || typeof entry.appliedAt !== "string") {
      throw new Error("All Round AI data schema manifest contains an invalid entry");
    }
  }
  return value;
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new TypeError("At least one data migration must be registered");
  }
  const seen = new Set();
  let previous = 0;
  for (const migration of migrations) {
    if (!migration || typeof migration !== "object"
      || !Number.isSafeInteger(migration.version) || migration.version < 1
      || typeof migration.name !== "string" || migration.name.trim() === ""
      || typeof migration.up !== "function") {
      throw new TypeError("A data migration needs an integer version, a name and an up function");
    }
    if (seen.has(migration.version)) {
      throw new TypeError(`Duplicate data migration version: ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new TypeError("Data migrations must be registered in ascending version order");
    }
    seen.add(migration.version);
    previous = migration.version;
  }
  return [...migrations];
}

function resolveInside(directory, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new TypeError("A non-empty data-relative path is required");
  }
  if (path.isAbsolute(relativePath)) {
    throw new TypeError("Migration paths must be relative to the data directory");
  }
  const target = path.resolve(directory, relativePath);
  const relative = path.relative(directory, target);
  if (relative === "" || relative === "." || relative === ".."
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RangeError("Migration path escapes the data directory");
  }
  return target;
}

function buildContext(configDir) {
  return Object.freeze({
    configDir,
    resolve: (relativePath) => resolveInside(configDir, relativePath),
    async exists(relativePath) {
      try {
        await readFile(resolveInside(configDir, relativePath));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    async read(relativePath) {
      try {
        return JSON.parse(await readFile(resolveInside(configDir, relativePath), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(relativePath, document) {
      await writeJsonFile(resolveInside(configDir, relativePath), document);
      return document;
    },
    async remove(relativePath) {
      await rm(resolveInside(configDir, relativePath), { force: true });
    },
  });
}

function timestamp(now) {
  return now().toISOString().replace(/[:.]/gu, "-");
}

async function acquireLock(lockPath) {
  // A single process owns the data directory. The lock only protects against a
  // CLI command and a runtime migrating the same directory at the same time.
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Another All Round AI process is migrating this data directory "
        + `(remove ${lockPath} only if no instance is running)`,
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function backupConfig(configDir, backupDir) {
  await mkdir(path.dirname(backupDir), { recursive: true, mode: 0o700 });
  await cp(configDir, backupDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== LOCK_FILE,
  });
  return backupDir;
}

async function restoreConfig(configDir, backupDir) {
  await rm(configDir, { recursive: true, force: true });
  await cp(backupDir, configDir, { recursive: true });
}

export async function runDataMigrations(options = {}) {
  const { dataDir } = options;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("An absolute data directory is required");
  }
  const migrations = validateMigrations(options.migrations);
  const now = options.now ?? (() => new Date());

  const configDir = path.join(dataDir, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const manifestStore = createJsonFileStore(path.join(configDir, MANIFEST_FILE), {
    initial: () => ({ version: MANIFEST_VERSION, schemaVersion: 0, applied: [] }),
    validate: validateManifest,
  });
  const latest = migrations[migrations.length - 1].version;
  const manifest = await manifestStore.read();
  if (manifest.schemaVersion > latest) {
    // Downgrading the code must never silently reinterpret newer data.
    throw new Error(
      `All Round AI data schema ${manifest.schemaVersion} was written by a newer version `
      + `(this build supports up to ${latest}); upgrade the application instead of downgrading`,
    );
  }

  const pending = migrations.filter((migration) => migration.version > manifest.schemaVersion);
  if (pending.length === 0) {
    return Object.freeze({
      schemaVersion: manifest.schemaVersion,
      applied: [],
      backupDirectory: null,
    });
  }

  const lockPath = path.join(configDir, LOCK_FILE);
  await acquireLock(lockPath);
  const applied = [];
  try {
    // Re-read after taking the lock: another process may have finished while
    // this one was waiting to acquire it.
    const current = await manifestStore.read();
    if (current.schemaVersion > latest) {
      throw new Error("All Round AI data schema changed while acquiring the migration lock");
    }
    const remaining = migrations.filter((migration) => migration.version > current.schemaVersion);
    if (remaining.length === 0) {
      return Object.freeze({
        schemaVersion: current.schemaVersion,
        applied: [],
        backupDirectory: null,
      });
    }

    // One backup covers the whole batch. Restoring it also restores the
    // manifest, so a failed migration leaves the instance exactly as it was.
    const backupDirectory = await backupConfig(
      configDir,
      path.join(
        dataDir,
        "backups",
        `migration-${timestamp(now)}-v${current.schemaVersion}-to-v${remaining.at(-1).version}`,
      ),
    );

    const context = buildContext(configDir);
    try {
      for (const migration of remaining) {
        try {
          await migration.up(context);
        } catch (error) {
          throw new Error(
            `Data migration ${migration.version} (${migration.name}) failed: ${error.message}`,
            { cause: error },
          );
        }
        const appliedAt = now().toISOString();
        await manifestStore.update((document) => {
          document.schemaVersion = migration.version;
          document.applied.push({
            version: migration.version,
            name: migration.name,
            appliedAt,
          });
          return document;
        });
        applied.push({ version: migration.version, name: migration.name, appliedAt });
      }
    } catch (error) {
      await restoreConfig(configDir, backupDirectory);
      throw error;
    }

    return Object.freeze({
      schemaVersion: applied.at(-1)?.version ?? current.schemaVersion,
      applied: Object.freeze(applied),
      backupDirectory,
    });
  } finally {
    await rm(lockPath, { force: true });
  }
}

export const DATA_MANIFEST_FILE = MANIFEST_FILE;
