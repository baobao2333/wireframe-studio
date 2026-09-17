import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import grapesjs from "grapesjs";
import formsModule from "grapesjs-plugin-forms";
import {
  captureLibraryComponent,
  normalizeComponentStyle,
} from "../lib/component-snapshot.ts";
import { normalizeToolbarPointer } from "../lib/editor-geometry.ts";
import {
  exportHtml,
  studioFile,
  validateStudioFile,
  fixedCanvasFile,
} from "../lib/grapes-export.ts";

// Match Vite's raw SVG imports while exercising the real component definitions in Node.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".svg?raw")) {
      const resolved = next(specifier.slice(0, -4), context);
      return { ...resolved, url: resolved.url + "?raw" };
    }
    if (context.parentURL?.endsWith("/lib/editor-library.ts") && ["./wireframe", "./icon-assets"].includes(specifier))
      return next(specifier + ".ts", context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".svg?raw")) return {
      format: "module", shortCircuit: true,
      source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`,
    };
    return next(url, context);
  },
});
const { componentDefinition, readIcon, updateIcon, measureIconSymbol, fitIconSymbol, registerLibrary } = await import("../lib/editor-library.ts");
const { makeNode } = await import("../lib/wireframe.ts");
const { iconAssets } = await import("../lib/icon-assets.ts");
hooks.deregister();

const editor = grapesjs.init({
  headless: true,
  storageManager: false,
  dragMode: "absolute",
  avoidInlineStyle: true,
  plugins: [(e) => formsModule.default(e, { blocks: [] })],
});
const meta = {
  name: "Library regression",
  notes: "",
  width: 1120,
  height: 760,
};
try {
  const transparentRun = componentDefinition(makeNode("richtext", {
    text: "Hidden", runs: [{ text: "Hidden", fontSize: 16, fontWeight: "400", color: "none", italic: false, underline: false }],
  }));
  assert.equal(transparentRun.components[0].style.color, "transparent");
  editor.setStyle("body{margin:0}");
  editor.setComponents([
    {
      tagName: "section",
      name: "Metric",
      resizable: true,
      attributes: {
        "data-spec-id": "source-parent",
        "data-note": "Keep hierarchy",
      },
      style: {
        position: "absolute",
        left: "48px",
        top: "64px",
        width: "280px",
        height: "130px",
      },
      components: [
        {
          type: "text",
          tagName: "span",
          content: "2,480",
          attributes: { "data-spec-id": "source-text" },
          style: {
            "font-size": "34px",
            "font-weight": "700",
            color: "#147d67",
          },
        },
        {
          type: "input",
          attributes: { placeholder: "Email" },
          style: { width: "160px" },
        },
      ],
    },
  ]);
  const original = editor.getWrapper().components().at(0);
  const definition = captureLibraryComponent(original);
  assert.doesNotThrow(() => structuredClone(definition));
  assert.equal(definition.attributes.id, undefined);
  assert.equal(definition.attributes["data-spec-id"], undefined);
  const copy = editor.getWrapper().append(definition)[0];
  assert.notEqual(copy.getId(), original.getId());
  assert.deepEqual(copy.getStyle(), original.getStyle());
  assert.deepEqual(
    copy.components().at(0).getStyle(),
    original.components().at(0).getStyle(),
  );
  assert.equal(
    copy.components().at(1).getTrait("placeholder").getValue(),
    "Email",
  );
  copy.components().at(0).addStyle({ "font-size": "24px" });
  assert.equal(original.components().at(0).getStyle()["font-size"], "34px");
  const snapshot = JSON.parse(JSON.stringify(studioFile(editor, meta)));
  const oldCanvas = {
    ...snapshot,
    editor: {
      ...snapshot.editor,
      styles: [
        {
          selectors: ["metric"],
          style: { width: "280px" },
          atRuleType: "media",
          mediaText: "(max-width: 1120px)",
        },
      ],
    },
  };
  const repaired = fixedCanvasFile(oldCanvas);
  assert.equal(repaired.editor.styles[0].mediaText, "");
  assert.equal(oldCanvas.editor.styles[0].mediaText, "(max-width: 1120px)");
  assert.equal(repaired.meta.engineRevision, 2);
  validateStudioFile(snapshot);
  editor.loadProjectData(snapshot.editor);
  assert.equal(
    editor.getWrapper().components().at(1).components().at(0).getStyle()[
      "font-size"
    ],
    "24px",
  );
  editor.UndoManager.clear();
  const first = editor.getWrapper().components().at(0);
  first.addStyle({ left: "200px" });
  assert.ok(editor.UndoManager.hasUndo());
  editor.UndoManager.undo();
  assert.equal(first.getStyle().left, "48px");
  editor.UndoManager.redo();
  assert.equal(first.getStyle().left, "200px");
  const legacy = editor
    .getWrapper()
    .append({
      classes: ["shared-metric"],
      attributes: { style: "left:448px;top:48px;" },
    })[0];
  const computed = new Map(
    Object.entries({
      left: "448px",
      top: "48px",
      width: "280px",
      height: "130px",
      "inset-inline-start": "448px",
      "block-size": "130px",
      color: "rgb(20, 125, 103)",
    }),
  );
  const declaration = (values) => ({
    [Symbol.iterator]: () => values.keys(),
    getPropertyValue: (key) => values.get(key) || "",
  });
  legacy.getEl = () => ({
    nodeType: 1,
    style: declaration(
      new Map([
        ["left", "448px"],
        ["top", "48px"],
      ]),
    ),
    ownerDocument: {
      defaultView: { getComputedStyle: () => declaration(computed) },
    },
  });
  const captured = captureLibraryComponent(legacy);
  assert.equal(captured.style.width, "280px");
  assert.equal(captured.style.left, "448px");
  assert.equal(captured.attributes.style, undefined);
  assert.deepEqual(captured.classes, []);
  assert.equal(captured.style["inset-inline-start"], undefined);
  assert.equal(captured.style["block-size"], undefined);
  normalizeComponentStyle(legacy);
  assert.equal(legacy.getAttributes().style, undefined);
  assert.equal(legacy.getStyle().left, "448px");
  legacy.addStyle({ left: "48px", "inset-inline-start": "448px" });
  normalizeComponentStyle(legacy);
  assert.equal(legacy.getStyle().left, "48px");
  assert.equal(legacy.getStyle()["inset-inline-start"], undefined);
  const html = exportHtml(editor, meta);
  assert.equal((html.match(/<body\b/g) || []).length, 1);
  assert.equal((html.match(/<\/body>/g) || []).length, 1);
  let moveRoute;
  const moveTarget = {
    get: (key) => ({ draggable: true, selectable: true })[key],
    trigger() {},
    set() {},
  };
  editor.Commands.get("tlb-move").run({
    getModel: () => ({ get: (key) => editor.getModel().get(key), stopDefault() {} }),
    getSelectedAll: () => [moveTarget],
    runCommand: (name, options) => { moveRoute = { name, mode: options.mode }; },
    Commands: { get() { throw Error("Absolute toolbar drag must not enter the DOM sorter"); } },
  }, null, { event: { clientX: 487, clientY: 472 } });
  assert.deepEqual(moveRoute, { name: "core:component-drag", mode: "absolute" });
  for (const zoom of [50, 77, 100, 150]) {
    const scale = zoom / 100;
    const pointer = { clientX: 747 - 260, clientY: 702 - 230, button: 0 };
    normalizeToolbarPointer(pointer, zoom);
    assert.equal(pointer.button, 0);
    let position;
    const dragger = new editor.Utils.Dragger({ setPosition: (next) => { position = next; } });
    dragger.startPointer = dragger.getPointerPos(pointer);
    dragger.startPosition = { x: 400, y: 640 };
    dragger.drag({ clientX: (964 - 260) / scale, clientY: (702 - 230) / scale });
    assert.ok(Math.abs(position.x - (400 + 217 / scale)) < 1e-8);
    assert.ok(Math.abs(position.y - 640) < 1e-8);
  }
  const symbolValues = ["🎁", "❤️", "👩🏽‍💻", "ⓘ", "<img src=x onerror=alert(1)> & \"text\""];
  for (const text of symbolValues) {
    const symbol = editor.getWrapper().append(componentDefinition(makeNode("icon", {
      text, icon: "heart", w: 80, h: 48, fontSize: 32, align: "center",
      color: "#147d67", reviewed: false, origin: "detected", note: "Semantic placeholder",
    })))[0];
    assert.deepEqual(readIcon(symbol), { text, icon: "heart" });
    const unrendered = JSON.stringify(symbol.toJSON());
    const historyLength = editor.UndoManager.getStack().length;
    assert.equal(measureIconSymbol(symbol), null);
    assert.equal(fitIconSymbol(symbol).status, "unavailable");
    assert.equal(JSON.stringify(symbol.toJSON()), unrendered);
    assert.equal(editor.UndoManager.getStack().length, historyLength);
    assert.equal(symbol.getAttributes()["data-kind"], "icon");
    assert.equal(symbol.components().at(0).get("type"), "textnode");
    assert.equal(symbol.components().at(0).get("selectable"), false);
    assert.equal(symbol.components().at(0).get("layerable"), false);
    assert.equal(symbol.getStyle()["font-size"], "32px");
    assert.equal(symbol.getStyle()["text-align"], "center");
    assert.equal(symbol.getStyle()["white-space"], "pre");
    assert.equal(symbol.getStyle()["overflow-wrap"], "normal");
    assert.match(symbol.getStyle()["font-family"], /Segoe UI Emoji/);
    const savedSymbol = JSON.parse(JSON.stringify(captureLibraryComponent(symbol)));
    const reused = editor.getWrapper().append(savedSymbol)[0];
    assert.equal(readIcon(reused).text, text);
    assert.notEqual(reused.getId(), symbol.getId());
    updateIcon(reused, "⚑", "star");
    assert.equal(readIcon(symbol).text, text);
    assert.equal(readIcon(reused).text, "⚑");
    assert.equal(reused.getStyle()["white-space"], "pre");
    reused.addStyle({ "font-size": "40px", width: "96px", height: "56px", color: "#c83756", "text-align": "right" });
    assert.equal(reused.getStyle()["font-size"], "40px");
    assert.equal(symbol.getStyle()["font-size"], "32px");
    const exported = symbol.toHTML();
    assert.ok(!exported.includes("<img"));
    if (text.startsWith("<")) assert.ok(exported.includes("&lt;img") && exported.includes("&amp;"));
    else assert.ok(exported.includes(text));
  }
  for (const icon of ["search", "home", "heart", "close"]) {
    const definition = componentDefinition(makeNode("icon", { text: "", icon }));
    assert.equal(definition.components, iconAssets[icon]);
    assert.equal(definition.style.display, "flex");
    assert.equal(definition.style["white-space"], "pre-wrap");
    assert.equal(definition.style["overflow-wrap"], "anywhere");
  }
  registerLibrary(editor);
  for (const id of ["symbol-gift", "symbol-hint", "symbol-life"]) {
    const block = editor.BlockManager.get(id);
    assert.equal(block.getContent().attributes["data-kind"], "icon");
    assert.equal(block.getContent().attributes["data-spec-id"], undefined);
  }
  const symbolFile = validateStudioFile(JSON.parse(JSON.stringify(studioFile(editor, meta))));
  const iconTexts = editor.getWrapper().components().filter(c => c.getAttributes()["data-kind"] === "icon").map(c => readIcon(c).text);
  editor.loadProjectData(symbolFile.editor);
  assert.deepEqual(editor.getWrapper().components().filter(c => c.getAttributes()["data-kind"] === "icon").map(c => readIcon(c).text), iconTexts);
  const symbolHtml = exportHtml(editor, meta);
  assert.ok(symbolHtml.includes("👩🏽‍💻") && symbolHtml.includes("❤️") && symbolHtml.includes("&lt;img"));
  console.log(
    "PASS: library serialization, nested and class/inline styles, independent instances, input traits, project reload, undo/redo, single HTML body, absolute toolbar drag at 50/77/100/150 percent zoom; editable Unicode/emoji symbols, variants/ZWJ, escaped HTML, library reuse, legacy Lucide definitions.",
  );
} finally {
  editor.destroy();
}

async function browserGeometrySetup(fixed) {
  const { default: grapes } = await import("/node_modules/grapesjs/dist/grapes.mjs");
  const { baseCanvasCss } = await import("/lib/editor-library.ts");
  const { normalizeToolbarPointer } = await import("/lib/editor-geometry.ts");
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet"; sheet.href = "/node_modules/grapesjs/dist/css/grapes.min.css";
  document.head.append(sheet);
  await new Promise(resolve => { sheet.onload = resolve; });
  document.body.style.cssText = "margin:0;background:#eef1f4";
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:80px;top:60px;width:1000px;height:700px";
  document.body.append(host);
  const ed = grapes.init({ container: host, height: "700px", storageManager: false, telemetry: false, cssIcons: "", panels: { defaults: [] }, avoidInlineStyle: true, dragMode: "absolute" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Geometry fixture load exceeded 15 seconds")), 15000);
    ed.on("load", () => { clearTimeout(timer); resolve(); });
  });
  const events = [];
  const pointerTrace = [];
  let tracing = false;
  ed.on("toolbar:run:before", ({ event }) => {
    if (tracing) pointerTrace.push({ type: "toolbar-frame-screen", x: event.clientX, y: event.clientY, zoom: ed.Canvas.getZoom() });
    if (!fixed) normalizeToolbarPointer(event, ed.Canvas.getZoom());
  });
  const tracePointer = event => {
    if (!tracing) return;
    const frame = ed.Canvas.getFrameEl().getBoundingClientRect();
    const sample = { type: event.type, scope: event.currentTarget === document ? "outer" : "frame", target: event.target?.tagName,
      x: event.clientX, y: event.clientY, buttons: event.buttons, trusted: event.isTrusted,
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height } };
    pointerTrace.push(sample);
    queueMicrotask(() => {
      const dragger = ed.Commands.get("core:component-drag").dragger;
      if (dragger) Object.assign(sample, { startPointer: { ...dragger.startPointer }, currentPointer: { ...dragger.currentPointer }, startPosition: { ...dragger.startPosition }, position: { ...dragger.position } });
    });
  };
  for (const doc of [document, ed.Canvas.getDocument()]) for (const type of ["mousedown", "mousemove", "mouseup"])
    doc.addEventListener(type, tracePointer, true);
  const registration = fixed ? (await import("/lib/editor-geometry.ts")).registerEditorGeometry(ed, event => events.push(event)) : null;
  ed.on("toolbar:run:before", ({ event }) => {
    if (tracing) pointerTrace.push({ type: "toolbar-normalized", x: event.clientX, y: event.clientY, zoom: ed.Canvas.getZoom() });
  });
  const records = [];
  const observation = fixed ? (await import("/lib/editor-operation-log.ts")).observeEditorOperations(ed, { record: event => records.push(event) }, () => true) : null;
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  let component;
  const box = () => {
    const el = component.getEl(), css = el.ownerDocument.defaultView.getComputedStyle(el), rect = el.getBoundingClientRect();
    return { x: parseFloat(css.left), y: parseFloat(css.top), w: rect.width, h: rect.height, style: component.getStyle(), parent: component.parent().getId() };
  };
  const configure = async ({ zoom = 77, pan = { x: 24, y: 18 }, parent = { x: 110, y: 84, border: 3 } } = {}) => {
    ed.setStyle(baseCanvasCss);
    ed.getWrapper().addStyle({ width: "640px", height: "620px", position: "relative", overflow: "visible" });
    ed.setComponents([{ attributes: { "data-fixture": "outer" }, style: { position: "absolute", left: `${parent.x}px`, top: `${parent.y}px`, width: "420px", height: "390px", border: `${parent.border}px solid #829399`, "background-color": "#e4eceb" }, components: [
      { attributes: { "data-fixture": "target" }, resizable: true, style: { position: "absolute", left: "42px", top: "58px", width: "146px", height: "123px", border: "2px solid #166a59", "background-color": "#a4d5c6" } },
    ] }]);
    component = ed.getWrapper().find('[data-fixture="target"]')[0];
    ed.Canvas.setZoom(zoom); ed.Canvas.setCoords(pan.x, pan.y);
    ed.Canvas.getFrameEl().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    ed.runCommand("core:component-select");
    ed.select(component);
    ed.Commands.get("core:component-select").initResize(component);
    await new Promise(resolve => setTimeout(resolve, 400));
    ed.UndoManager.clear();
    const resizer = ed.Commands.get("resize").canvasResizer;
    const handles = Object.fromEntries(Object.entries(resizer.handlers).map(([key, el]) => { const r = el.getBoundingClientRect(); return [key, { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }]; }));
    const move = ed.Canvas.getToolbarEl().querySelector('[draggable="true"]')?.getBoundingClientRect();
    return { before: box(), handles, move: move ? { x: Math.round(move.x + move.width / 2), y: Math.round(move.y + move.height / 2) } : null };
  };
  window.__geometryTest = { ed, events, records, box, configure, settle,
    beginPointerTrace() { tracing = true; pointerTrace.length = 0; },
    finishPointerTrace() { tracing = false; return [...pointerTrace]; },
    async undo() { ed.UndoManager.undo(); await settle(); return box(); },
    async redo() { ed.UndoManager.redo(); await settle(); return box(); },
    async reload() { const data = JSON.parse(JSON.stringify(ed.getProjectData())); ed.getModel().setHovered(); ed.selectRemove(component); ed.stopCommand("resize"); await ed.loadProjectData(data); component = ed.getWrapper().find('[data-fixture="target"]')[0]; await new Promise(resolve => setTimeout(resolve, 400)); return box(); },
    detachCheck() { observation?.dispose(); registration?.destroy(); const count = records.length;
      ed.trigger("component:resize", { type: "start", component, el: component.getEl(), rect: { t: 0, l: 0, w: 100, h: 100 } });
      ed.trigger("component:resize", { type: "end", component, el: component.getEl() });
      ed.trigger("component:drag:start", { target: component }); ed.trigger("component:drag:end");
      return { before: count, after: records.length };
    },
    async destroy() { for (const doc of [document, ed.Canvas.getDocument()]) for (const type of ["mousedown", "mousemove", "mouseup"]) doc?.removeEventListener(type, tracePointer, true);
      observation?.dispose(); registration?.destroy(); ed.destroy(); host.remove(); sheet.remove(); delete window.__geometryTest; },
  };
  return configure();
}

