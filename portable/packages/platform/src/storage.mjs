import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Shared atomic JSON document store. Account, config and conversation data all
// need the same guarantees, so they are written here once instead of being
// re-implemented per module:
//   - writes go to a temp file in the same directory, are fsync'd, then renamed
//     over the target, so readers never observe a partial document;
//   - the containing directory is created with 0700 and files with 0600 on
//     POSIX systems (Windows relies on per-user profile ACLs);
//   - updates within one process are serialised through a promise chain.
// ---------------------------------------------------------------------------

// Atomic JSON write shared by the store and by migrations: temp file in the
// same directory, fsync, rename over the target. A reader therefore sees
// either the previous document or the next one, never a partial write.
export async function writeJsonFile(filePath, document) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("An absolute store path is required");
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await access(directory, 2);
  if (process.platform !== "win32") await chmod(directory, DIRECTORY_MODE);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function createJsonFileStore(filePath, options = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("An absolute store path is required");
  }
  const createInitial = options.initial;
  if (typeof createInitial !== "function") {
    throw new TypeError("A store must define an initial document factory");
  }
  const validate = options.validate ?? ((value) => value);
  if (typeof validate !== "function") {
    throw new TypeError("Store validation must be a function");
  }
  let pendingWrite = Promise.resolve();

  async function read() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return createInitial();
      throw error;
    }
    return validate(JSON.parse(raw));
  }

  async function write(document) {
    await writeJsonFile(filePath, document);
  }

  // The mutator receives a fresh document, may change it in place, and returns
  // the value the caller needs. The document is persisted only if the mutator
  // resolves; a thrown error aborts the write entirely.
  async function update(mutator) {
    if (typeof mutator !== "function") {
      throw new TypeError("A store update mutator is required");
    }
    const operation = pendingWrite.then(async () => {
      const document = await read();
      const result = await mutator(document);
      await write(document);
      return result;
    });
    pendingWrite = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({ path: filePath, read, update });
}
