import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import grapesjs from "grapesjs";
import { controlTools } from "../control/schema.mjs";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".svg?raw")) {
      const resolved = next(specifier.slice(0, -4), context);
      return { ...resolved, url: resolved.url + "?raw" };
    }
    if (context.parentURL?.includes("/lib/") && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(specifier + ".ts", context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".svg?raw")) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}` };
    return next(url, context);
  },
});
const { createCodexController } = await import("../lib/codex-control.ts");
const { componentDefinition, registerLibrary } = await import("../lib/editor-library.ts");
const { makeNode } = await import("../lib/wireframe.ts");
hooks.deregister();

if (process.versions.electron) void electronCheck();
else if (process.argv.includes("--browser")) await launchBrowserCheck();
else {
const wait = () => new Promise(resolve => setTimeout(resolve, 3));
const project = editor => JSON.parse(JSON.stringify(editor.getProjectData()));
let checks = 0;
function fixture() {
  const editor = grapesjs.init({ headless: true, storageManager: false, avoidInlineStyle: true, dragMode: "absolute", styleManager: { sectors: [] } });
  registerLibrary(editor);
  editor.UndoManager.postLoad();
  const frame = editor.getWrapper().append(componentDefinition(makeNode("frame", { name: "Panel", x: 10, y: 20 })))[0];
  const first = frame.append(componentDefinition(makeNode("text", { name: "Title", text: "Original", x: 20, y: 30, w: 180, h: 40 })))[0];
  const second = frame.append(componentDefinition(makeNode("text", { name: "Amount", text: "$99.09", x: 30, y: 90, w: 180, h: 40 })))[0];
  const rich = frame.append(componentDefinition(makeNode("richtext", { name: "Rich", x: 30, y: 140 })))[0];
  const other = editor.getWrapper().append(componentDefinition(makeNode("frame", { name: "Other", x: 400, y: 20 })))[0];
  editor.select(first);
  editor.UndoManager.clear();
  let meta = { name: "Control regression", notes: "Keep layout", width: 1120, height: 760, reference: { src: "data:image/png;base64,SECRET_IMAGE", name: "reference.png", width: 1120, height: 760 } };
  let allowed = true, failSave = false, saves = 0;
  const summaries = [];
  const controller = createCodexController(editor, {
    getMeta: () => meta,
    setMeta: value => { meta = value; },
    canExecute: () => allowed,
    persist: async () => { saves++; if (failSave) throw Error("Disk unavailable"); },
    onTransaction: summary => summaries.push(summary),
  });
  let sequence = 0;
  const state = () => controller.execute("wireframe_get_state", {});
  const write = async (operations, extra = {}) => controller.execute("wireframe_apply", { requestId: `test-${++sequence}`, expectedRevision: (await state()).revision, summary: "Regression batch", operations, ...extra });
  const history = async redo => controller.execute(redo ? "wireframe_redo" : "wireframe_undo", { requestId: `history-${++sequence}`, expectedRevision: (await state()).revision });
  return { editor, controller, frame, first, second, rich, other, state, write, history, getMeta: () => meta, replaceMeta: value => { meta = value; }, allow: value => { allowed = value; }, failSave: value => { failSave = value; }, saves: () => saves, summaries, close: () => { controller.dispose(); editor.destroy(); } };
}
async function test(name, run) {
  const f = fixture();
  try { await wait(); await run(f); console.log(`ok ${++checks} - ${name}`); }
  finally { f.close(); }
}
function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function rejected(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code, JSON.stringify(result)); assert.equal(result.applied, false); return result; }

await test("shared strict schemas and bounded, cloned reads without image data or HTML", async f => {
  assert.equal(controlTools.length, 7);
  for (const tool of controlTools) assert.ok(tool.inputSchema.shape);
  f.allow(false);
  const before = project(f.editor), state = success(await f.state());
  assert.match(state.revision, /^[0-9a-f-]{36}:\d+$/);
  assert.ok(state.outline.some(node => node.id === f.first.getId()));
  assert.ok(!JSON.stringify(state).includes("SECRET_IMAGE"));
  assert.ok(!JSON.stringify(state).includes("<div"));
  state.document.name = "Mutated response";
  assert.equal(f.getMeta().name, "Control regression");
  const details = success(await f.controller.execute("wireframe_get_components", { ids: [f.first.getId(), f.rich.getId()] }));
  assert.equal(details.components[0].text, "Original");
  assert.equal(details.components[0].geometry.x, 20);
  assert.equal(details.components[0].locked, false, "Canvas wrapper must not mark every layer locked");
  assert.equal(details.components[1].runs.length, 2);
  const library = success(await f.controller.execute("wireframe_list_library", {}));
  assert.ok(library.blocks.some(block => block.id === "base-text"));
  assert.deepEqual(project(f.editor), before);
  rejected(await f.write([{ op: "set_text", id: f.first.getId(), text: "No" }]), "EDITOR_BUSY");
  f.allow(true);
  rejected(await f.write([{ op: "set_style", id: f.first.getId(), style: { "background-image": "url(https://example.com)" } }]), "INVALID_ARGUMENTS");
  rejected(await f.write([{ op: "set_style", id: f.first.getId(), style: { "font-size": "22px; color:red" } }]), "INVALID_ARGUMENTS");
  rejected(await f.controller.execute("wireframe_get_state", { html: "<script/>" }), "INVALID_ARGUMENTS");
});

await test("atomic batch text, literal HTML characters, styles, geometry and native single-step undo/redo", async f => {
  const before = project(f.editor), stack = f.editor.UndoManager.getStack();
  const result = success(await f.write([
    { op: "set_text", id: f.first.getId(), text: "Literal <img src=x onerror=alert(1)> & $10" },
    { op: "set_style", id: f.first.getId(), style: { "font-size": 24, color: "#aabbcc", "-webkit-text-stroke-width": 1, "-webkit-text-stroke-color": "#112233" } },
    { op: "set_geometry", id: f.first.getId(), geometry: { x: 61, y: 47, width: 220 } },
    { op: "set_properties", id: f.first.getId(), properties: { note: "Keep the amount literal", reviewed: false, priority: "primary", name: "Edited title" } },
    { op: "select", ids: [f.second.getId()] },
  ]));
  assert.equal(result.saved, true);
  assert.equal(stack.length, 1);
  assert.equal(f.first.getStyle()["font-size"], "24px");
  assert.equal(f.first.getStyle().left, "61px");
  assert.match(f.editor.getHtml(), /&lt;img/);
  assert.ok(!f.editor.getHtml().includes("<img src=x"));
  const after = project(f.editor);
  f.editor.UndoManager.undo();
  assert.deepEqual(project(f.editor), before);
  assert.equal(f.editor.getSelected(), f.first);
  f.editor.UndoManager.redo();
  assert.deepEqual(project(f.editor), after);
  assert.equal(f.editor.getSelected(), f.second);
  assert.equal(f.saves(), 1);
});

await test("manual edits, control transaction and redo remain interleaved", async f => {
  f.first.addStyle({ color: "#123456" });
  success(await f.write([{ op: "set_text", id: f.second.getId(), text: "Control text" }]));
  f.first.addStyle({ "font-size": "27px" });
  await wait();
  success(await f.history(false));
  assert.equal(f.first.getStyle()["font-size"], "16px");
  assert.equal(f.first.getStyle().color, "#123456");
  assert.equal(f.second.components().at(0).get("content"), "Control text");
  success(await f.history(false));
  assert.equal(f.second.components().at(0).get("content"), "$99.09");
  success(await f.history(false));
  assert.equal(f.first.getStyle().color, "#34363c");
  success(await f.history(true));
  success(await f.history(true));
  success(await f.history(true));
  assert.equal(f.first.getStyle()["font-size"], "27px");
  assert.equal(f.second.components().at(0).get("content"), "Control text");
});

await test("prevalidation rejects a late missing ID without any earlier edit or history", async f => {
  const before = project(f.editor);
  rejected(await f.write([{ op: "set_text", id: f.first.getId(), text: "Must not appear" }, { op: "set_style", id: "missing", style: { color: "#ffffff" } }]), "COMPONENT_NOT_FOUND");
  assert.deepEqual(project(f.editor), before);
  assert.equal(f.editor.UndoManager.getStack().length, 0);
  assert.equal(f.saves(), 0);
});

await test("runtime rejection rolls back new CSS/components and restores original redo tail", async f => {
  f.first.addStyle({ color: "#123456" });
  await wait();
  f.first.addStyle({ "font-size": "29px" });
  await wait();
  f.editor.UndoManager.undo();
  const before = project(f.editor), stack = f.editor.UndoManager.getStack(), original = [...stack.models], pointer = stack.pointer;
  const removeBefore = (_component, _remove, options) => { options.abort = true; };
  f.second.on("component:remove:before", removeBefore);
  const result = await f.write([
    { op: "add_block", blockId: "base-text", parentId: f.other.getId() },
    { op: "set_style", id: f.first.getId(), style: { color: "#abcdef" } },
    { op: "delete", ids: [f.second.getId()] },
  ]);
  rejected(result, "EDITOR_REJECTED");
  f.second.off("component:remove:before", removeBefore);
  assert.deepEqual(project(f.editor), before);
  assert.deepEqual(stack.models, original);
  assert.equal(stack.pointer, pointer);
  f.editor.UndoManager.redo();
  assert.equal(f.first.getStyle()["font-size"], "29px");
});

await test("rich text keeps literal runs and complex text replacement is rejected", async f => {
  rejected(await f.write([{ op: "set_text", id: f.rich.getId(), text: "Flatten" }]), "COMPLEX_TEXT");
  rejected(await f.write([{ op: "set_text", id: f.frame.getId(), text: "Erase children" }]), "COMPLEX_TEXT");
  success(await f.write([{ op: "set_rich_text", id: f.rich.getId(), runs: [
    { text: "$99", fontSize: 28, fontWeight: "700", color: "#ffffff", italic: false, underline: false },
    { text: ".09\n", fontSize: 16, fontWeight: "400", color: "none", italic: true, underline: true },
  ] }]));
  assert.equal(f.rich.components().length, 2);
  assert.equal(f.rich.components().at(1).getStyle().color, "transparent");
  const detail = success(await f.controller.execute("wireframe_get_components", { ids: [f.rich.getId()] }));
  assert.equal(detail.components[0].text, "$99.09\n");
  assert.equal(detail.components[0].runs.length, 2);
});

await test("wrapper and locks, including locked descendants, are protected", async f => {
  rejected(await f.write([{ op: "delete", ids: [f.editor.getWrapper().getId()] }]), "PROTECTED_COMPONENT");
  f.second.set("draggable", false);
  rejected(await f.write([{ op: "set_text", id: f.second.getId(), text: "No" }]), "LOCKED");
  rejected(await f.write([{ op: "set_geometry", id: f.frame.getId(), geometry: { x: 90 } }]), "LOCKED");
  rejected(await f.write([{ op: "delete", ids: [f.frame.getId()] }]), "LOCKED");
  f.second.set("draggable", true);
  success(await f.write([{ op: "set_style", id: f.second.getId(), style: { color: "#654321" } }]));
  f.editor.UndoManager.stop();
  f.second.set("draggable", false);
  f.editor.UndoManager.start();
  rejected(await f.history(false), "LOCKED");
});

await test("add, independent duplicate, hierarchy move and delete undo without CSS ghosts", async f => {
  const before = project(f.editor);
  const created = success(await f.write([{ op: "add_block", blockId: "base-text", parentId: f.other.getId(), geometry: { x: 32, y: 40 } }, { op: "duplicate", id: f.first.getId(), offsetX: 50, offsetY: 60 }]));
  assert.equal(created.addedIds.length, 2);
  const map = new Map(); f.editor.getWrapper().forEachChild(component => map.set(component.getId(), component));
  const copy = map.get(created.addedIds[1]);
  assert.notEqual(copy.getId(), f.first.getId());
  assert.equal(copy.getStyle().left, "70px");
  success(await f.write([{ op: "set_style", id: copy.getId(), style: { color: "#ff0000" } }, { op: "move", id: copy.getId(), parentId: f.other.getId(), index: 0 }]));
  assert.equal(f.first.getStyle().color, "#34363c");
  assert.equal(copy.parent(), f.other);
  rejected(await f.write([{ op: "move", id: f.other.getId(), parentId: copy.getId() }]), "INVALID_PARENT");
  success(await f.write([{ op: "delete", ids: [copy.getId()] }]));
  success(await f.history(false));
  success(await f.history(false));
  success(await f.history(false));
  assert.deepEqual(project(f.editor), before);
});

await test("same-parent reorder and virtual cycle/delete checks are prevalidated", async f => {
  success(await f.write([{ op: "move", id: f.first.getId(), parentId: f.frame.getId(), index: 2 }]));
  assert.equal(f.first.index(), 2);
  success(await f.write([{ op: "move", id: f.first.getId(), parentId: f.frame.getId(), index: 0 }]));
  assert.equal(f.first.index(), 0);
  const before = project(f.editor);
  rejected(await f.write([{ op: "move", id: f.other.getId(), parentId: f.frame.getId() }, { op: "move", id: f.frame.getId(), parentId: f.other.getId() }]), "PARENT_CYCLE");
  assert.deepEqual(project(f.editor), before);
  rejected(await f.write([{ op: "delete", ids: [f.frame.getId()] }, { op: "set_text", id: f.first.getId(), text: "Gone" }]), "COMPONENT_NOT_FOUND");
  assert.deepEqual(project(f.editor), before);
});

await test("metadata is undoable; object replacement, user edits and controller epochs invalidate revisions", async f => {
  const original = f.getMeta();
  success(await f.write([{ op: "set_document", document: { name: "Renamed", notes: "From Codex" } }, { op: "set_text", id: f.first.getId(), text: "Together" }]));
  assert.equal(f.getMeta().name, "Renamed");
  f.editor.UndoManager.undo();
  assert.equal(f.getMeta().name, original.name);
  assert.equal(f.first.components().at(0).get("content"), "Original");
  f.editor.UndoManager.redo();
  assert.equal(f.getMeta().name, "Renamed");
  const stale = (await f.state()).revision;
  f.replaceMeta({ ...f.getMeta() });
  rejected(await f.write([{ op: "select", ids: [] }], { expectedRevision: stale }), "REVISION_CONFLICT");
  const staleStyle = (await f.state()).revision;
  f.first.addStyle({ color: "#111111" });
  rejected(await f.write([{ op: "select", ids: [] }], { expectedRevision: staleStyle }), "REVISION_CONFLICT");
  const oldRevision = (await f.state()).revision;
  const next = createCodexController(f.editor, { getMeta: f.getMeta, setMeta: f.replaceMeta, persist: async () => {}, canExecute: () => true });
  const newState = await next.execute("wireframe_get_state", {});
  assert.notEqual(oldRevision.split(":")[0], newState.revision.split(":")[0]);
  rejected(await next.execute("wireframe_apply", { expectedRevision: oldRevision, requestId: "stale-after-reload", summary: "No", operations: [{ op: "select", ids: [] }] }), "REVISION_CONFLICT");
  next.dispose();
});

await test("save failure reports applied state, blocks concurrent writes and keeps undo available", async f => {
  f.failSave(true);
  const result = await f.write([{ op: "set_text", id: f.first.getId(), text: "Applied but unsaved" }]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERSIST_FAILED");
  assert.equal(result.applied, true);
  assert.equal(result.saved, false);
  assert.equal(f.first.components().at(0).get("content"), "Applied but unsaved");
  f.failSave(false);
  success(await f.history(false));
  assert.equal(f.first.components().at(0).get("content"), "Original");
  f.editor.trigger("rte:enable");
  rejected(await f.write([{ op: "select", ids: [] }]), "EDITOR_BUSY");
  success(await f.state());
  f.editor.trigger("rte:disable");
  f.controller.dispose();
  rejected(await f.state(), "DISPOSED");
});

await test("concurrent writes and a user edit before the transaction starts are rejected", async f => {
  const expectedRevision = (await f.state()).revision;
  const request = { expectedRevision, requestId: "concurrent-1", summary: "First write", operations: [{ op: "set_text", id: f.first.getId(), text: "First" }] };
  const pending = f.controller.execute("wireframe_apply", request);
  rejected(await f.controller.execute("wireframe_apply", { ...request, requestId: "concurrent-2" }), "EDITOR_BUSY");
  success(await pending);
  const stale = (await f.state()).revision;
  const racing = f.controller.execute("wireframe_apply", { ...request, expectedRevision: stale, requestId: "user-race", operations: [{ op: "set_text", id: f.first.getId(), text: "Must not replace user edit" }] });
  f.first.addStyle({ color: "#fedcba" });
  rejected(await racing, "REVISION_CONFLICT");
  assert.equal(f.first.components().at(0).get("content"), "First");
  assert.equal(f.first.getStyle().color, "#fedcba");
});

await test("large native-action batches remain one item at a small history limit", async f => {
  const stack = f.editor.UndoManager.getStack();
  stack.maximumStackLength = 2;
  f.first.addStyle({ color: "#123456" }); await wait();
  f.first.addStyle({ "background-color": "#fedcba" }); await wait();
  success(await f.write(Array.from({ length: 50 }, (_, index) => ({ op: "set_style", id: f.first.getId(), style: { "font-size": index + 8 } }))));
  assert.equal(stack.length, 2);
  f.editor.UndoManager.undo();
  assert.equal(f.first.getStyle()["font-size"], "16px");
  assert.equal(f.first.getStyle().color, "#123456");
  assert.equal(f.first.getStyle()["background-color"], "#fedcba");
  f.editor.UndoManager.redo();
  assert.equal(f.first.getStyle()["font-size"], "57px");
});

await test("raw library HTML is rejected and newly locked additions cannot be undone through control", async f => {
  f.editor.BlockManager.add("raw-html-block", { content: { tagName: "div", components: "<script>alert(1)</script>" } });
  const before = project(f.editor);
  rejected(await f.write([{ op: "add_block", blockId: "raw-html-block", parentId: null }]), "UNSAFE_BLOCK");
  assert.deepEqual(project(f.editor), before);
  const added = success(await f.write([{ op: "add_block", blockId: "base-text", parentId: f.frame.getId() }]));
  const component = f.frame.components().find(child => child.getId() === added.addedIds[0]);
  f.editor.UndoManager.stop(); component.set("draggable", false); f.editor.UndoManager.start();
  rejected(await f.history(false), "LOCKED");
});

console.log(`Passed ${checks} Codex control regressions with installed GrapesJS ${grapesjs.version}. No GUI, profile, model or network was used.`);
}

async function browserCheck() {
  const { default: grapes } = await import("/node_modules/grapesjs/dist/grapes.mjs");
  const { createCodexController } = await import("/lib/codex-control.ts");
  const { componentDefinition, registerLibrary, baseCanvasCss } = await import("/lib/editor-library.ts");
  const { makeNode } = await import("/lib/wireframe.ts");
  const { normalizeComponentStyle } = await import("/lib/component-snapshot.ts");
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const host = document.createElement("div"); document.body.appendChild(host);
  const editor = grapes.init({ container: host, height: "650px", storageManager: false, telemetry: false, cssIcons: "", panels: { defaults: [] }, avoidInlineStyle: true });
  let controller;
  try {
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error("Canvas load timed out")), 15000); editor.on("load", () => { clearTimeout(timeout); resolve(); }); });
    registerLibrary(editor);
    editor.setStyle(baseCanvasCss);
    editor.getWrapper().addStyle({ width: "640px", height: "360px", position: "relative", overflow: "hidden", "background-color": "#ffffff" });
    const panel = editor.getWrapper().append(componentDefinition(makeNode("frame", { x: 20, y: 20, w: 600, h: 320, fill: "#1459ac" })))[0];
    const title = panel.append(componentDefinition(makeNode("text", { text: "Control preview", x: 24, y: 24, w: 420, h: 60, fontSize: 28, color: "#ffffff" })))[0];
    editor.on("component:selected", component => editor.UndoManager.skip(() => normalizeComponentStyle(component)));
    editor.select(title); editor.UndoManager.clear();
    let meta = { name: "Isolated control check", notes: "", width: 640, height: 360 };
    let saves = 0;
    controller = createCodexController(editor, { getMeta: () => meta, setMeta: value => { meta = value; }, canExecute: () => true, persist: async () => { saves++; } });
    const before = JSON.stringify(editor.getProjectData());
    const state = await controller.execute("wireframe_get_state", {});
    const applied = await controller.execute("wireframe_apply", { requestId: "browser-apply", expectedRevision: state.revision, summary: "Update preview text and add a tag", operations: [
      { op: "set_text", id: title.getId(), text: "Saved $99.09" },
      { op: "set_style", id: title.getId(), style: { "font-size": 32, color: "#fff4a0" } },
      { op: "add_block", blockId: "base-tag", parentId: panel.getId(), geometry: { x: 30, y: 120, width: 160 } },
    ] });
    check(applied.ok && applied.saved, JSON.stringify(applied));
    check(title.getEl().textContent === "Saved $99.09", "Text did not update in the real canvas");
    check(title.getEl().ownerDocument.defaultView.getComputedStyle(title.getEl()).fontSize === "32px", "Real canvas style did not update");
    const after = JSON.stringify(editor.getProjectData());
    editor.UndoManager.undo();
    check(JSON.stringify(editor.getProjectData()) === before, "Native browser Undo did not restore the complete project");
    check(title.getEl().textContent === "Control preview", "Native browser Undo did not restore DOM text");
    editor.UndoManager.redo();
    check(JSON.stringify(editor.getProjectData()) === after, "Native browser Redo did not restore the batch");
    const preview = await controller.execute("wireframe_get_preview", {});
    check(preview.ok && preview.image?.mimeType === "image/png", JSON.stringify(preview));
    check(JSON.stringify(editor.getProjectData()) === after, "Preview modified the model");
    const bytes = Uint8Array.from(atob(preview.image.data), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0, yellow = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 20 && pixels[offset + 1] === 89 && pixels[offset + 2] === 172) blue++;
      if (pixels[offset] === 255 && pixels[offset + 1] === 244 && pixels[offset + 2] === 160) yellow++;
    }
    check(blue > 10000 && yellow > 100, "PNG pixels do not contain the expected panel and updated text colors");
    check(saves === 1, "Preview or native Undo unexpectedly called the control persist callback");
    const result = { passed: true, dimensions: [bitmap.width, bitmap.height], pngBytes: bytes.length, bluePixels: blue, textPixels: yellow, nativeUndoRedo: true, saves };
    bitmap.close();
    return result;
  } finally { controller?.dispose(); editor.destroy(); host.remove(); }
}

async function electronCheck() {
  const { app, BrowserWindow } = await import("electron");
  app.setName("Wireframe Isolated Codex Control Check");
  app.setPath("userData", process.env.WIREFRAME_CONTROL_CHECK_DATA);
  try {
    await app.whenReady();
    const window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL(process.env.WIREFRAME_CONTROL_CHECK_URL);
    const result = await window.webContents.executeJavaScript(`(${browserCheck.toString()})()`);
    window.destroy();
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}

async function launchBrowserCheck() {
  const { createServer } = await import("vite");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve, join, dirname, basename } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const root = resolve(import.meta.dirname, "..");
  const data = await mkdtemp(join(tmpdir(), "wireframe-control-check-"));
  const server = await createServer({ configFile: false, root, publicDir: false, appType: "custom", logLevel: "warn", optimizeDeps: { noDiscovery: true, include: ["fflate", "html-to-image", "zod"] }, server: { host: "127.0.0.1", port: 0, watch: null } });
  server.middlewares.use((request, response, next) => {
    if (request.url !== "/__control_check") return next();
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Isolated Codex control check</title>");
  });
  try {
    await server.listen();
    const electron = (await import("electron")).default;
    const env = { ...process.env, WIREFRAME_CONTROL_CHECK_DATA: data, WIREFRAME_CONTROL_CHECK_URL: `${server.resolvedUrls.local[0]}__control_check` };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [import.meta.filename], { cwd: root, env, stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error("Control browser check exceeded 90 seconds")); }, 90000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Control browser check failed (${code})`)); });
    });
  } finally {
    await server.close();
    assert.equal(dirname(data), resolve(tmpdir()));
    assert.ok(basename(data).startsWith("wireframe-control-check-"));
    await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
