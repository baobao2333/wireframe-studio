import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "./storage.mjs";

const LIMIT = 256 * 1024;
const failure = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });

export async function createControlService({ directory, tools, execute, onState = () => {}, waitMs = 10000 }) {
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw Error("Codex 控制目录不能是链接");
  const settingsPath = join(directory, "settings.json"), connectionPath = join(directory, "connection.json");
  let enabled = false, ready = false, disposed = false, configuring = false, running = null, lastContact = 0, lastCommand, error;
  let token = randomBytes(32).toString("hex");
  const sessionId = randomUUID(), cache = new Map();
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    if (typeof settings.enabled !== "boolean") throw Error("Codex 控制设置损坏");
    enabled = settings.enabled;
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const status = () => ({ enabled, ready: ready && !disposed, connected: Date.now() - lastContact < 90000, busy: Boolean(running) || configuring, lastCommand, error });
  const publish = () => onState(status());
  const json = (response, code, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  const authenticate = (request) => {
    const provided = Buffer.from(request.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  const body = async (request) => {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > LIMIT) throw Error("BODY_LIMIT");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const awaitResult = async (entry) => {
    let timeout;
    try {
      return await Promise.race([entry.promise, new Promise(resolve => {
        timeout = setTimeout(() => resolve(failure("IN_PROGRESS", "命令仍在执行，请使用同一个 requestId 重试，不要重复提交新命令。", { requestId: entry.id })), waitMs);
      })]);
    } finally { clearTimeout(timeout); }
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${server.address().port}` || request.headers.origin || request.headers["sec-fetch-site"])
        return json(response, 403, failure("LOCAL_ONLY", "只接受已认证的本机工具连接"));
      if (!enabled || disposed || !authenticate(request)) return json(response, 401, failure("UNAUTHORIZED", "请在应用中启用 Codex 控制"));
      lastContact = Date.now(); publish();
      if (request.method === "GET" && request.url === "/status") return json(response, 200, { ok: true, sessionId, ...status() });
      if (request.method !== "POST" || request.url !== "/command") return json(response, 404, failure("NOT_FOUND", "不支持的控制请求"));
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) return json(response, 415, failure("JSON_REQUIRED", "控制请求必须是 JSON"));
      if (Number(request.headers["content-length"]) > LIMIT) return json(response, 413, failure("BODY_LIMIT", "控制请求超过 256 KB"));
      let packet;
      try { packet = await body(request); }
      catch (e) { return json(response, e.message === "BODY_LIMIT" ? 413 : 400, failure("INVALID_REQUEST", "控制请求格式无效或超过限制")); }
      // Permission may be revoked while an authenticated request body is arriving.
      if (!enabled || disposed || !authenticate(request)) return json(response, 401, failure("UNAUTHORIZED", "请在应用中启用 Codex 控制"));
      if (configuring) return json(response, 409, failure("BUSY", "控制连接正在切换，请稍后重试"));
      if (!packet || typeof packet !== "object" || Array.isArray(packet) || Object.keys(packet).some(k => !["tool", "args"].includes(k)))
        return json(response, 400, failure("INVALID_REQUEST", "控制请求必须包含 tool 和 args"));
      const tool = tools.find(t => t.name === packet.tool);
      if (!tool) return json(response, 400, failure("UNKNOWN_TOOL", "应用不支持该控制工具"));
      const parsed = tool.inputSchema.safeParse(packet.args);
      if (!parsed.success) return json(response, 400, failure("INVALID_ARGUMENTS", "工具参数未通过校验", {
        issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      }));
      const args = parsed.data;
      const id = tool.readOnly ? randomUUID() : args.requestId;
      if (!tool.readOnly && (typeof id !== "string" || !id)) return json(response, 400, failure("REQUEST_ID_REQUIRED", "修改命令需要 requestId"));
      const fingerprint = createHash("sha256").update(JSON.stringify({ tool: tool.name, args })).digest("hex");
      const prior = cache.get(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) return json(response, 409, failure("REQUEST_ID_CONFLICT", "同一个 requestId 不能用于不同的修改"));
        return json(response, 200, await awaitResult(prior));
      }
      if (!ready) return json(response, 409, failure("NOT_READY", "编辑器尚未就绪，请等待工程载入完成"));
      if (running) return json(response, 409, failure("BUSY", "另一条控制命令尚未完成，请稍后重试"));
      const entry = { id, fingerprint, promise: null, complete: false };
      running = entry; error = undefined; publish();
      entry.promise = Promise.resolve().then(() => execute(tool.name, args)).then(result => {
        if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw Error("INVALID_RESULT");
        if (!tool.readOnly) lastCommand = { summary: args.summary || ({ wireframe_undo: "撤销会话修改", wireframe_redo: "重做会话修改" }[tool.name]) || tool.name,
          at: new Date().toISOString(), status: result.ok ? "applied" : "failed" };
        if (!result.ok) error = result.error?.message || "控制命令未完成";
        return result;
      }).catch(() => {
        error = "控制连接中断，结果未确认；请先读取当前工程，不要重复提交新命令。";
        if (!tool.readOnly) lastCommand = { summary: args.summary || tool.name, at: new Date().toISOString(), status: "failed" };
        return failure("RESULT_UNKNOWN", error, { applied: null, saved: false });
      }).finally(() => { entry.complete = true; if (running === entry) running = null; publish(); });
      if (!tool.readOnly) {
        cache.set(id, entry);
        if (cache.size > 512) {
          const oldest = [...cache].find(([, value]) => value.complete);
          if (oldest) cache.delete(oldest[0]);
        }
      }
      json(response, 200, await awaitResult(entry));
    } catch { json(response, 500, failure("CONTROL_ERROR", "控制服务未完成请求")); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const writeConnection = async () => {
    if (enabled) await atomicJson(connectionPath, { version: 1, host: "127.0.0.1", port: server.address().port, token, sessionId, pid: process.pid });
    else await rm(connectionPath, { force: true });
  };
  try { await writeConnection(); }
  catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  return {
    status,
    async configure(next) {
      if (typeof next !== "boolean") throw Error("控制状态无效");
      if (running || configuring) throw Error("请等待当前控制命令完成");
      if (disposed) throw Error("控制服务已停止");
      configuring = true; publish();
      try {
        await atomicJson(settingsPath, { enabled: next });
        if (next !== enabled) { token = randomBytes(32).toString("hex"); lastContact = 0; }
        enabled = next;
        try { await writeConnection(); }
        catch { error = "无法保存控制连接，请重新启用控制"; throw Error(error); }
        error = undefined;
      } finally { configuring = false; publish(); }
      return status();
    },
    setReady(next) { ready = next; publish(); },
    async dispose() {
      if (disposed) return;
      disposed = true; ready = false; publish();
      try {
        try {
          const connection = JSON.parse(await readFile(connectionPath, "utf8"));
          if (connection.sessionId === sessionId) await rm(connectionPath, { force: true });
        } catch (e) { if (e.code !== "ENOENT") throw e; }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
}
