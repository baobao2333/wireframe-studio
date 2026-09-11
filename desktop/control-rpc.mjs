import { randomUUID } from "node:crypto";

export function createControlRpc({ send, isReady, timeoutMs = 45000 }) {
  const pending = new Map();
  return {
    request(tool, args) {
      if (!isReady()) return Promise.reject(Error("CONTROL_NOT_READY"));
      const id = randomUUID(), deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error("CONTROL_RESULT_UNKNOWN")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, deadline, tool, args }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    reply(id, result) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id); clearTimeout(entry.timer);
      try {
        if (!result || typeof result !== "object" || typeof result.ok !== "boolean" || Buffer.byteLength(JSON.stringify(result)) > 24 * 1024 * 1024)
          throw Error("INVALID_CONTROL_RESULT");
        entry.resolve(result);
      } catch { entry.reject(Error("INVALID_CONTROL_RESULT")); }
      return true;
    },
    reset() {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error("CONTROL_DISCONNECTED")); }
      pending.clear();
    },
  };
}
