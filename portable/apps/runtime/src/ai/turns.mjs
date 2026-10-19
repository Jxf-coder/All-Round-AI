// ---------------------------------------------------------------------------
// In-flight chat turns.
//
// In the reference workbench a reply is owned by the runtime, not by the
// browser connection: refreshing the page does not kill an answer, and stopping
// is an explicit cancel instead of closing the socket. This module provides the
// same behaviour with nothing but the standard library:
//
//   - a persisted turn log (who asked, in which conversation, how it ended) so
//     an interrupted turn is visible after a restart instead of staying
//     "running" forever;
//   - an in-memory live registry that buffers each running turn's events, so a
//     reconnecting client can replay from a sequence number and then follow.
//
// Only terminal results are persisted; streamed deltas live in memory. A turn
// therefore costs two disk writes (begin and finish) no matter how long the
// reply is.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

import { createJsonFileStore } from "../../../../packages/platform/src/storage.mjs";

export const TURN_STATUSES = Object.freeze(["running", "done", "cancelled", "error"]);
export const TERMINAL_TURN_STATUSES = Object.freeze(["done", "cancelled", "error"]);
export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_MAX_LIVE_TURNS = 50;
export const MAX_TURN_EVENTS = 2000;
export const MAX_TURN_TEXT = 200_000;

const TERMINAL = new Set(TERMINAL_TURN_STATUSES);

function newTurnId() {
  return randomBytes(12).toString("hex");
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function validateTurnDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.version !== 1 || !Array.isArray(document.turns)) {
    throw new Error("All Round AI turn store format is unsupported or damaged");
  }
  for (const turn of document.turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)
      || typeof turn.id !== "string" || !turn.id
      || typeof turn.ownerId !== "string" || !turn.ownerId
      || typeof turn.conversationId !== "string" || !turn.conversationId
      || !TURN_STATUSES.includes(turn.status)) {
      throw new Error("All Round AI turn store contains an invalid turn");
    }
  }
  return document;
}

