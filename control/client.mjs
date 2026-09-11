import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";

export function defaultConnectionPath() {
  if (!process.env.APPDATA) throw Error("Windows 用户目录不可用");
  return join(process.env.APPDATA, "Wireframe Studio", "control", "connection.json");
}

async function localRequest(method, path, payload, { connectionPath = defaultConnectionPath(), signal } = {}) {
  let connection;
  try {
    const info = await lstat(connectionPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error("INVALID_CONNECTION");
    connection = JSON.parse(await readFile(connectionPath, "utf8"));
  } catch { throw Error("请先打开线框工坊，并在 Codex 控制面板中连接或启用控制。"); }
  if (connection.version !== 1 || connection.host !== "127.0.0.1" || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token))
    throw Error("本机控制连接信息无效，请在应用中重新启用控制。");
  if (payload.length > 256 * 1024) throw Error("控制请求超过 256 KB，请拆成更小的修改批次。");
  return new Promise((resolve, reject) => {
    const req = request({ hostname: connection.host, port: connection.port, method, path, signal,
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", "Content-Length": payload.length } }, response => {
      let size = 0; const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) { response.destroy(); reject(Error("控制结果超过 24 MB，请缩小读取范围。")); }
        else chunks.push(chunk);
      });
      response.on("error", () => reject(Error("控制响应中断，结果未确认。修改重试必须保留原 requestId。")));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(Error("控制服务返回了无效结果。")); }
      });
    });
    req.setTimeout(20000, () => req.destroy(Error("CONTROL_TIMEOUT")));
    req.on("error", () => reject(Error("无法连接当前线框工坊，或请求已中断。修改重试必须保留原 requestId。")));
    req.end(payload);
  });
}

export const controlRequest = (tool, args, options) => localRequest("POST", "/command", Buffer.from(JSON.stringify({ tool, args })), options);
export const controlStatus = options => localRequest("GET", "/status", Buffer.alloc(0), options);