async function browserSymbolChecks() {
  const { default: grapes } = await import("/node_modules/grapesjs/dist/grapes.mjs");
  const { componentDefinition, readIcon, updateIcon, measureIconSymbol, fitIconSymbol, baseCanvasCss } = await import("/lib/editor-library.ts");
  const { makeNode } = await import("/lib/wireframe.ts");
  const { captureLibraryComponent } = await import("/lib/component-snapshot.ts");
  const { exportHtml, exportReact, buildExport, studioFile, validateStudioFile } = await import("/lib/grapes-export.ts");
  console.info("Symbol browser check: modules loaded");
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ed = grapes.init({ container: host, height: "360px", storageManager: false, telemetry: false, cssIcons: "", panels: { defaults: [] }, avoidInlineStyle: true });
  const meta = { name: "Symbols & <safe>", notes: "Isolated export check", width: 640, height: 320, engineRevision: 2 };
  const symbols = ["🎁", "❤️", "👩🏽‍💻", "ⓘ", "<img src=x onerror=alert(1)> & \"text\""];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Test canvas load exceeded 15 seconds")), 15000);
      ed.on("load", () => { clearTimeout(timer); resolve(); });
    });
    console.info("Symbol browser check: canvas loaded");
    ed.setStyle(baseCanvasCss);
    ed.getWrapper().addStyle({ width: "640px", height: "320px", position: "relative", overflow: "hidden" });
    ed.setComponents(symbols.map((text, index) => componentDefinition(makeNode("icon", {
      text, icon: "heart", x: 32 + (index % 4) * 132, y: index < 4 ? 32 : 136,
      w: index < 4 ? 96 : 550, h: index < 4 ? 72 : 70, fontSize: index < 4 ? 42 : 20,
      align: "center", lineHeight: 1.2, color: "#147d67", origin: "detected", reviewed: false,
    }))));
    const old = ed.getWrapper().append(componentDefinition(makeNode("icon", { text: "", icon: "heart", x: 48, y: 240 })))[0];
    old.removeAttributes("data-icon");
    check(readIcon(old).icon === "heart", "Legacy Lucide choice must be readable without migration");
    check(old.getEl().querySelector("svg.lucide-heart"), "Legacy Lucide SVG must render");
    const reused = ed.getWrapper().append(captureLibraryComponent(ed.getWrapper().components().at(2)))[0];
    updateIcon(reused, "⚑", "star");
    reused.addStyle({ left: "172px", top: "230px", width: "96px", height: "56px", "font-size": "36px", color: "#c83756", "text-align": "right" });
    check(readIcon(ed.getWrapper().components().at(2)).text === symbols[2], "Library instances must remain independent");
    for (const [id, x] of [["hearts-before", 332], ["hearts-current", 490]]) {
      const hearts = ed.getWrapper().append(componentDefinition(makeNode("icon", {
        id, text: "❤️❤️❤️", icon: "heart", x, y: 240, w: 104, h: 31,
        fontSize: 28, fontWeight: "400", lineHeight: 1, align: "center", stroke: "none",
      })))[0];
      if (id === "hearts-before") hearts.addStyle({ "white-space": "pre-wrap", "overflow-wrap": "anywhere" });
    }
    const saved = validateStudioFile(JSON.parse(JSON.stringify(studioFile(ed, meta))));
    await ed.loadProjectData(saved.editor);
    const components = ed.getWrapper().components();
    const measureHearts = (id) => {
      const element = ed.getWrapper().find(`[data-spec-id="${id}"]`)[0].getEl();
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(element.textContent);
      const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(element.textContent)].map(({ segment, index }) => {
        const range = element.ownerDocument.createRange();
        range.setStart(element.firstChild, index); range.setEnd(element.firstChild, index + segment.length);
        const rect = range.getBoundingClientRect();
        return { text: segment, x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height };
      });
      return { text: element.textContent, width: box.width, height: box.height,
        fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight,
        textAlign: style.textAlign,
        whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, letterSpacing: style.letterSpacing,
        advance: metrics.width, ink: { left: -metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight, width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight, ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent },
        lineCount: new Set(glyphs.map(glyph => glyph.y.toFixed(2))).size, glyphs };
    };
    const hearts = [];
    for (const zoom of [55, 100]) {
      ed.Canvas.setZoom(zoom);
      await new Promise(requestAnimationFrame);
      hearts.push({ zoom, before: measureHearts("hearts-before"), current: measureHearts("hearts-current") });
    }
    for (const { before, current } of hearts) {
      check(current.text === "❤️❤️❤️" && current.glyphs.length === 3, "All three hearts must remain intact");
      check(current.lineCount === 1, "Symbol icons must not automatically wrap onto a second line");
      check(current.whiteSpace === "pre" && current.overflowWrap === "normal", "Symbol layout must preserve content without automatic wrapping");
      check(current.width === 104 && current.height === 31 && current.fontSize === "28px" && current.fontWeight === "400" && current.lineHeight === "28px", "The user's geometry and typography must not be changed to fit icons");
      check(current.textAlign === "center", "The user's text alignment must remain unchanged");
      check(current.advance === before.advance && current.ink.width === before.ink.width && current.letterSpacing === before.letterSpacing, "Glyph size, advance and letter spacing must not be compressed");
      if (before.advance > before.width) check(before.lineCount > 1, "The old wrapping rule must reproduce overflow at this font width");
    }
    console.info("Symbol browser check: three-heart layout " + JSON.stringify(hearts));
    const fitChecks = [];
    const target = ed.getWrapper().find('[data-spec-id="hearts-current"]')[0];
    for (const zoom of [55, 100]) {
      ed.Canvas.setZoom(zoom);
      await new Promise(requestAnimationFrame);
      ed.UndoManager.clear();
      const modelBefore = JSON.stringify(target.toJSON());
      const styleBefore = { ...target.getStyle() };
      const attributesBefore = JSON.stringify(target.getAttributes());
      check(measureIconSymbol(target).overflow, "The actual three-heart case must report overflow before fitting");
      check(!ed.UndoManager.hasUndo() && JSON.stringify(target.toJSON()) === modelBefore, "Measuring must not change the model or history");
      const fitted = fitIconSymbol(target);
      const measurement = measureIconSymbol(target);
      check(fitted.status === "fitted" && fitted.fontSize >= 8 && fitted.fontSize < 28, "Explicit fit must shrink within the supported font range");
      check(!measurement.overflow, "Fitted DOM Range must lie entirely within the content box");
      const { "font-size": fittedSize, ...unchangedStyle } = target.getStyle();
      const { "font-size": originalSize, ...originalStyle } = styleBefore;
      check(JSON.stringify(unchangedStyle) === JSON.stringify(originalStyle), "Fit must change only font-size, never geometry, alignment, line height or color");
      check(JSON.stringify(target.getAttributes()) === attributesBefore && readIcon(target).text === "❤️❤️❤️", "Fit must preserve the text and attributes");
      check(!target.getEl().style.getPropertyValue("font-size") && !target.getEl().style.getPropertyPriority("font-size"), "Successful DOM probes must restore the original inline declaration");
      const fittedModel = JSON.stringify(target.toJSON()), historyLength = ed.UndoManager.getStack().length;
      check(fitIconSymbol(target).status === "unchanged", "An already fitting symbol needs no second edit");
      check(JSON.stringify(target.toJSON()) === fittedModel && ed.UndoManager.getStack().length === historyLength, "A no-op fit must not change the model or history");
      ed.UndoManager.undo();
      check(JSON.stringify(target.toJSON()) === modelBefore && target.getStyle()["font-size"] === originalSize, "One undo must restore the original model and font size");
      check(!ed.UndoManager.hasUndo(), "A fit action must not leave extra undo steps");
      ed.UndoManager.redo();
      check(target.getStyle()["font-size"] === fittedSize && !measureIconSymbol(target).overflow, "One redo must restore the fitted font size");
      ed.UndoManager.undo();
      fitChecks.push({ zoom, fontSize: fitted.fontSize, measurement, undoRestoredOriginal: true, redoRestoredFit: true });
    }
    const tooSmall = ed.getWrapper().append(componentDefinition(makeNode("icon", {
      text: "❤️❤️❤️", x: 620, y: 300, w: 4, h: 2, fontSize: 28, lineHeight: 1,
    })))[0];
    tooSmall.getEl().style.setProperty("font-size", "28px", "important");
    ed.UndoManager.clear();
    const smallBefore = JSON.stringify(tooSmall.toJSON());
    check(fitIconSymbol(tooSmall).status === "too-small", "An icon that cannot fit at 8px must fail explicitly");
    check(JSON.stringify(tooSmall.toJSON()) === smallBefore && !ed.UndoManager.hasUndo(), "A failed fit must not change the model or history");
    check(tooSmall.getEl().style.getPropertyValue("font-size") === "28px" && tooSmall.getEl().style.getPropertyPriority("font-size") === "important", "A failed probe must restore both inline value and priority");
    tooSmall.remove();
    ed.UndoManager.clear();
    console.info("Symbol browser check: explicit font fit " + JSON.stringify({ fitChecks, minimumFailurePreservedModelAndHistory: true }));
    symbols.forEach((text, index) => {
      const component = components.at(index);
      check(readIcon(component).text === text, `Project round-trip lost symbol ${index}`);
      check(component.getEl().textContent === text, `Rendered symbol differs ${index}`);
      check(!component.getEl().querySelector("img"), "Symbols must not become image markup");
    });
    const html = exportHtml(ed, meta), react = exportReact(ed);
    const exportedDocument = new DOMParser().parseFromString(html, "text/html");
    check(exportedDocument.querySelector('[data-spec-id="hearts-current"]').textContent === "❤️❤️❤️", "HTML must preserve the three-heart sequence");
    symbols.forEach((text, index) => {
      check(exportedDocument.querySelectorAll('[data-kind="icon"]')[index].textContent === text, `HTML lost symbol ${index}`);
      check(react.includes(JSON.stringify(text).replace(/</g, "\\u003c")), `React lost escaped symbol ${index}`);
    });
    check(!exportedDocument.querySelector("img"), "HTML injection must remain text");
    check(!react.includes("<img"), "React injection must remain a string expression");
    check(react.includes(JSON.stringify("❤️❤️❤️")), "React must preserve the three-heart sequence");
    console.info("Symbol browser check: project, HTML and React passed");
    const svg = await (await buildExport(ed, meta, "svg")).blob.text();
    const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
    check(!svgDocument.querySelector("parsererror"), "SVG must be well-formed XML");
    symbols.forEach((text, index) => check(svgDocument.querySelectorAll('[data-kind="icon"]')[index].textContent === text, `SVG lost symbol ${index}`));
    check(!svgDocument.querySelector("img"), "SVG injection must remain text");
    const svgHearts = svgDocument.querySelector('[data-spec-id="hearts-current"]');
    check(svgHearts.textContent === "❤️❤️❤️" && svgHearts.style.whiteSpace === "pre", "SVG must preserve unwrapped hearts");
    const png = (await buildExport(ed, meta, "png")).blob;
    const bitmap = await createImageBitmap(png);
    check(bitmap.width === 1280 && bitmap.height === 640, "PNG dimensions must match the export canvas");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
    const paintedPixels = symbols.slice(0, 4).map((_, index) => {
      const data = ctx.getImageData((32 + index * 132) * 2, 32 * 2, 96 * 2, 72 * 2).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) count++;
      check(count > 100, `PNG symbol ${index} is blank`);
      return count;
    });
    const heartInk = (x) => {
      const left = x - 24, top = 220, width = 152, height = 88;
      const data = ctx.getImageData(left * 2, top * 2, width * 2, height * 2).data;
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      const columns = new Set();
      for (let py = 0; py < height * 2; py++) for (let px = 0; px < width * 2; px++) {
        const offset = (py * width * 2 + px) * 4;
        if (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235) {
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minY = Math.min(minY, py); maxY = Math.max(maxY, py);
          columns.add(px);
        }
      }
      let groups = 0, previous = -2;
      for (const column of [...columns].sort((a, b) => a - b)) { if (column > previous + 1) groups++; previous = column; }
      return { left: left + minX / 2 - x, right: left + (maxX + 1) / 2 - x, top: top + minY / 2 - 240, bottom: top + (maxY + 1) / 2 - 240, horizontalGlyphGroups: groups };
    };
    const heartPixels = { before: heartInk(332), current: heartInk(490) };
    check(heartPixels.current.horizontalGlyphGroups === 3, "PNG must show three uncut hearts on one row");
    console.info("Symbol browser check: three-heart PNG ink " + JSON.stringify(heartPixels));
    const pngBase64 = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(png); });
    return { pngBase64, svg, html, react, paintedPixels, hearts, heartPixels, fitChecks, symbols: symbols.slice(0, 4), width: bitmap.width, height: bitmap.height };
  } finally { ed.destroy(); host.remove(); }
}

