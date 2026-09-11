export const VISION_TIMEOUT_MS = 300000;
const stages = ["starting", "recognizing", "receiving", "validating", "complete"];
const messages = {
  starting: "正在启动图片识别",
  recognizing: "正在等待模型识别界面",
  receiving: "正在接收识别结果",
  validating: "正在校验识别结果文件",
  complete: "识别完成",
};

export function createVisionProgress({ now = Date.now, maxLineBytes = 32 * 1024 * 1024,
  maxStreamBytes = 64 * 1024 * 1024, maxItems = 512 } = {}) {
  const state = { stage: "starting", eventCount: 0, outputChars: 0, nodeCount: null,
    timeoutMs: VISION_TIMEOUT_MS, warning: null };
  const lengths = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lastActivity = null, stoppedAt = null, ended = false, disabled = false;
  let buffer = Buffer.alloc(0), used = 0, total = 0, discarding = false;
  const clear = () => { buffer = Buffer.alloc(0); used = 0; };
  const warn = message => { state.warning ??= message; };
  const advance = stage => {
    if (stoppedAt === null && stages.indexOf(stage) > stages.indexOf(state.stage)) state.stage = stage;
  };
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 200;

  function accept(event) {
    if (!event || Array.isArray(event) || typeof event !== "object" || typeof event.type !== "string")
      throw new Error("Invalid progress event");
    switch (event.type) {
      case "thread.started":
        if (!validId(event.thread_id)) throw new Error("Invalid thread event");
        break;
      case "turn.started":
        advance("recognizing");
        break;
      case "turn.completed":
        break;
      case "turn.failed":
      case "error":
        warn("Codex 报告了进度事件异常，最终结果仍须通过文件校验");
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item;
        if (!item || typeof item !== "object" || !validId(item.id) || typeof item.type !== "string")
          throw new Error("Invalid item event");
        if (item.type === "reasoning") {
          advance("recognizing");
          break;
        }
        if (item.type !== "agent_message") return;
        if (typeof item.text !== "string" && !(event.type === "item.started" && item.text === undefined))
          throw new Error("Invalid agent message event");
        if (!lengths.has(item.id) && lengths.size >= maxItems) {
          warn("识别进度条目超过限制，后续仅校验结果文件");
          disabled = true;
          lengths.clear();
          return;
        }
        const previous = lengths.get(item.id) ?? 0;
        const length = Math.max(previous, item.text?.length ?? 0);
        lengths.set(item.id, length);
        state.outputChars += length - previous;
        advance("receiving");
        break;
      }
      default: return;
    }
    state.eventCount += 1;
    lastActivity = now();
  }

  function line() {
    try {
      const text = decoder.decode(buffer.subarray(0, used));
      if (!/^[\t\r ]*$/.test(text)) accept(JSON.parse(text));
    } catch {
      warn("识别进度格式异常，已忽略异常事件；最终结果仍须通过文件校验");
    } finally { clear(); }
  }

  function push(chunk) {
    if (ended || disabled || stoppedAt !== null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxStreamBytes) {
      warn("识别进度流超过大小限制，后续仅校验结果文件");
      disabled = true;
      lengths.clear();
      clear();
      return;
    }
    let offset = 0;
    while (offset < bytes.length && !disabled) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const length = end - offset;
      if (!discarding) {
        if (used + length > maxLineBytes) {
          warn("单条识别进度超过大小限制，已忽略该事件；最终结果仍须通过文件校验");
          discarding = true;
          clear();
        } else if (length) {
          if (used + length > buffer.length) {
            const grown = Buffer.allocUnsafe(Math.min(maxLineBytes, Math.max(1024, buffer.length * 2, used + length)));
            buffer.copy(grown, 0, 0, used);
            buffer = grown;
          }
          bytes.copy(buffer, used, offset, end);
          used += length;
        }
      }
      if (newline !== -1) {
        if (!discarding) line();
        discarding = false;
      }
      offset = end + 1;
    }
  }

  function end() {
    if (ended || stoppedAt !== null) return;
    if (!disabled && !discarding && used) line();
    if (!state.eventCount) warn("未收到可识别的进度事件，最终结果仍须通过文件校验");
    ended = true;
    clear();
    lengths.clear();
  }

  function stop() {
    if (stoppedAt !== null) return;
    stoppedAt = now();
    ended = true;
    clear();
    lengths.clear();
  }

  return {
    push, end, stop,
    streamError() {
      if (stoppedAt !== null) return;
      warn("识别进度流读取失败，后续仅校验结果文件");
      disabled = true;
      clear();
      lengths.clear();
    },
    validating: () => advance("validating"),
    complete(nodeCount) {
      if (stoppedAt !== null) return;
      state.nodeCount = nodeCount;
      advance("complete");
      stop();
    },
    message: () => messages[state.stage],
    snapshot: () => ({ ...state, activityAgeMs: lastActivity === null ? null : Math.max(0, (stoppedAt ?? now()) - lastActivity) }),
  };
}
