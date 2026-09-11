import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

async function browserChecks(payload) {
  const { default: grapes } = await import("/node_modules/grapesjs/dist/grapes.mjs");
  const { blankProject, makeNode, recognitionProject } = await import("/lib/wireframe.ts");
  const { refineRecognitionTypography } = await import("/lib/recognition-typography.ts");
  const { refineRecognitionDraft } = await import("/lib/recognition-refinement.ts");
  const { projectComponents, componentDefinition, baseCanvasCss } = await import("/lib/editor-library.ts");
  const { buildExport, exportHtml, exportReact, studioFile, validateStudioFile } = await import("/lib/grapes-export.ts");
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const detected = (type, patch) => makeNode(type, { origin: "detected", reviewed: false, lineHeight: 1, value: 0, ...patch });
  const fixture = { ...blankProject(), name: "Source color and line layout", width: 720, height: 660, background: "#047fec", nodes: [
    detected("image", { id: "background", x: 0, y: 0, w: 720, h: 660, fill: "none", text: "" }),
    detected("text", { id: "heading", text: "My Cash", x: 226, y: 50, w: 268, h: 75, fontSize: 68, fontWeight: "700", color: "#f3fcff", align: "center", stroke: "none", textStroke: "#071b64", textStrokeWidth: 4 }),
    detected("frame", { id: "panel", x: 30, y: 160, w: 660, h: 145, fill: "#0645b9", stroke: "#ffffff", strokeWidth: 3 }),
    detected("text", { id: "balance-label", parentId: "panel", text: "CURRENT BALANCE", x: 172, y: 184, w: 268, h: 34, fontSize: 27, fontWeight: "700", color: "#ffffff" }),
    detected("text", { id: "amount", parentId: "panel", text: "$99.09", x: 180, y: 240, w: 330, h: 60, fontSize: 54, fontWeight: "700", color: "#ffffff" }),
    detected("image", { id: "ribbon", x: 50, y: 355, w: 620, h: 80, fill: "none", text: "" }),
    detected("text", { id: "options", text: "WITHDRAWAL OPTIONS", x: 166, y: 373, w: 389, h: 40, fontSize: 34, fontWeight: "700", align: "center", color: "#ffffff", textStroke: "#1c4800", textStrokeWidth: 2 }),
    detected("select", { id: "text-only-select", text: "More", x: 580, y: 500, w: 86, h: 38, fontSize: 27, fill: "none", stroke: "none", color: "#ffffff" }),
    detected("richtext", { id: "rich", text: "PAYMENT\nAccount details", x: 45, y: 490, w: 260, h: 72, fontSize: 28, color: "#ffffff", runs: [
      { text: "PAYMENT\n", fontSize: 32, fontWeight: "700", color: "#ffffff", italic: false, underline: false },
      { text: "Account details", fontSize: 25, fontWeight: "400", color: "#eaf8ff", italic: false, underline: false },
    ] }),
  ] };
  const source = document.createElement("canvas"); source.width = 720; source.height = 660;
  const context = source.getContext("2d");
  context.fillStyle = "#0482f4"; context.fillRect(0, 0, 720, 660);
  context.fillStyle = "#0848bd"; context.fillRect(30, 160, 660, 145);
  context.fillStyle = "#7bb906"; context.fillRect(50, 355, 620, 80);
  for (const node of fixture.nodes.filter(node => node.type === "text")) {
    context.font = `${node.fontWeight} ${node.fontSize * 0.92}px Arial`;
    context.fillStyle = node.color;
    context.fillText(node.text, node.x + 3, node.y + node.fontSize * 0.84);
  }
  fixture.reference = { src: source.toDataURL(), width: 720, height: 660, name: "Synthetic source.png" };
  const project = payload ? recognitionProject(payload.result, payload.reference, payload.result.width) : fixture;
  const snapshot = JSON.stringify(project);
  const refined = await refineRecognitionDraft(project);
  check(JSON.stringify(project) === snapshot, "Refinement must not mutate the original draft");
  check(refined.nodes.every((node, index) => node.text === project.nodes[index].text && node.x === project.nodes[index].x && node.y === project.nodes[index].y && node.w === project.nodes[index].w && node.h === project.nodes[index].h && node.parentId === project.nodes[index].parentId), "Literal content, hierarchy and geometry must remain intact");
  const protectedNodes = [makeNode("text", { text: "Manual text", fontSize: 40, w: 10 }), detected("text", { text: "Confirmed text", reviewed: true, fontSize: 40, w: 10 })];
  const protectedResult = await refineRecognitionTypography({ ...blankProject(), nodes: protectedNodes });
  check(JSON.stringify(protectedResult.nodes) === JSON.stringify(protectedNodes), "Manual and confirmed components must not be calibrated");
  const unresolved = await refineRecognitionTypography({ ...blankProject(), nodes: [detected("text", { text: "A deliberately impossible line", fontSize: 40, w: 10, h: 10 })] });
  check(unresolved.nodes[0].fontSize === 40 && unresolved.nodes[0].note.includes("未强行缩字"), "Bad geometry must remain explicit rather than force-fitting");
  const abort = new AbortController(); abort.abort();
  await refineRecognitionTypography(project, abort.signal).then(() => { throw Error("Aborted refinement succeeded"); }, error => check(error.name === "AbortError", "Expected AbortError"));
  const host = document.createElement("div"); document.body.appendChild(host);
  const ed = grapes.init({ container: host, height: "740px", storageManager: false, telemetry: false, cssIcons: "", panels: { defaults: [] }, avoidInlineStyle: true });
  const meta = { name: project.name, width: project.width, height: project.height, notes: refined.notes, engineRevision: 2, reference: project.reference };
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Canvas load timeout")), 15000); ed.on("load", () => { clearTimeout(timer); resolve(); }); });
    const render = async value => {
      ed.setStyle(baseCanvasCss); ed.setComponents(projectComponents(value));
      ed.getWrapper().addStyle({ width: `${value.width}px`, height: `${value.height}px`, position: "relative", overflow: "hidden", "background-color": value.background === "none" ? "transparent" : value.background });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    const inspect = value => value.nodes.filter(node => node.type === "text" || node.type === "richtext").map(node => {
      const component = ed.getWrapper().find(`[data-spec-id="${CSS.escape(node.id)}"]`)[0];
      const element = component.getEl(), view = element.ownerDocument.defaultView;
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const metrics = element.ownerDocument.createElement("canvas").getContext("2d");
      const rects = []; let text;
      while ((text = walker.nextNode())) {
        const font = view.getComputedStyle(text.parentElement); metrics.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        const ascent = metrics.measureText(text.data).fontBoundingBoxAscent;
        const range = element.ownerDocument.createRange(); range.selectNodeContents(text);
        rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, baseline: rect.top + ascent })));
      }
      rects.sort((a, b) => a.baseline - b.baseline);
      const lines = [];
      for (const rect of rects) if (!lines.some(baseline => Math.abs(baseline - rect.baseline) < 1)) lines.push(rect.baseline);
      const style = view.getComputedStyle(element);
      return { id: node.id, name: node.name, fontSize: node.fontSize, renderedFontSize: style.fontSize, fontFamily: style.fontFamily, width: style.width, rects: rects.map(rect => ({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })), lines: lines.length, expectedLines: node.text.split("\n").length, whiteSpace: style.whiteSpace, textStroke: style.webkitTextStrokeWidth, boxBorder: style.borderTopWidth };
    });
    await render(project); const before = inspect(project);
    await render(refined); const after = inspect(refined);
    check(after.every(node => node.lines <= node.expectedLines), "Rendering must not introduce extra source lines");
    if (!payload) {
      for (const id of ["heading", "balance-label", "options"]) {
        check(before.find(node => node.id === id).lines > 1, `Fixture ${id} must reproduce extra wrapping`);
        check(after.find(node => node.id === id).lines === 1, `Refined ${id} must remain one line`);
      }
      check(after.find(node => node.id === "heading").boxBorder === "0px", "Glyph outline must not become a box border");
      check(parseFloat(after.find(node => node.id === "heading").textStroke) === 4, "Glyph outline must survive rendering");
      check(after.find(node => node.id === "rich").lines === 2, "Explicit rich-text lines must survive");
      check(refined.nodes.find(node => node.id === "background").fill === "#0482f4", "Source background color must survive");
      check(refined.nodes.find(node => node.id === "ribbon").fill === "#7bb906", "Source ribbon color must survive");
      const select=ed.getWrapper().find('[data-spec-id="text-only-select"]')[0];
      check(select.getStyle().padding === "0", "Borderless recognized controls must not receive library padding");
      const font=select.getEl().ownerDocument.defaultView.getComputedStyle(select.getEl());
      const metrics=document.createElement("canvas").getContext("2d"); metrics.font=`${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      check(metrics.measureText("More").width+18<=86, "Select text must fit alongside the native arrow");
      check(componentDefinition(makeNode("select", {fill:"none",stroke:"none"})).style.padding === "0 12px", "Manual library controls keep their existing padding");
    }
    const imageProbe = ed.getWrapper().append(componentDefinition(detected("image", { id: "image-size-probe", text: "", x: 0, y: 0, w: 90, h: 36, fill: "#e0efff", stroke: "none", color: "none" })))[0];
    for (const [width, height] of [[90, 36], [36, 90], [390, 220]]) {
      imageProbe.addStyle({ width: `${width}px`, height: `${height}px` });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const svg = imageProbe.getEl().querySelector('[data-image-placeholder="diagonal-frame"]');
      check(svg && svg.querySelectorAll("rect").length === 1 && svg.querySelectorAll("line").length === 2, "Image placeholders must show a rectangle and both diagonals");
      check(Math.abs(svg.getBoundingClientRect().width - width) < 1 && Math.abs(svg.getBoundingClientRect().height - height) < 1, "Image placeholder must track the full component size");
      const diagonal = svg.querySelector("line");
      check(Math.abs(diagonal.x2.baseVal.value - width) < 1 && Math.abs(diagonal.y2.baseVal.value - height) < 1, "Diagonal endpoints must reach resized corners");
      check(imageProbe.components().at(0).get("selectable") === false, "Only the complete image component can be selected");
    }
    imageProbe.remove();
    for (const [fill, color, marker] of [["#ffffff", "#ffffff", "rgb(120, 134, 150)"], ["#111111", "#111111", "rgb(213, 226, 236)"]]) {
      const probe = ed.getWrapper().append(componentDefinition(detected("image", { fill, color, stroke: "none", text: "Caption" })))[0];
      const element = probe.getEl(), view = element.ownerDocument.defaultView;
      check(probe.getStyle().color === color && probe.getStyle()["background-color"] === fill, "Placeholder markers must not change source label or fill colors");
      for (const shape of element.querySelectorAll("svg rect, svg line")) {
        check(view.getComputedStyle(shape).stroke === marker, "Image boundaries must remain visible even when foreground and fill are identical");
      }
      probe.remove();
    }
    await render(refined);
    const saved = validateStudioFile(JSON.parse(JSON.stringify(studioFile(ed, meta)))); await ed.loadProjectData(saved.editor);
    const html = exportHtml(ed, meta), react = exportReact(ed), svg = await (await buildExport(ed, meta, "svg")).blob.text();
    check(html.includes("white-space:pre"), "HTML must preserve source line layout");
    if (refined.nodes.some(node => node.textStrokeWidth > 0)) check(html.includes("-webkit-text-stroke"), "HTML must preserve detected glyph outlines");
    check(html.includes('data-image-placeholder="diagonal-frame"') && svg.includes('data-image-placeholder="diagonal-frame"'), "Exports must retain the full-size image placeholders");
    check(!new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror"), "SVG must remain valid");
    const exportedBody=new DOMParser().parseFromString(svg,"image/svg+xml").querySelector("foreignObject > body");
    const canvasBackground=ed.getWrapper().getEl().ownerDocument.defaultView.getComputedStyle(ed.getWrapper().getEl()).backgroundColor;
    check(exportedBody?.style.backgroundColor===canvasBackground, "Export must retain the canvas background, not force white");
    const png = (await buildExport(ed, meta, "png")).blob;
    const bitmap = await createImageBitmap(png);
    const pngBase64 = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(png); });
    return { before, after, refined, studio: saved, html, react, svg, pngBase64, width: bitmap.width, height: bitmap.height };
  } finally { ed.destroy(); host.remove(); }
}

if (process.versions.electron) {
  const { app, BrowserWindow } = await import("electron");
  app.setName("Wireframe Isolated Fidelity Check"); app.setPath("userData", process.env.WIREFRAME_FIDELITY_DATA);
  void (async () => {
    try {
      await app.whenReady();
      const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      await window.loadURL(process.env.WIREFRAME_FIDELITY_URL);
      const payload = process.env.WIREFRAME_FIDELITY_CASE ? JSON.parse(await readFile(process.env.WIREFRAME_FIDELITY_CASE, "utf8")) : null;
      const result = await window.webContents.executeJavaScript(`(${browserChecks.toString()})(${JSON.stringify(payload)})`);
      const ts = (await import("typescript")).default;
      const compiled = ts.transpileModule(result.react, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
      assert.equal((compiled.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
      const output = process.env.WIREFRAME_FIDELITY_OUTPUT;
      for (const [name, data] of Object.entries({ "fidelity.png": Buffer.from(result.pngBase64, "base64"), "fidelity.html": result.html, "fidelity.svg": result.svg, "Wireframe.tsx": result.react, "project.json": JSON.stringify(result.refined), "project.wireframe": JSON.stringify(result.studio), "measurements.json": JSON.stringify({ before: result.before, after: result.after }, null, 2) })) await writeFile(join(output, name), data);
      window.destroy();
      console.log(JSON.stringify({ passed: true, sourceCase: Boolean(payload), dimensions: [result.width, result.height], nodes: result.refined.nodes.length, layout: result.after.map(node => ({ name: node.name, fontSize: node.fontSize, lines: node.lines, expectedLines: node.expectedLines })), output }));
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  })();
} else {
  const { createServer } = await import("vite");
  const root = resolve(import.meta.dirname, "..");
  const data = await mkdtemp(join(tmpdir(), "wireframe-fidelity-"));
  await mkdir(join(root, "work"), { recursive: true });
  const output = await mkdtemp(join(root, "work", "fidelity-check-"));
  const server = await createServer({ configFile: false, root, publicDir: false, appType: "custom", logLevel: "warn", optimizeDeps: { noDiscovery: true, include: ["fflate", "html-to-image"] }, server: { host: "127.0.0.1", port: 0, watch: null } });
  server.middlewares.use((req, res, next) => { if (req.url !== "/__fidelity_check") return next(); res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<!doctype html><title>Isolated fidelity check</title>"); });
  try {
    await server.listen();
    const electron = (await import("electron")).default;
    const env = { ...process.env, WIREFRAME_FIDELITY_DATA: data, WIREFRAME_FIDELITY_OUTPUT: output, WIREFRAME_FIDELITY_URL: `${server.resolvedUrls.local[0]}__fidelity_check` };
    const caseIndex = process.argv.indexOf("--case"); if (caseIndex !== -1) { assert.ok(process.argv[caseIndex + 1], "--case requires a JSON file"); env.WIREFRAME_FIDELITY_CASE = resolve(process.argv[caseIndex + 1]); }
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [import.meta.filename], { cwd: root, env, stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error("Fidelity check exceeded 120 seconds")); }, 120000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Fidelity check failed (${code})`)); });
    });
  } finally {
    await server.close(); assert.equal(dirname(data), resolve(tmpdir())); assert.ok(basename(data).startsWith("wireframe-fidelity-"));
    await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
