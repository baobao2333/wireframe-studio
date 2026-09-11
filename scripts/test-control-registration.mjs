import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { registerCodexControl } from "../desktop/control-registration.mjs";

const home = await mkdtemp(resolve(import.meta.dirname, "../work/registration-check-"));
const originalHome = process.env.CODEX_HOME;
const prior = 'model = "preserve-model"\n[mcp_servers.existing]\ncommand = "not-started.exe"\nargs = []\napproval_mode = "always"\n';
const executable = join(process.env.LOCALAPPDATA, "Programs/Wireframe Studio/Wireframe Studio.exe");
const entry = join(process.env.LOCALAPPDATA, "Programs/Wireframe Studio/resources/app.asar/control/entry.mjs");
try {
  process.env.CODEX_HOME = home;
  await writeFile(join(home, "config.toml"), prior);
  assert.equal((await registerCodexControl(executable, entry)).changed, true);
  const after = await readFile(join(home, "config.toml"), "utf8");
  assert.ok(after.startsWith(prior + "\n"));
  assert.equal((await registerCodexControl(executable, entry)).changed, false);
  await assert.rejects(() => registerCodexControl(executable, entry + ".different"), /未覆盖/);
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), after);
  await writeFile(join(home, "new-server.toml"), after.slice(prior.length + 1));
  console.log(JSON.stringify({ passed: true, priorBytesPreserved: true, repeatIsUnchanged: true, conflictRejected: true, home }));
} finally {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
}
