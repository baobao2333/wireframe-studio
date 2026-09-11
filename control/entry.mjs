import { startMcpServer } from "./mcp-server.mjs";
import { controlRequest } from "./client.mjs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function runControlMode({ cli = false, connectionPath } = {}) {
  if (!cli) return startMcpServer({ connectionPath });
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw Error("控制请求超过 256 KB");
    chunks.push(chunk);
  }
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await controlRequest(command.tool, command.args, { connectionPath });
  await new Promise(resolve => process.stdout.write(JSON.stringify(result) + "\n", resolve));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cli = process.argv.includes("--codex-control");
    if (!cli && !process.argv.includes("--codex-mcp")) throw Error("Specify --codex-mcp or --codex-control");
    const connectionPath = process.env.WIREFRAME_TEST_USER_DATA ? join(resolve(process.env.WIREFRAME_TEST_USER_DATA), "control/connection.json") : undefined;
    const result = await runControlMode({ cli, connectionPath });
    if (cli) process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
