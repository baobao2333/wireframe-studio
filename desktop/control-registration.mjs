import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, open, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { findCodex } from "./vision-service.mjs";

const name = "wireframe-studio";
function run(exe, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const readCurrent = async () => { try { return await readFile(config); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const before = await readCurrent();
  // The CLI rewrites every MCP table and drops fields unknown to its version.
  // Generate only the new table in isolation, then preserve existing bytes exactly.
  const temporary = await mkdtemp(join(tmpdir(), "wireframe-codex-registration-"));
  const staging = join(home, `config.wireframe-${randomUUID()}.tmp`);
  try {
    const env = { ...process.env, CODEX_HOME: temporary };
    await run(codex, ["mcp", "add", name, "--env", "ELECTRON_RUN_AS_NODE=1", "--", executable, ...args], env);
    const generated = JSON.parse(await run(codex, ["mcp", "list", "--json"], env));
    if (generated.length !== 1 || generated[0].name !== name || !matches(generated[0].transport)) throw Error("Codex 控制配置生成失败");
    const addition = await readFile(join(temporary, "config.toml"));
    await mkdir(home, { recursive: true });
    if (before) {
      const backupDirectory = join(home, "backups");
      await mkdir(backupDirectory, { recursive: true });
      await copyFile(config, join(backupDirectory, `wireframe-control-${randomUUID()}.toml`));
    }
    const handle = await open(staging, "wx", 0o600);
    try { await handle.writeFile(Buffer.concat([before || Buffer.alloc(0), Buffer.from("\n"), addition])); await handle.sync(); }
    finally { await handle.close(); }
    const current = await readCurrent();
    if (before ? !current?.equals(before) : current !== null) throw Error("Codex 配置在连接期间发生变化，未覆盖，请重试");
    await rename(staging, config);
  } finally {
    await rm(staging, { force: true });
    if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith("wireframe-codex-registration-")) throw Error("Unexpected configuration staging path");
    await rm(temporary, { recursive: true, force: true });
  }
  const registered = JSON.parse(await run(codex, ["mcp", "list", "--json"])).find(server => server.name === name);
  if (!registered?.enabled || !matches(registered.transport))
    throw Error("Codex MCP 配置未通过回读验证");
  return { registered: true, changed: true };
}
