import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { controlStatus } from "../control/client.mjs";
import sharp from "sharp";
import { operationLogRecordSchema } from "../control/operation-log-schema.mjs";

const { values } = parseArgs({ options: { executable: { type: "string" }, project: { type: "string" }, "log-failure": { type: "boolean", default: false } } });
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, "work"), { recursive: true });
const data = await mkdtemp(join(root, "work/control-app-check-"));
await mkdir(join(data, "control"));
await mkdir(join(data, "documents"));
if (values["log-failure"]) {
  await mkdir(join(data, "logs"));
  await writeFile(join(data, "logs/operations"), "preserved broken log path");
}
await writeFile(join(data, "control/settings.json"), JSON.stringify({ enabled: true }));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const original = values.project ? hash(await readFile(values.project)) : null;
if (values.project) await copyFile(values.project, join(data, "documents/autosave.json"));
const executable = values.executable ? resolve(values.executable) : (await import("electron")).default;
const args = values.executable ? [] : [join(root, "desktop/main.mjs")];
const entry = values.executable ? join(dirname(executable), "resources/app.asar/control/entry.mjs") : join(root, "control/entry.mjs");
const env = { ...process.env, WIREFRAME_TEST_USER_DATA: data, WIREFRAME_TEST_HIDDEN: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", client;
for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { logs = (logs + bytes).slice(-30000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const connectionPath = join(data, "control/connection.json");
const snapshot = async () => {
  const { meta, editor } = JSON.parse(await readFile(join(data, "documents/autosave.json"), "utf8"));
  return { meta, editor };
};
const command = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(item => item.type === "text");
  const parsed = JSON.parse(text.text);
  return { ...parsed, image: result.content.find(item => item.type === "image") };
};
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
try {
  const deadline = Date.now() + 45000;
  for (;;) {
    assert.equal(child.exitCode, null, `App exited early: ${logs}`);
    try { if ((await controlStatus({ connectionPath })).ready) break; } catch { /* Wait for app boot, not a model task. */ }
    assert.ok(Date.now() < deadline, `App was not ready: ${logs}`);
    await sleep(200);
  }
  client = new Client({ name: "wireframe-isolated-app-check", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: executable, args: [entry, "--codex-mcp"], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stderr: "pipe" });
  transport.stderr.on("data", bytes => { logs += `MCP: ${bytes}`; });
  try { await client.connect(transport); } catch (error) { throw Error(`${error.message}\n${logs}`); }
  assert.equal((await client.listTools()).tools.length, 7);
  let state = success(await command("wireframe_get_state", { limit: 200 }));
  assert.ok(state.total > 0);
  assert.ok(!JSON.stringify(state).includes("data:image"));
  const library = success(await command("wireframe_list_library"));
  assert.ok(library.blocks.some(block => block.id === "base-image"));
  const details = [];
  for (let offset = 0; offset < Math.min(state.outline.length, 150); offset += 50) {
    details.push(...success(await command("wireframe_get_components", { ids: state.outline.slice(offset, offset + 50).map(node => node.id) })).components);
  }
  const target = details.find(node => node.textEditable && !node.locked && node.geometry.css.position === "absolute");
  assert.ok(target, `No editable absolute-positioned text was found: ${JSON.stringify(details.slice(0, 12).map(({ id, kind, locked, textEditable, geometry }) => ({ id, kind, locked, textEditable, geometry })))}`);
  const before = await snapshot();
  const batch = {
    requestId: randomUUID(), expectedRevision: state.revision, summary: "Isolated acceptance: typography, position and image placeholder",
    operations: [
      { op: "set_text", id: target.id, text: "Codex control check" },
      { op: "set_style", id: target.id, style: { "font-size": 22, color: "#6a1538" } },
      { op: "set_geometry", id: target.id, geometry: { x: 30, width: 320 } },
      { op: "add_block", blockId: "base-image", parentId: null, geometry: { x: 30, y: 180, width: 240, height: 130 } },
    ],
  };
  const applied = success(await command("wireframe_apply", batch));
  assert.equal(applied.saved, true);
  assert.equal(applied.addedIds.length, 1);
  assert.deepEqual(await command("wireframe_apply", batch), applied, "Retry was not idempotent");
  const stale = await command("wireframe_apply", { ...batch, requestId: randomUUID() });
  assert.equal(stale.error.code, "REVISION_CONFLICT");
  const changed = success(await command("wireframe_get_components", { ids: [target.id, ...applied.addedIds] }));
  assert.equal(changed.components[0].text, "Codex control check");
  assert.equal(changed.components[0].style["font-size"], "22px");
  assert.equal(changed.components[0].geometry.x, 30);
  assert.equal(changed.components[1].geometry.width, 240);
  const after = await snapshot();
  assert.notDeepEqual(after, before);
  const preview = success(await command("wireframe_get_preview"));
  const png = Buffer.from(preview.image.data, "base64");
  await writeFile(join(data, "control-preview.png"), png);
  const metadata = await sharp(png).metadata();
  assert.ok(metadata.width >= state.document.width && metadata.height >= state.document.height);
  const { channels } = await sharp(png).stats();
  assert.ok(channels.slice(0, 3).some(channel => channel.stdev > 10), "Blank preview");
  state = success(await command("wireframe_get_state"));
  const undone = success(await command("wireframe_undo", { expectedRevision: state.revision, requestId: randomUUID() }));
  assert.deepEqual(await snapshot(), before, "One undo did not restore the saved project");
  const redone = success(await command("wireframe_redo", { expectedRevision: undone.revision, requestId: randomUUID() }));
  assert.deepEqual(await snapshot(), after, "One redo did not restore the saved batch");
  await command("wireframe_undo", { expectedRevision: redone.revision, requestId: randomUUID() });
  const cliResult = await new Promise((resolve, reject) => {
    const process = spawn(executable, [entry, "--codex-control"], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => { process.kill(); reject(Error("One-shot control exceeded 20 seconds")); }, 20000);
    process.stdout.on("data", bytes => { output += bytes; });
    process.stderr.on("data", bytes => { errors += bytes; });
    process.once("error", reject);
    process.once("exit", code => { clearTimeout(timer); try { assert.equal(code, 0, errors); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    process.stdin.end(JSON.stringify({ tool: "wireframe_get_state", args: {} }));
  });
  assert.equal(cliResult.document.name, state.document.name);
  const logPath = join(data, "logs/operations/operations.jsonl");
  const logDeadline = Date.now() + 5000;
  let operationRecords = [], operationText;
  if (values["log-failure"]) {
    assert.equal(await readFile(join(data, "logs/operations"), "utf8"), "preserved broken log path");
    assert.match(logs, /Operation log: PATH_UNSAFE/, "Log failures must be reported through IPC");
  } else {
  for (;;) {
    operationText = await readFile(logPath, "utf8");
    if (operationText.endsWith("\n")) {
      operationRecords = operationText.trim().split("\n").map(line => operationLogRecordSchema.parse(JSON.parse(line)));
      if (operationRecords.some(record => record.event === "control.outcome" && record.code === "OK")) break;
    }
    assert.ok(Date.now() < logDeadline, "Installed renderer did not persist control operation logs");
    await sleep(100);
  }
  for (const event of ["session.start", "project.load", "project.save.start", "project.save", "component.update", "component.style", "control.outcome"])
    assert.ok(operationRecords.some(record => record.event === event), `Missing operation event: ${event}`);
  assert.ok(operationRecords.some(record => record.componentId === target.id && record.event === "component.style"
    && record.after?.x === 30 && record.after?.width === 320 && record.changedProperties?.includes("left")), "Geometry style changes were not recorded accurately");
  assert.ok(operationRecords.every((record, index) => record.sequence === index + 1));
  for (const privateValue of ["Codex control check", "data:image", "Isolated acceptance:", state.document.name])
    assert.ok(!operationText.includes(privateValue), `Operation log leaked private content: ${privateValue}`);
  }
  if (values.project) assert.equal(hash(await readFile(values.project)), original, "Original project changed");
  console.log(JSON.stringify({ passed: true, packaged: !!values.executable, document: state.document.name, components: state.total, library: library.blocks.length, preview: join(data, "control-preview.png"), nativeUndoRedo: true, durableSave: true, idempotent: true, conflict: true, stdioAndCli: true, originalUnchanged: true, localOperationRecords: operationRecords.length, injectedLogFailure: values["log-failure"], privateContentExcluded: !values["log-failure"] }));
} finally {
  await client?.close();
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
  await writeFile(join(data, "app.log"), logs);
}
