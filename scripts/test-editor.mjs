import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import grapesjs from "grapesjs";
import formsModule from "grapesjs-plugin-forms";
import {
  captureLibraryComponent,
  normalizeComponentStyle,
  normalizeToolbarPointer,
} from "../lib/component-snapshot.ts";
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

if (process.versions.electron && process.env.WIREFRAME_SYMBOL_TEST_URL) {
  const { app, BrowserWindow } = await import("electron");
  // Electron emits ready after its entry module finishes evaluating.
  void (async () => {
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  app.setName("Wireframe Isolated Symbol Check");
  app.setPath("userData", process.env.WIREFRAME_SYMBOL_TEST_DATA);
  try {
    await app.whenReady();
    console.log("Symbol browser check: Electron ready");
    const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.message.startsWith("Symbol browser check:")) console.log(details.message);
    });
    await window.loadURL(process.env.WIREFRAME_SYMBOL_TEST_URL);
    console.log("Symbol browser check: fixture page loaded");
    const result = await window.webContents.executeJavaScript(`(${browserSymbolChecks.toString()})()`);
    const ts = (await import("typescript")).default;
    const compiled = ts.transpileModule(result.react, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
    assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    const dir = process.env.WIREFRAME_SYMBOL_TEST_ARTIFACTS;
    for (const [name, data] of Object.entries({ "symbols.png": Buffer.from(result.pngBase64, "base64"), "symbols.svg": result.svg, "symbols.html": result.html, "Wireframe.tsx": result.react, "hearts-layout.json": JSON.stringify({ layout: result.hearts, pngInk: result.heartPixels, fitChecks: result.fitChecks }, null, 2) }))
      await writeFile(path.join(dir, name), data);
    window.destroy();
    console.log(JSON.stringify({ status: "PASS", browser: process.versions.chrome, symbols: result.symbols, paintedPixels: result.paintedPixels, png: [result.width, result.height], exports: ["HTML", "React", "SVG", "PNG"], artifacts: dir, isolatedUserData: true, visibleWindows: 0 }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  })().catch(error => { console.error(error); app.exit(1); });
} else if (process.argv.includes("--browser")) {
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
  const artifacts = await mkdtemp(path.join(root, "work", "symbol-export-"));
  const server = await createServer({ configFile: false, root, publicDir: false, appType: "custom", logLevel: "warn", optimizeDeps: { noDiscovery: true, include: ["fflate", "html-to-image"] }, server: { host: "127.0.0.1", port: 0, watch: null } });
  server.middlewares.use((request, response, next) => {
    if (request.url !== "/__symbol_check.html") return next();
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><meta charset='utf-8'><title>Isolated symbol export check</title>");
  });
  try {
    await server.listen();
    const electron = (await import("electron")).default;
    const env = { ...process.env, WIREFRAME_SYMBOL_TEST_DATA: data, WIREFRAME_SYMBOL_TEST_ARTIFACTS: artifacts, WIREFRAME_SYMBOL_TEST_URL: `${server.resolvedUrls.local[0]}__symbol_check.html` };
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
