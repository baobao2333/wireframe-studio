import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function ready(port, details = "") {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Wireframe Studio: ${url}${details}`);
  if (process.argv.includes("--open"))
    spawn("explorer.exe", [url], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  process.exit(0);
}
async function isStudio(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/vision/status`, {
      signal: AbortSignal.timeout(1200),
    });
    const status = await response.json();
    return status.local === true && status.engine === "本机 Codex";
  } catch {
    return false;
  }
}
function portFree(port) {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", (error) =>
      error.code === "EADDRINUSE" ? resolve(false) : reject(error),
    );
    socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
  });
}

let port = 5187;
while (!(await portFree(port))) {
  if (await isStudio(port)) {
    ready(port);
  }
  if (++port > 5207) throw Error("No free local port from 5187 to 5207.");
}
const prepare = spawnSync(
  process.execPath,
  [resolve(root, "scripts/prepare-ocr.mjs")],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (prepare.status !== 0)
  throw Error(
    "OCR asset preparation failed. Install dependencies with npm install first.",
  );
const runtime = resolve(root, ".wireframe-runtime");
mkdirSync(runtime, { recursive: true });
const logPath = resolve(runtime, `server-${Date.now()}.log`),
  log = openSync(logPath, "a");
const packagePath = resolve(root, "node_modules/vinext/package.json");
const entry = resolve(
  root,
  "node_modules/vinext",
  JSON.parse(readFileSync(packagePath, "utf8")).bin.vinext,
);
const child = spawn(
  process.execPath,
  [entry, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log] },
);
closeSync(log);
let failure;
child.on("error", (error) => {
  failure = error;
});
child.on("exit", (code) => {
  failure = Error(`Server exited (${code}). See ${logPath}`);
});
child.unref();
for (let attempt = 0; attempt < 45; attempt++) {
  if (failure) throw failure;
  if (await isStudio(port)) {
    ready(port, `\nPID: ${child.pid}\nLog: ${logPath}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
throw Error(`Server did not become ready. See ${logPath}`);