async function browserColorPickerSetup(withPositioning = false) {
  console.info(`Color picker check: setup ${withPositioning ? "fixed" : "baseline"}`);
  await import("/app/globals.css");
  const { default: grapes } = await import("/node_modules/grapesjs/dist/grapes.mjs");
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const settle = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Color picker animation frames stalled")), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  const root = document.createElement("div");
  root.className = "studio grapes-studio";
  root.innerHTML = '<header class="app-header">Isolated color picker check</header><div class="editor-layout"><aside class="left-panel"></aside><section class="canvas-section"><div class="grapes-canvas-host"><div class="grapes-mount"></div></div></section><aside class="right-panel mobile-open"><div class="panel-tabs">Styles</div><div class="native-styles"></div></aside></div>';
  document.body.appendChild(root);
  const panel = root.querySelector(".right-panel"), styleHost = root.querySelector(".native-styles");
  const positioning = withPositioning
    ? (await import("/lib/color-picker-positioning.ts")).createColorPickerPositioning(styleHost, grapes.$)
    : null;
  const editor = grapes.init({
    container: root.querySelector(".grapes-mount"), height: "100%", width: "auto", storageManager: false,
    telemetry: false, cssIcons: "", panels: { defaults: [] }, avoidInlineStyle: true,
    colorPicker: positioning?.options,
    styleManager: { appendTo: styleHost, sectors: [
      { id: "geometry", name: "位置与尺寸", open: true, properties: ["position", "left", "top", "width", "height", "z-index"] },
      { id: "type", name: "文字", open: true, properties: ["font-size", "font-weight", "line-height", "text-align", { property: "color", type: "color", name: "文字颜色" }, { property: "-webkit-text-stroke-color", type: "color", name: "文字描边颜色" }] },
      { id: "appearance", name: "外观", open: true, properties: [{ property: "background-color", type: "color", name: "填充" }, "border-radius", "border-width", { property: "border-color", type: "color", name: "描边颜色" }, "border-style", "opacity"] },
      { id: "layout", name: "容器布局", open: true, properties: ["display", "flex-direction", "gap", "padding", "justify-content", "align-items"] },
    ] },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Color picker fixture load exceeded 15 seconds")), 15000);
    editor.on("load", () => { clearTimeout(timer); resolve(); });
  });
  console.info("Color picker check: editor loaded");
  const component = editor.getWrapper().append({ type: "text", components: [{ type: "textnode", content: "Color fixture" }], style: { width: "320px", height: "160px", color: "#147d67", "background-color": "#f2f4f6", "border-color": "#39424c", "-webkit-text-stroke-color": "#253546", "border-width": "2px", "border-style": "solid" } })[0];
  editor.select(component);
  await settle();
  const anchorFor = (property) => {
    const anchor = styleHost.querySelector(`.gjs-sm-property__${property} .gjs-field-color-picker`);
    check(anchor, `Missing ${property} color control`);
    return anchor;
  };
  const popupFor = (anchor) => grapes.$(anchor).spectrum("container")[0];
  const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  let activeProperty = "background-color";
  const snapshot = () => {
    const anchor = anchorFor(activeProperty), popup = popupFor(anchor), a = rect(anchor), p = rect(popup);
    const placement = popup.getAttribute("data-placement");
    const side = placement?.split("-")[0];
    return { property: activeProperty, viewport: [innerWidth, innerHeight], scrollTop: panel.scrollTop,
      anchor: a, popup: p, popupPosition: getComputedStyle(popup).position,
      placement,
      visible: !popup.classList.contains("sp-hidden") && getComputedStyle(popup).visibility !== "hidden",
      outsideViewport: p.left < 0 || p.top < 0 || p.right > innerWidth || p.bottom > innerHeight,
      edgeGap: side === "left" ? Math.abs(p.right - a.left) : side === "right" ? Math.abs(p.left - a.right)
        : Math.min(Math.abs(p.top - a.bottom), Math.abs(p.bottom - a.top)) };
  };
  const open = async (property = "background-color", fraction = 0.5) => {
    activeProperty = property;
    const anchor = anchorFor(property), a = rect(anchor), p = rect(panel);
    const visibleTop = Math.max(0, p.top), visibleBottom = Math.min(innerHeight, p.bottom);
    panel.scrollTop += a.top - (visibleTop + (visibleBottom - visibleTop) * fraction);
    await settle();
    grapes.$(anchor).spectrum("show");
    await settle();
    return snapshot();
  };
  const assertPosition = async () => {
    await settle();
    const position = snapshot();
    check(position.visible, `${activeProperty} popup must be visible`);
    check(!position.outsideViewport, `${activeProperty} popup must stay in the viewport: ${JSON.stringify(position)}`);
    check(position.popupPosition === "fixed", "The body portal must use viewport coordinates");
    check(position.edgeGap <= 4.1, `${activeProperty} popup must remain attached to its trigger`);
    return position;
  };
  const drag = async (fraction) => {
    const field = popupFor(anchorFor(activeProperty)).querySelector(".sp-color");
    const r = rect(field), x = r.left + r.width * fraction, y = r.top + r.height * 0.35;
    field.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button: 0, bubbles: true }));
    await settle();
    return component.getStyle()[activeProperty];
  };
  const interactions = async () => {
    const results = [];
    for (const property of ["color", "background-color", "border-color", "-webkit-text-stroke-color"]) {
      const initial = component.getStyle()[property];
      await open(property);
      const position = await assertPosition();
      const preview = await drag(0.22);
      check(preview !== initial, `${property} drag must preview a changed color`);
      popupFor(anchorFor(property)).querySelector(".sp-cancel").click();
      await settle();
      check(component.getStyle()[property] === initial && !snapshot().visible, `${property} cancel must restore the original color`);
      await open(property);
      const committed = await drag(0.67);
      popupFor(anchorFor(property)).querySelector(".sp-choose").click();
      await settle();
      check(component.getStyle()[property] === committed && !snapshot().visible, `${property} OK must commit the previewed color`);
      await open(property);
      await drag(0.12);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      await settle();
      check(component.getStyle()[property] === committed && !snapshot().visible, `${property} Escape must cancel the preview`);
      await open(property);
      const clickoutCommitted = await drag(0.82);
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      check(component.getStyle()[property] === clickoutCommitted && !snapshot().visible, `${property} outside click must retain Spectrum's commit behavior`);
      results.push({ property, position, initial, preview, committed, clickoutCommitted, cancelRestored: true, escapeRestored: true });
      console.info(`Color picker check: ${property} commit/cancel passed`);
    }
    await open("background-color", 0.4);
    const beforeScroll = await assertPosition();
    panel.scrollTop += 48;
    const afterScroll = await assertPosition();
    check(Math.abs(afterScroll.popup.top - beforeScroll.popup.top + afterScroll.scrollTop - beforeScroll.scrollTop) < 0.1, "A scrolling right panel must move the open popup with its trigger");
    const saved = component.getStyle()["background-color"];
    await drag(0.1);
    panel.scrollTop = 0;
    await settle();
    check(!snapshot().visible && component.getStyle()["background-color"] === saved, "Scrolling the trigger out of view must dismiss and cancel its preview");
    await open("background-color", 0.5);
    return { colors: results, beforeScroll, afterScroll, hiddenTriggerCancelled: true };
  };
  const edges = async () => {
    const results = [];
    for (const fraction of [0.02, 0.5, 0.94]) {
      await open("background-color", fraction);
      results.push(await assertPosition());
    }
    return results;
  };
  const shorthandProbe = async () => {
    grapes.$(anchorFor(activeProperty)).spectrum("hide");
    const prototype = editor.getWrapper().append({ style: { width: "120px", height: "60px", background: "#0645B9", border: "3px solid #FFFFFF" } })[0];
    editor.select(prototype);
    await settle();
    const computed = prototype.getEl().ownerDocument.defaultView.getComputedStyle(prototype.getEl());
    const result = {
      style: prototype.getStyle(),
      computed: { backgroundColor: computed.backgroundColor, borderTopColor: computed.borderTopColor, borderTopWidth: computed.borderTopWidth },
      fields: Object.fromEntries(["background-color", "border-color"].map(property => [property, {
        modelValue: editor.StyleManager.getProperty("appearance", property).getValue({ noDefault: true }),
        inputValue: styleHost.querySelector(`.gjs-sm-property__${property} input`).value,
      }])),
    };
    check(result.computed.backgroundColor === "rgb(6, 69, 185)" && result.computed.borderTopColor === "rgb(255, 255, 255)", "Shorthand prototype must render its actual source colors");
    prototype.remove();
    const { componentDefinition } = await import("/lib/editor-library.ts");
    const { makeNode } = await import("/lib/wireframe.ts");
    const recognized = editor.getWrapper().append(componentDefinition(makeNode("frame", {
      fill: "#0645B9", stroke: "#FFFFFF", strokeWidth: 3, origin: "detected", reviewed: false,
    })))[0];
    editor.select(recognized);
    await settle();
    result.recognizedFields = Object.fromEntries(["background-color", "border-color"].map(property => [property, {
      modelValue: editor.StyleManager.getProperty("appearance", property).getValue({ noDefault: true }),
      inputValue: styleHost.querySelector(`.gjs-sm-property__${property} input`).value,
    }]));
    for (const [property, expected] of [["background-color", "#0645B9"], ["border-color", "#FFFFFF"]]) {
      check(result.recognizedFields[property].modelValue.toUpperCase() === expected, `${property} must expose recognized colors in the style model`);
      check(result.recognizedFields[property].inputValue.toUpperCase() === expected, `${property} must display recognized colors in the input`);
    }
    editor.select(component); recognized.remove();
    await settle();
    console.info("Color picker check: shorthand fields " + JSON.stringify(result));
    return result;
  };
  window.__colorPickerTest = {
    open, snapshot, settle, panel, component, editor, anchorFor, popupFor, assertPosition, interactions, edges, shorthandProbe, drag,
    async destroy() {
      for (const anchor of styleHost.querySelectorAll(".gjs-field-color-picker")) grapes.$(anchor).spectrum("hide");
      positioning?.destroy(); editor.destroy(); root.remove(); delete window.__colorPickerTest;
    },
  };
  return open();
}

