import { spawn } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { findCodex } from "./vision-service.mjs";

const name = "wireframe-studio";
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error("Codex 配置操作超时，请重试")); }, 15000);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill(); reject(Error("Codex 配置结果过大")); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(Error("无法启动本机 Codex 配置工具")); });
    child.on("close", code => { clearTimeout(timer); if (code) reject(Error("Codex 配置操作未成功，现有配置未主动替换")); else resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

export async function registerCodexControl(executable, entry) {
  const args = [entry, "--codex-mcp"];
  const matches = transport => transport?.type === "stdio" &&
    resolve(transport.command).toLowerCase() === resolve(executable).toLowerCase() &&
    JSON.stringify(transport.args) === JSON.stringify(args) && transport.env?.ELECTRON_RUN_AS_NODE === "1";
  const codex = await findCodex();
  const list = JSON.parse(await run(codex, ["mcp", "list", "--json"]));
  if (!Array.isArray(list)) throw Error("无法读取 Codex MCP 配置");
  const existing = list.find(server => server.name === name);
  if (existing) {
    const transport = existing.transport;
    if (!matches(transport))
      throw Error("Codex 已有同名控制服务，未覆盖原配置");
    if (!existing.enabled) throw Error("Codex 中的线框控制服务已暂停，请先在 Codex 中启用");
    return { registered: true, changed: false };
  }
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const config = join(home, "config.toml");
  try {
    if ((await stat(config)).isFile()) {
      const backupDirectory = join(home, "backups");
      await mkdir(backupDirectory, { recursive: true });
      await copyFile(config, join(backupDirectory, `wireframe-control-${randomUUID()}.toml`));
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await run(codex, ["mcp", "add", name, "--env", "ELECTRON_RUN_AS_NODE=1", "--", executable, ...args]);
  const registered = JSON.parse(await run(codex, ["mcp", "list", "--json"])).find(server => server.name === name);
  if (!registered?.enabled || !matches(registered.transport))
    throw Error("Codex MCP 配置未通过回读验证");
  return { registered: true, changed: true };
}
