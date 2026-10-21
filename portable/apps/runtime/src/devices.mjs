import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Desk device pairing and health.
//
// A device joins with a single-use ticket that an administrator issues and
// shows out of band. Pairing returns a random device token exactly once; only
// its sha256 hash is stored, so reading `devices.json` cannot impersonate a
// device. Heartbeats authenticate with that token and refresh `lastSeenAt`;
// the listing derives `online` from how fresh the last heartbeat is instead of
// trusting a status the agent writes about itself.
// ---------------------------------------------------------------------------

export const DEVICE_SCHEMA = 1;
export const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_FRESH_MS = 90 * 1000;
const MAX_DEVICES = 50;
const MAX_TICKETS = 200;
const MAX_NAME_LENGTH = 64;
const MAX_PLATFORM_LENGTH = 32;
const MAX_VERSION_LENGTH = 32;
const MAX_CAPABILITY_LENGTH = 40;
const MAX_CAPABILITIES = 20;
const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{12}$/u;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export class DeviceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DeviceError";
    this.status = status;
  }
}

export function hashDeviceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function text(value, label, maxLength, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new DeviceError(400, `缺少${label}`);
    return null;
  }
  if (typeof value !== "string") throw new DeviceError(400, `${label}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new DeviceError(400, `${label}不能为空`);
    return null;
  }
  if (trimmed.length > maxLength) throw new DeviceError(400, `${label}过长`);
  return trimmed;
}

function capabilities(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DeviceError(400, "capabilities 必须是数组");
  if (value.length > MAX_CAPABILITIES) throw new DeviceError(400, "capabilities 条目过多");
  const seen = new Set();
  for (const item of value) {
    const entry = text(item, "capabilities 条目", MAX_CAPABILITY_LENGTH);
    seen.add(entry);
  }
  return [...seen].sort();
}

function isoTimestamp(now) {
  return now().toISOString();
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("设备数据格式不支持");
  }
  if (document.schema !== DEVICE_SCHEMA || !Array.isArray(document.devices)) {
    throw new Error("设备数据格式不支持");
  }
  const ids = new Set();
  for (const device of document.devices) {
    if (!device || typeof device !== "object") throw new Error("设备数据包含无效记录");
    if (!DEVICE_ID_PATTERN.test(device.id ?? "")) throw new Error("设备数据包含无效 id");
    if (ids.has(device.id)) throw new Error("设备数据包含重复 id");
    ids.add(device.id);
    if (typeof device.name !== "string" || device.name.trim() === ""
      || device.name.length > MAX_NAME_LENGTH) {
      throw new Error("设备数据包含无效名称");
    }
    if (typeof device.platform !== "string" || device.platform.length > MAX_PLATFORM_LENGTH) {
      throw new Error("设备数据包含无效平台");
    }
    if (device.version !== null && typeof device.version !== "string") {
      throw new Error("设备数据包含无效版本");
    }
    if (!Array.isArray(device.capabilities)
      || device.capabilities.some((entry) => typeof entry !== "string")) {
      throw new Error("设备数据包含无效能力列表");
    }
    if (!TOKEN_HASH_PATTERN.test(device.tokenHash ?? "")) {
      throw new Error("设备数据包含无效凭据哈希");
    }
    if (parseTimestamp(device.pairedAt) === null) throw new Error("设备数据包含无效配对时间");
    if (device.lastSeenAt !== null && parseTimestamp(device.lastSeenAt) === null) {
      throw new Error("设备数据包含无效心跳时间");
    }
  }
  return document;
}

function publicView(device, { now, freshMs }) {
  const lastSeen = parseTimestamp(device.lastSeenAt);
  const online = lastSeen !== null && now().getTime() - lastSeen <= freshMs;
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    version: device.version,
    capabilities: device.capabilities,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    status: online ? "online" : "offline",
    online,
  };
}

function findByHash(document, hash) {
  const presented = Buffer.from(hash, "hex");
  return document.devices.find((entry) => {
    const stored = Buffer.from(entry.tokenHash, "hex");
    return stored.length === presented.length && timingSafeEqual(stored, presented);
  }) ?? null;
}

export async function createDeviceRegistry({
  filePath,
  now = () => new Date(),
  ticketTtlMs = DEFAULT_TICKET_TTL_MS,
  heartbeatFreshMs = DEFAULT_HEARTBEAT_FRESH_MS,
} = {}) {
  const store = createJsonFileStore(filePath, {
    initial: () => ({ schema: DEVICE_SCHEMA, devices: [] }),
    validate: validateDocument,
  });
  const tickets = new Map();

  function pruneTickets() {
    const current = now().getTime();
    for (const [ticket, record] of tickets) {
      if (record.used || parseTimestamp(record.expiresAt) <= current) tickets.delete(ticket);
    }
    if (tickets.size < MAX_TICKETS) return;
    const ordered = [...tickets.entries()].sort(
      (left, right) => parseTimestamp(left[1].expiresAt) - parseTimestamp(right[1].expiresAt),
    );
    for (const [ticket] of ordered.slice(0, tickets.size - MAX_TICKETS + 1)) {
      tickets.delete(ticket);
    }
  }

  function issueTicket({ actorId = null } = {}) {
    pruneTickets();
    const ticket = `tkt_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + ticketTtlMs).toISOString();
    tickets.set(ticket, { expiresAt, used: false, createdBy: actorId });
    return { ticket, expiresAt };
  }

  async function pair({ ticket, name, platform, version, capabilities: list }) {
    const candidate = text(ticket, "配对票据", 200);
    const record = tickets.get(candidate);
    if (!record) throw new DeviceError(401, "配对票据无效或已使用");
    // Burn the ticket before touching the store: a failed write must not let
    // the same ticket try again with different device details.
    tickets.delete(candidate);
    if (parseTimestamp(record.expiresAt) <= now().getTime()) {
      throw new DeviceError(401, "配对票据已过期");
    }

    const normalizedName = text(name, "设备名称", MAX_NAME_LENGTH);
    const normalizedPlatform = text(platform, "平台", MAX_PLATFORM_LENGTH);
    const normalizedVersion = text(version, "版本", MAX_VERSION_LENGTH, { required: false });
    const normalizedCapabilities = capabilities(list);
    const token = randomBytes(32).toString("base64url");
    const device = {
      id: `dev-${randomBytes(6).toString("hex")}`,
      name: normalizedName,
      platform: normalizedPlatform,
      version: normalizedVersion,
      capabilities: normalizedCapabilities,
      tokenHash: hashDeviceToken(token),
      pairedAt: isoTimestamp(now),
      lastSeenAt: null,
    };

    const view = await store.update((document) => {
      if (document.devices.length >= MAX_DEVICES) {
        throw new DeviceError(409, "设备数量已达上限，请先移除不再使用的设备");
      }
      const lower = normalizedName.toLowerCase();
      if (document.devices.some((entry) => entry.name.toLowerCase() === lower)) {
        throw new DeviceError(409, "设备名称已存在");
      }
      document.devices.push(device);
      return publicView(device, { now, freshMs: heartbeatFreshMs });
    });
    return { device: view, token };
  }

  async function heartbeat({ token, version, capabilities: list }) {
    const candidate = text(token, "设备凭据", 200);
    const hash = hashDeviceToken(candidate);
    const normalizedVersion = version === undefined
      ? undefined
      : text(version, "版本", MAX_VERSION_LENGTH, { required: false });
    const normalizedCapabilities = list === undefined ? undefined : capabilities(list);
    return store.update((document) => {
      const device = findByHash(document, hash);
      if (!device) throw new DeviceError(401, "设备凭据无效");
      device.lastSeenAt = isoTimestamp(now);
      if (normalizedVersion !== undefined) device.version = normalizedVersion;
      if (normalizedCapabilities !== undefined) device.capabilities = normalizedCapabilities;
      return publicView(device, { now, freshMs: heartbeatFreshMs });
    });
  }

  // Read-only token lookup for channels that must not refresh lastSeenAt.
  async function authenticate({ token }) {
    const candidate = text(token, "设备凭据", 200);
    const document = await store.read();
    const device = findByHash(document, hashDeviceToken(candidate));
    if (!device) throw new DeviceError(401, "设备凭据无效");
    return publicView(device, { now, freshMs: heartbeatFreshMs });
  }

  async function list() {
    const document = await store.read();
    return document.devices
      .map((device) => publicView(device, { now, freshMs: heartbeatFreshMs }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function revoke(id) {
    if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id)) {
      throw new DeviceError(400, "设备 id 无效");
    }
    return store.update((document) => {
      const index = document.devices.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      document.devices.splice(index, 1);
      return true;
    });
  }

  return Object.freeze({ issueTicket, pair, heartbeat, authenticate, list, revoke });
}

export function readDeviceToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/iu.test(authorization)) {
    return authorization.replace(/^Bearer\s+/iu, "").trim();
  }
  const header = request.headers["x-device-token"];
  return typeof header === "string" ? header.trim() : "";
}