if (process.versions.electron && process.env.WIREFRAME_SYMBOL_TEST_URL) {
  const { app, BrowserWindow } = await import("electron");
  // Electron emits ready after its entry module finishes evaluating.
  void (async () => {
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const colors = process.env.WIREFRAME_EDITOR_CHECK === "colors";
  const geometry = process.env.WIREFRAME_EDITOR_CHECK === "geometry";
  app.setName(colors ? "Wireframe Isolated Color Picker Check" : "Wireframe Isolated Symbol Check");
  app.setPath("userData", process.env.WIREFRAME_SYMBOL_TEST_DATA);
  try {
    await app.whenReady();
    console.log("Symbol browser check: Electron ready");
    const window = new BrowserWindow({ show: false, width: colors || geometry ? 1360 : 900, height: geometry ? 900 : colors ? 740 : 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: colors || geometry } });
    if (colors || geometry) window.webContents.setFrameRate(60);
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.message.startsWith("Symbol browser check:") || details.message.startsWith("Color picker check:")) console.log(details.message);
    });
    await window.loadURL(process.env.WIREFRAME_SYMBOL_TEST_URL);
    console.log("Symbol browser check: fixture page loaded");
    const dir = process.env.WIREFRAME_SYMBOL_TEST_ARTIFACTS;
    if (geometry) {
      const gesture = async (handle, dx, dy, cancel = false) => {
        window.webContents.sendInputEvent({ type: "mouseMove", ...handle });
        window.webContents.sendInputEvent({ type: "mouseDown", ...handle, button: "left", clickCount: 1 });
        await window.webContents.executeJavaScript("window.__geometryTest.settle()");
        if (dx || dy) {
          for (let i = 1; i <= 3; i++) {
            window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(handle.x + dx * i / 3), y: Math.round(handle.y + dy * i / 3), button: "left", modifiers: ["leftbuttondown"] });
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          await window.webContents.executeJavaScript("window.__geometryTest.settle()");
        }
        if (cancel) window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
        window.webContents.sendInputEvent({ type: "mouseUp", x: handle.x + dx, y: handle.y + dy, button: "left", clickCount: 1 });
        await window.webContents.executeJavaScript("window.__geometryTest.settle()");
        return window.webContents.executeJavaScript("window.__geometryTest.box()");
      };
      const setup = await window.webContents.executeJavaScript(`(${browserGeometrySetup.toString()})(false)`);
      const baseline = { ...setup, after: await gesture(setup.handles.br, 31, 23) };
      await writeFile(path.join(dir, "geometry-baseline.json"), JSON.stringify(baseline, null, 2));
      console.log(JSON.stringify({ status: "BASELINE", artifacts: dir, baseline }));
      assert.ok(Math.abs(baseline.after.x - baseline.before.x) > 2 || Math.abs(baseline.after.y - baseline.before.y) > 2, "Uncorrected nested resize must reproduce coordinate displacement");
      await window.webContents.executeJavaScript("window.__geometryTest.destroy()");
      await window.webContents.executeJavaScript(`(${browserGeometrySetup.toString()})(true)`);
      const same = (actual, expected, label) => {
        for (const key of ["x", "y", "w", "h"]) assert.ok(Math.abs(actual[key] - expected[key]) < 0.05, `${label}: ${key} ${actual[key]} != ${expected[key]}`);
      };
      const fixed = [];
      const smoke = process.env.WIREFRAME_GEOMETRY_SMOKE === "1";
      for (const zoom of smoke ? [77] : [50, 77, 100, 150]) {
        for (const parent of smoke ? [{ x: 110, y: 84, border: 7 }] : [{ x: 22, y: 30, border: 0 }, { x: 110, y: 84, border: 7 }]) {
          for (const handle of smoke ? ["tl", "br"] : ["tl", "tc", "tr", "cl", "cr", "bl", "bc", "br"]) {
            const configuration = { zoom, parent, pan: zoom === 150 ? { x: 260, y: 160 } : { x: -32, y: 44 } };
            const setup = await window.webContents.executeJavaScript(`window.__geometryTest.configure(${JSON.stringify(configuration)})`);
            const after = await gesture(setup.handles[handle], 30, 24);
            const b = setup.before;
            if (handle.includes("l")) assert.ok(Math.abs(after.x + after.w - b.x - b.w) < 0.05, `Right edge drift: ${zoom}/${handle}`);
            else assert.equal(after.x, b.x, `Left edge drift: ${zoom}/${handle}`);
            if (handle.includes("t")) assert.ok(Math.abs(after.y + after.h - b.y - b.h) < 0.05, `Bottom edge drift: ${zoom}/${handle}`);
            else assert.equal(after.y, b.y, `Top edge drift: ${zoom}/${handle}`);
            assert.equal(after.parent, b.parent);
            assert.ok(after.w !== b.w || after.h !== b.h, `The pointer gesture must resize: ${zoom}/${handle}`);
            const expectedWidth = b.w + (handle.includes("r") ? 30 : handle.includes("l") ? -30 : 0) / (zoom / 100);
            const expectedHeight = b.h + (handle.includes("b") ? 24 : handle.includes("t") ? -24 : 0) / (zoom / 100);
            assert.ok(Math.abs(after.w - expectedWidth) <= 1.1, `Resize width must match pointer travel at ${zoom}/${handle}`);
            assert.ok(Math.abs(after.h - expectedHeight) <= 1.1, `Resize height must match pointer travel at ${zoom}/${handle}`);
            if (["tc", "bc"].includes(handle)) assert.equal(after.w, b.w);
            if (["cl", "cr"].includes(handle)) assert.equal(after.h, b.h);
            same(await window.webContents.executeJavaScript("window.__geometryTest.undo()"), b, `One undo ${zoom}/${handle}`);
            assert.equal(await window.webContents.executeJavaScript("window.__geometryTest.ed.UndoManager.hasUndo()"), false, "A resize must be one undo group");
            same(await window.webContents.executeJavaScript("window.__geometryTest.redo()"), after, `One redo ${zoom}/${handle}`);
            fixed.push({ ...configuration, handle, before: b, after });
          }
        }
      }
      const noMoveSetup = await window.webContents.executeJavaScript("window.__geometryTest.configure()");
      same(await gesture(noMoveSetup.handles.br, 0, 0), noMoveSetup.before, "No pointer movement");
      assert.equal(await window.webContents.executeJavaScript("window.__geometryTest.ed.UndoManager.hasUndo()"), false);
      const cancelled = await gesture(noMoveSetup.handles.tl, 30, 24, true);
      same(cancelled, noMoveSetup.before, "Escape restores resize geometry");
      same(await window.webContents.executeJavaScript("window.__geometryTest.undo()"), noMoveSetup.before, "Undo after Escape must not restore an intermediate resize");
      same(await window.webContents.executeJavaScript("window.__geometryTest.redo()"), noMoveSetup.before, "Redo after Escape must not restore an intermediate resize");
      const drags = [];
      for (const zoom of [50, 77, 100, 150]) {
        const setup = await window.webContents.executeJavaScript(`window.__geometryTest.configure({zoom:${zoom},pan:{x:260,y:160}})`);
        assert.ok(setup.move, "The native move toolbar must render");
        await window.webContents.executeJavaScript("window.__geometryTest.beginPointerTrace()");
        const after = await gesture(setup.move, 45, 30);
        const pointerTrace = await window.webContents.executeJavaScript("window.__geometryTest.finishPointerTrace()");
        await writeFile(path.join(dir, `drag-${zoom}-pointer-trace.json`), JSON.stringify({ zoom, setup, after, pointerTrace }, null, 2));
        assert.equal(after.w, setup.before.w); assert.equal(after.h, setup.before.h);
        assert.ok(Math.abs(after.x - setup.before.x - 45 / (zoom / 100)) <= 1.1, `Drag X must remain local at ${zoom}%: ${JSON.stringify(after)}`);
        assert.ok(Math.abs(after.y - setup.before.y - 30 / (zoom / 100)) <= 1.1, `Drag Y must remain local at ${zoom}%`);
        assert.equal(after.parent, setup.before.parent);
        same(await window.webContents.executeJavaScript("window.__geometryTest.undo()"), setup.before, `Drag undo ${zoom}`);
        same(await window.webContents.executeJavaScript("window.__geometryTest.redo()"), after, `Drag redo ${zoom}`);
        drags.push({ zoom, before: setup.before, after });
      }
      const bodySetup = await window.webContents.executeJavaScript("window.__geometryTest.configure({zoom:77,pan:{x:24,y:18}})");
      const bodyPointer = { x: Math.round((bodySetup.handles.tl.x + bodySetup.handles.br.x) / 2), y: Math.round((bodySetup.handles.tl.y + bodySetup.handles.br.y) / 2) };
      await window.webContents.executeJavaScript("window.__geometryTest.beginPointerTrace()");
      const bodyAfter = await gesture(bodyPointer, 46, 31);
      const bodyTrace = await window.webContents.executeJavaScript("window.__geometryTest.finishPointerTrace()");
      await writeFile(path.join(dir, "body-drag-pointer-trace.json"), JSON.stringify({ setup: bodySetup, after: bodyAfter, pointerTrace: bodyTrace }, null, 2));
      assert.ok(bodyTrace.some(event => event.type === "mousedown" && event.scope === "frame" && event.buttons === 1), "The direct drag must start with a held-button event inside the iframe");
      assert.ok(!bodyTrace.some(event => event.type.startsWith("toolbar-")), "The direct drag must not use toolbar normalization");
      assert.equal(bodyAfter.w, bodySetup.before.w); assert.equal(bodyAfter.h, bodySetup.before.h);
      assert.ok(Math.abs(bodyAfter.x - bodySetup.before.x - 46 / 0.77) <= 1.1, "Direct component drag X must remain local");
      assert.ok(Math.abs(bodyAfter.y - bodySetup.before.y - 31 / 0.77) <= 1.1, "Direct component drag Y must remain local");
      same(await window.webContents.executeJavaScript("window.__geometryTest.undo()"), bodySetup.before, "Direct component drag undo");
      same(await window.webContents.executeJavaScript("window.__geometryTest.redo()"), bodyAfter, "Direct component drag redo");
      const savedSetup = await window.webContents.executeJavaScript("window.__geometryTest.configure({zoom:77})");
      const saved = await gesture(savedSetup.handles.tl, -30, -24);
      window.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: 4 });
      await window.webContents.executeJavaScript("window.__geometryTest.settle()");
      same(await window.webContents.executeJavaScript("window.__geometryTest.reload()"), saved, "Save and reopen retains corrected geometry");
      const operations = await window.webContents.executeJavaScript("window.__geometryTest.events");
      assert.equal(operations.filter(op => op.phase === "start").length, fixed.length + 3);
      assert.equal(operations.filter(op => op.phase === "end").length, fixed.length + 3);
      assert.equal(operations.filter(op => op.cancelled).length, 1);
      const records = await window.webContents.executeJavaScript("window.__geometryTest.records");
      const resizeStarts = records.filter(record => record.event === "component.resize.start");
      const resizeEnds = records.filter(record => ["component.resize.end", "component.resize.cancel"].includes(record.event));
      assert.equal(resizeStarts.length, fixed.length + 3); assert.equal(resizeEnds.length, fixed.length + 3);
      assert.equal(resizeEnds.filter(record => record.event === "component.resize.cancel").length, 1);
      const dpr = await window.webContents.executeJavaScript("window.devicePixelRatio");
      const operationEnds = operations.filter(op => op.phase === "end");
      for (const [index, start] of resizeStarts.entries()) {
        const end = resizeEnds.find(record => record.operationId === start.operationId);
        assert.ok(end, "Each resize start must have one correlated terminal record");
        assert.deepEqual(start.before, operationEnds[index].before);
        assert.deepEqual(end.after, operationEnds[index].after);
        assert.equal(start.viewport.zoom, operationEnds[index].zoom);
        assert.equal(start.viewport.devicePixelRatio, dpr);
        assert.equal(start.handle, operationEnds[index].handle);
      }
      const detached = await window.webContents.executeJavaScript("window.__geometryTest.detachCheck()");
      assert.equal(detached.after, detached.before, "Disposed observers must no longer record gestures");
      await writeFile(path.join(dir, "geometry-fixed.json"), JSON.stringify({ fixed, drags, bodyDrag: { before: bodySetup.before, after: bodyAfter }, noMove: noMoveSetup.before, cancelled, saved, operations, records, detached }, null, 2));
      await writeFile(path.join(dir, "geometry-fixed.png"), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("window.__geometryTest.destroy()");
      console.log(JSON.stringify({ status: "PASS", cases: fixed.length, zoom: [...new Set(fixed.map(item => item.zoom))], eightHandles: !smoke, nestedBordersAndPan: true, oneUndoRedo: true, noMovement: true, escape: true, saveReopen: true, realToolbarDrags: drags.map(item => item.zoom), directComponentDrag: true, framePacedHeldPointer: true, sizeMatchesPointer: true, logGeometryAndCancellation: true, disposedObserver: true, artifacts: dir, isolatedUserData: true, visibleWindows: 0 }));
      window.destroy(); app.exit(0); return;
    }
    if (colors) {
      const baseline = await window.webContents.executeJavaScript(`(${browserColorPickerSetup.toString()})(false)`);
      await writeFile(path.join(dir, "color-picker-baseline.png"), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("window.__colorPickerTest.destroy()");
      assert.equal(baseline.outsideViewport, true, "The original scrolled style panel must reproduce the misplaced popup");
      const fixed = await window.webContents.executeJavaScript(`(${browserColorPickerSetup.toString()})(true)`);
      const interactions = await window.webContents.executeJavaScript("window.__colorPickerTest.interactions()");
      const shorthand = await window.webContents.executeJavaScript("window.__colorPickerTest.shorthandProbe()");
      const resizing = await window.webContents.executeJavaScript("(async () => { const t = window.__colorPickerTest; await t.open('background-color', 0.35); const original = t.component.getStyle()['background-color']; const preview = await t.drag(0.47); return { original, preview, position: t.snapshot() }; })()");
      window.setContentSize(1120, 740);
      const liveResize = await window.webContents.executeJavaScript("window.__colorPickerTest.assertPosition()");
      assert.equal(await window.webContents.executeJavaScript("window.__colorPickerTest.component.getStyle()['background-color']"), resizing.preview);
      window.webContents.setZoomFactor(1.25);
      const liveZoom = await window.webContents.executeJavaScript("window.__colorPickerTest.assertPosition()");
      assert.equal(await window.webContents.executeJavaScript("window.__colorPickerTest.component.getStyle()['background-color']"), resizing.preview);
      await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); window.__colorPickerTest.settle()");
      assert.equal(await window.webContents.executeJavaScript("window.__colorPickerTest.component.getStyle()['background-color']"), resizing.original);
      const viewports = [];
      for (const [width, height, zoom] of [[1120, 740, 1], [1120, 740, 1.25], [760, 580, 1], [420, 680, 1], [640, 480, 1.5]]) {
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(zoom);
        const positions = await window.webContents.executeJavaScript("window.__colorPickerTest.edges()");
        viewports.push({ window: [width, height], zoom, positions });
        await writeFile(path.join(dir, `color-picker-${width}x${height}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await writeFile(path.join(dir, "color-picker-position.json"), JSON.stringify({ baseline, fixed, interactions, shorthand, resizing, liveResize, liveZoom, viewports }, null, 2));
      await window.webContents.executeJavaScript("window.__colorPickerTest.destroy()");
      assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.wireframe-color-picker').length"), 0);
      console.log(JSON.stringify({ status: "PASS", baseline, fixed, shorthand, colorControls: interactions.colors.map(item => item.property), viewports: viewports.map(item => ({ window: item.window, zoom: item.zoom, visiblePositions: item.positions.length })), scrollTracked: true, openPopupResized: true, openPopupZoomed: true, previewSurvivedResize: true, cancelAndEscapeRestored: true, hiddenTriggerCancelled: true, cleanedUp: true, artifacts: dir, isolatedUserData: true, visibleWindows: 0 }));
      window.destroy(); app.exit(0); return;
    }
    const result = await window.webContents.executeJavaScript(`(${browserSymbolChecks.toString()})()`);
    const ts = (await import("typescript")).default;
    const compiled = ts.transpileModule(result.react, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
    assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    for (const [name, data] of Object.entries({ "symbols.png": Buffer.from(result.pngBase64, "base64"), "symbols.svg": result.svg, "symbols.html": result.html, "Wireframe.tsx": result.react, "hearts-layout.json": JSON.stringify({ layout: result.hearts, pngInk: result.heartPixels, fitChecks: result.fitChecks }, null, 2) }))
      await writeFile(path.join(dir, name), data);
    window.destroy();
    console.log(JSON.stringify({ status: "PASS", browser: process.versions.chrome, symbols: result.symbols, paintedPixels: result.paintedPixels, png: [result.width, result.height], exports: ["HTML", "React", "SVG", "PNG"], artifacts: dir, isolatedUserData: true, visibleWindows: 0 }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  })().catch(error => { console.error(error); app.exit(1); });
} else if (process.argv.includes("--browser") || process.argv.includes("--color-picker") || process.argv.includes("--geometry")) {
  const { createServer } = await import("vite");
  const { spawn } = await import("node:child_process");
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(import.meta.dirname, "..");
  const prefix = "wireframe-symbol-test-";
  const data = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "work"), { recursive: true });
  const colors = process.argv.includes("--color-picker");
  const geometry = process.argv.includes("--geometry");
  const artifacts = await mkdtemp(path.join(root, "work", geometry ? "geometry-check-" : colors ? "color-picker-check-" : "symbol-export-"));
  const server = await createServer({ configFile: false, root, publicDir: false, appType: "custom", logLevel: "warn", optimizeDeps: { noDiscovery: true, include: ["fflate", "html-to-image"] }, server: { host: "127.0.0.1", port: 0, watch: null } });
  server.middlewares.use((request, response, next) => {
    if (request.url !== "/__symbol_check.html") return next();
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><meta charset='utf-8'><title>Isolated symbol export check</title>");
  });
  try {
    await server.listen();
    const electron = (await import("electron")).default;
    const env = { ...process.env, WIREFRAME_EDITOR_CHECK: geometry ? "geometry" : colors ? "colors" : "symbols", WIREFRAME_SYMBOL_TEST_DATA: data, WIREFRAME_SYMBOL_TEST_ARTIFACTS: artifacts, WIREFRAME_SYMBOL_TEST_URL: `${server.resolvedUrls.local[0]}__symbol_check.html` };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error("Symbol export checks exceeded 120 seconds")); }, 120000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Symbol export checks failed (${signal || code})`)); });
    });
  } finally {
    await server.close();
    assert.equal(path.dirname(data), path.resolve(tmpdir()));
    assert.ok(path.basename(data).startsWith(prefix));
    await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