export function createTurnManager(options = {}) {
  const now = options.now ?? (() => Date.now());
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxLiveTurns = options.maxLiveTurns ?? DEFAULT_MAX_LIVE_TURNS;
  const store = createJsonFileStore(options.filePath, {
    initial: () => ({ version: 1, turns: [] }),
    validate: validateTurnDocument,
  });
  // turnId -> { turn, seq, events, listeners, controller, cancelRequested }
  const live = new Map();

  // The public shape never leaks the internal controller or listener set; it
  // carries exactly what a client needs to render and to resume from `seq`.
  function publicTurn(turn) {
    const entry = live.get(turn.id);
    return {
      id: turn.id,
      clientTurnId: turn.clientTurnId ?? null,
      conversationId: turn.conversationId,
      projectId: turn.projectId ?? null,
      status: turn.status,
      text: turn.text ?? "",
      error: turn.error ?? null,
      effort: turn.effort ?? null,
      fast: turn.fast === true,
      engine: turn.engine ?? null,
      citations: turn.citations ?? [],
      seq: entry ? entry.seq : 0,
      createdAt: turn.createdAt ?? null,
      updatedAt: turn.updatedAt ?? null,
    };
  }

  async function persist(turn) {
    const record = { ...turn };
    await store.update((document) => {
      const index = document.turns.findIndex((item) => item.id === record.id);
      if (index >= 0) document.turns[index] = record;
      else document.turns.push(record);
      if (document.turns.length > maxTurns) {
        document.turns.splice(0, document.turns.length - maxTurns);
      }
      return document;
    });
  }

  function notify(entry, event) {
    for (const listener of [...entry.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken tail (e.g. a socket that closed mid-write) must never stop
        // the turn itself.
      }
    }
    if (event.done) entry.listeners.clear();
  }

  function evictLive() {
    if (live.size <= maxLiveTurns) return;
    const finished = [...live.values()]
      .filter((entry) => isTerminal(entry.turn.status))
      .sort((left, right) => (left.turn.finishedAt ?? 0) - (right.turn.finishedAt ?? 0));
    for (const entry of finished) {
      if (live.size <= maxLiveTurns) break;
      live.delete(entry.turn.id);
    }
  }

  // Runs once at startup. A turn that was still running when the process died
  // can never continue, so it is closed as an error rather than left dangling.
  async function recover() {
    const document = await store.read();
    const interrupted = document.turns.filter((turn) => turn.status === "running");
    if (!interrupted.length) return 0;
    const timestamp = now();
    await store.update((doc) => {
      for (const turn of doc.turns) {
        if (turn.status !== "running") continue;
        turn.status = "error";
        turn.error = "服务已重启，回复已中断";
        turn.updatedAt = timestamp;
        turn.finishedAt = timestamp;
      }
      return doc;
    });
    return interrupted.length;
  }

  // Idempotency: a resent request carries the same clientTurnId, so it is
  // answered from the turn it already started instead of generating a second
  // reply (and a duplicate user message).
  async function findByClientTurnId({ ownerId, conversationId, clientTurnId }) {
    if (!clientTurnId) return null;
    for (const entry of live.values()) {
      const { turn } = entry;
      if (turn.clientTurnId === clientTurnId && turn.ownerId === ownerId
        && turn.conversationId === conversationId) {
        return publicTurn(turn);
      }
    }
    const document = await store.read();
    const found = document.turns.find((turn) => turn.clientTurnId === clientTurnId
      && turn.ownerId === ownerId && turn.conversationId === conversationId);
    return found ? publicTurn(found) : null;
  }

  async function latestFor(ownerId, conversationId) {
    let newest = null;
    for (const entry of live.values()) {
      const { turn } = entry;
      if (turn.ownerId !== ownerId || turn.conversationId !== conversationId) continue;
      if (!newest || (turn.createdAt ?? 0) >= (newest.createdAt ?? 0)) newest = turn;
    }
    if (newest) return publicTurn(newest);
    const document = await store.read();
    const candidates = document.turns.filter(
      (turn) => turn.ownerId === ownerId && turn.conversationId === conversationId,
    );
    if (!candidates.length) return null;
    candidates.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
    return publicTurn(candidates.at(-1));
  }

  async function begin({
    ownerId,
    conversationId,
    projectId = null,
    clientTurnId = null,
    effort = null,
    fast = false,
    engine = null,
    citations = [],
  }) {
    // One reply at a time per conversation: sending again replaces the running
    // turn, mirroring the workbench where a new message stops the previous one.
    for (const entry of [...live.values()]) {
      if (entry.turn.status === "running" && entry.turn.ownerId === ownerId
        && entry.turn.conversationId === conversationId) {
        cancel(entry.turn.id);
      }
    }
    const normalizedCitations = [];
    if (Array.isArray(citations)) {
      const seen = new Set();
      for (const citation of citations.slice(0, 8)) {
        if (!citation || typeof citation.id !== "string" || !citation.id
          || typeof citation.title !== "string" || !citation.title
          || seen.has(citation.id)) continue;
        seen.add(citation.id);
        normalizedCitations.push({
          id: citation.id,
          title: citation.title,
          kind: typeof citation.kind === "string" ? citation.kind : null,
        });
      }
    }
    const timestamp = now();
    const turn = {
      id: newTurnId(),
      clientTurnId: clientTurnId ?? null,
      ownerId,
      conversationId,
      projectId,
      status: "running",
      text: "",
      error: null,
      effort: effort ?? null,
      fast: fast === true,
      engine: engine ?? null,
      // Which knowledge cards fed this answer, so the reader can audit it later.
      citations: normalizedCitations,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    live.set(turn.id, {
      turn,
      seq: 0,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      cancelRequested: false,
    });
    await persist(turn);
    return publicTurn(turn);
  }

  function append(turnId, payload) {
    const entry = live.get(turnId);
    if (!entry || isTerminal(entry.turn.status)) return null;
    entry.seq += 1;
    const event = { seq: entry.seq, ...payload };
    entry.events.push(event);
    if (entry.events.length > MAX_TURN_EVENTS) {
      entry.events.splice(0, entry.events.length - MAX_TURN_EVENTS);
    }
    if (typeof payload.delta === "string" && payload.delta) {
      entry.turn.text = (entry.turn.text + payload.delta).slice(0, MAX_TURN_TEXT);
    }
    entry.turn.updatedAt = now();
    notify(entry, event);
    return event;
  }

  async function finish(turnId, { status, error = null } = {}) {
    const entry = live.get(turnId);
    if (!entry || isTerminal(entry.turn.status)) return null;
    const timestamp = now();
    entry.turn.status = status;
    entry.turn.error = error;
    entry.turn.updatedAt = timestamp;
    entry.turn.finishedAt = timestamp;
    entry.seq += 1;
    const event = { seq: entry.seq, done: true, status };
    entry.events.push(event);
    // Durability first: a follower told the turn is finished must be able to
    // rely on the terminal record already being on disk.
    await persist(entry.turn);
    notify(entry, event);
    evictLive();
    return publicTurn(entry.turn);
  }

  function cancel(turnId) {
    const entry = live.get(turnId);
    if (!entry || isTerminal(entry.turn.status)) return false;
    entry.cancelRequested = true;
    entry.controller.abort();
    return true;
  }

  function signalFor(turnId) {
    return live.get(turnId)?.controller.signal ?? null;
  }

  function statusOf(turnId) {
    return live.get(turnId)?.turn.status;
  }

  function isCancelled(turnId) {
    return live.get(turnId)?.cancelRequested === true;
  }

  // Replays buffered events newer than `after`, then keeps the listener
  // attached until the turn ends. For an already-finished turn the replay
  // includes the terminal event and no listener is retained.
  function subscribe(turnId, listener, { after = 0 } = {}) {
    const entry = live.get(turnId);
    if (!entry || typeof listener !== "function") return () => {};
    for (const event of entry.events) {
      if (event.seq > after) listener(event);
    }
    if (isTerminal(entry.turn.status)) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  return Object.freeze({
    path: store.path,
    recover,
    begin,
    append,
    finish,
    cancel,
    signalFor,
    statusOf,
    isCancelled,
    subscribe,
    findByClientTurnId,
    latestFor,
  });
}
