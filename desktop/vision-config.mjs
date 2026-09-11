import { spawn } from "node:child_process";
export const visionFeatureOptions = ["shell_tool", "unified_exec", "apps", "plugins", "memories", "browser_use", "computer_use", "image_generation", "code_mode_host", "multi_agent", "view_image", "hooks"].flatMap(key => ["--disable", key]);

export async function isolatedVisionMcpOptions(executable, spawnImpl = spawn) {
  const output = await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [...visionFeatureOptions, "mcp", "list", "--json"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error("读取识别工具配置超时，尚未提交图片")); }, 10000);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); reject(Error("识别工具配置超过大小限制，尚未提交图片")); }
      else chunks.push(chunk);
    });
    child.stdout.once("error", () => { child.kill(); reject(Error("Codex 工具配置读取失败，尚未提交图片")); });
    child.stderr.on("error", () => {});
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(Error("无法读取本机 Codex 工具配置，尚未提交图片")); });
    child.once("close", code => { clearTimeout(timer); if (code !== 0) reject(Error("无法隔离识别工具，尚未提交图片")); else resolve(Buffer.concat(chunks).toString("utf8")); });
  });
  let servers;
  try { servers = JSON.parse(output); } catch { throw Error("Codex 工具配置不是有效 JSON，尚未提交图片"); }
  if (!Array.isArray(servers) || servers.length > 500 || servers.some(server => !server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(server.name)))
    throw Error("Codex 工具配置无效，尚未提交图片");
  // Empty TOML tables merge with the user config; disable each server explicitly.
  return servers.flatMap(server => ["-c", `mcp_servers.${server.name}.enabled=false`]);
}
