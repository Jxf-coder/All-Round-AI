import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// Guards for the on-disk document. The runtime already refuses to create more
// than this many live sessions, so these are backstops against a hand-edited or
// partially written file rather than expected operating limits.
const MAX_PERSISTED_SESSIONS = 1_000;
const MAX_PERSISTED_FAILURE_KEYS = 10_000;

function validateDocument(value) {
  if (!value || value.version !== 1
    || !Array.isArray(value.sessions) || !Array.isArray(value.loginFailures)) {
    throw new Error("All Round AI auth state format is unsupported or damaged");
  }
  const sessionIds = new Set();
  for (const session of value.sessions) {
    if (!session || typeof session !== "object"
      || typeof session.id !== "string" || !session.id
      || !session.user || typeof session.user !== "object" || Array.isArray(session.user)
      || typeof session.user.name !== "string"
      || (session.user.mustChangePassword !== undefined && typeof session.user.mustChangePassword !== "boolean")
      || !Number.isFinite(session.expiresAt)
      || (session.credentialVersion !== undefined && !Number.isSafeInteger(session.credentialVersion))) {
      throw new Error("All Round AI auth state contains an invalid session record");
    }
    if (sessionIds.has(session.id)) throw new Error("All Round AI auth state contains duplicate sessions");
    sessionIds.add(session.id);
  }
  const throttleKeys = new Set();
  for (const entry of value.loginFailures) {
    if (!entry || typeof entry !== "object"
      || typeof entry.key !== "string" || !entry.key
      || !Array.isArray(entry.timestamps)
      || entry.timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
      throw new Error("All Round AI auth state contains invalid login throttling data");
    }
    if (throttleKeys.has(entry.key)) throw new Error("All Round AI auth state contains duplicate throttling keys");
    throttleKeys.add(entry.key);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Session and login-throttling state lives in memory while the runtime is up
// (so every request stays a map lookup) and is mirrored to one JSON document so
// a restart no longer signs everybody out or clears the throttle.
//
// Only the credential version from a session's provider context is persisted:
// whatever else a provider puts in its context can carry credentials, and those
// must never reach the disk.
// ---------------------------------------------------------------------------

export function createAuthStateStore(filePath) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, sessions: [], loginFailures: [] }),
    validate: validateDocument,
  });

  return Object.freeze({
    async load() {
      const document = await store.read();
      const sessions = new Map();
      for (const session of document.sessions) {
        sessions.set(session.id, {
          user: session.user,
          context: session.credentialVersion === undefined
            ? null
            : { credentialVersion: session.credentialVersion },
          expiresAt: session.expiresAt,
        });
      }
      const loginFailures = new Map();
      for (const entry of document.loginFailures) {
        loginFailures.set(entry.key, [...entry.timestamps]);
      }
      return { sessions, loginFailures };
    },
    async save({ sessions, loginFailures }) {
      const persistedSessions = [...sessions].slice(-MAX_PERSISTED_SESSIONS);
      const persistedFailures = [...loginFailures].slice(-MAX_PERSISTED_FAILURE_KEYS);
      await store.update((document) => {
        document.sessions = persistedSessions.map(([id, session]) => ({
          id,
          user: session.user,
          ...(Number.isSafeInteger(session.context?.credentialVersion)
            ? { credentialVersion: session.context.credentialVersion }
            : {}),
          expiresAt: session.expiresAt,
        }));
        document.loginFailures = persistedFailures.map(([key, timestamps]) => ({ key, timestamps: [...timestamps] }));
      });
    },
  });
}
