import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Device command channel.
//
// The server never dials a desk: the agent keeps an outbound long-poll open,
// receives one command at a time and posts the result back. Commands are tied
// to the device that authenticated, expire with the request, and a late result
// for an expired command is ignored instead of resolving someone else's wait.
// ---------------------------------------------------------------------------

const MAX_QUEUE_PER_DEVICE = 20;

export class DeviceChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeviceChannelError";
    this.code = code;
  }
}

export function createDeviceChannel({ commandTtlMs = 20_000 } = {}) {
  if (!Number.isSafeInteger(commandTtlMs) || commandTtlMs < 1_000) {
    throw new TypeError("命令超时至少 1000 毫秒");
  }
  const queues = new Map();
  const waiters = new Map();
  const pending = new Map();

  function deliver(deviceId) {
    const queue = queues.get(deviceId);
    const list = waiters.get(deviceId);
    if (!queue?.length || !list?.length) return;
    const waiter = list.shift();
    waiter(queue.shift());
  }

  function enqueue({ deviceId, type, payload, ttlMs = commandTtlMs }) {
    if (typeof deviceId !== "string" || deviceId === "") throw new TypeError("deviceId is required");
    if (typeof type !== "string" || type === "") throw new TypeError("命令类型不能为空");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new TypeError("命令超时至少 1000 毫秒");
    }
    const queue = queues.get(deviceId) ?? [];
    if (queue.length >= MAX_QUEUE_PER_DEVICE) {
      throw new DeviceChannelError("BUSY", "设备还有未执行的命令，请稍后再试");
    }
    const id = `cmd_${randomBytes(8).toString("hex")}`;
    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Drop a command the device never picked up: nobody is waiting for
        // it anymore, so executing it later would only waste a round trip.
        const current = queues.get(deviceId);
        const index = current?.findIndex((entry) => entry.id === id) ?? -1;
        if (index >= 0) current.splice(index, 1);
        reject(new DeviceChannelError("TIMEOUT", "设备没有在限定时间内响应"));
      }, ttlMs);
      pending.set(id, { deviceId, resolve, reject, timer });
    });
    queue.push({ id, type, payload });
    queues.set(deviceId, queue);
    deliver(deviceId);
    return { id, wait };
  }

  function take({ deviceId, waitMs = 10_000 }) {
    const queue = queues.get(deviceId);
    if (queue?.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const list = waiters.get(deviceId) ?? [];
      let timer;
      const waiter = (command) => {
        clearTimeout(timer);
        resolve(command);
      };
      timer = setTimeout(() => {
        const current = waiters.get(deviceId) ?? [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        resolve(null);
      }, Math.max(0, waitMs));
      list.push(waiter);
      waiters.set(deviceId, list);
    });
  }

  function complete({ deviceId, commandId, ok, result, error }) {
    const entry = pending.get(commandId);
    if (!entry || entry.deviceId !== deviceId) return false;
    pending.delete(commandId);
    clearTimeout(entry.timer);
    if (ok) {
      entry.resolve(result ?? null);
    } else {
      entry.reject(new DeviceChannelError("DEVICE_ERROR", typeof error === "string" && error ? error : "设备执行失败"));
    }
    return true;
  }

  return Object.freeze({ enqueue, take, complete });
}
