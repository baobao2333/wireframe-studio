import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { refineRecognitionColors } from "../lib/recognition-colors.ts";
import { blankProject, makeNode, validateProject } from "../lib/wireframe.ts";

const { values } = parseArgs({ options: { reference: { type: "string" } } });
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`PASS ${name}`); }
const detected = (type, patch = {}) => makeNode(type, { origin: "detected", reviewed: false, color: "none", fill: "none", stroke: "none", ...patch });
const projectWith = (nodes, width = 240, height = 240) => ({ ...blankProject(), width, height, nodes });
function bitmap(width, height, color = "#ffffff", alpha = 255) {
  const pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  paint(pixels, 0, 0, width, height, color, alpha);
  return pixels;
}
function paint(pixels, x, y, width, height, color, alpha = 255) {
  const rgb = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
  for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++)
    pixels.data.set([...rgb, alpha], (py * pixels.width + px) * 4);
}
function withoutAllowedChanges(project) {
  const copy = structuredClone(project);
  for (const node of copy.nodes) {
    if (node.origin !== "detected" || node.reviewed) continue;
    for (const field of ["fill", "color", "stroke", "textStroke", "note"]) delete node[field];
    for (const run of node.runs ?? []) delete run.color;
  }
  return copy;
}

await test("local sampling honors canvas scale, minority white text, border color, and immutable input", () => {
  const pixels = bitmap(240, 120, "#0088ff");
  paint(pixels, 40, 20, 100, 50, "#102f58");
  paint(pixels, 42, 22, 96, 46, "#e34d36");
  paint(pixels, 62, 34, 5, 20, "#ffffff");
  paint(pixels, 77, 34, 5, 20, "#ffffff");
  const node = detected("button", { x: 80, y: 40, w: 200, h: 100, text: "$99.09", fill: "#e64838", color: "#fafafa", stroke: "#16355c", strokeWidth: 4, note: "Keep this review note." });
  const project = projectWith([node], 480, 240), before = structuredClone(project), bytes = pixels.data.slice();
  const refined = refineRecognitionColors(project, pixels);
  assert.equal(refined.nodes[0].fill, "#e34d36");
  assert.equal(refined.nodes[0].color, "#ffffff");
  assert.equal(refined.nodes[0].stroke, "#102f58");
  assert.equal(refined.nodes[0].text, "$99.09");
  assert.match(refined.nodes[0].note, /局部近色取样/);
  assert.ok(refined.nodes[0].note.startsWith(node.note));
  assert.deepEqual(project, before);
  assert.deepEqual(pixels.data, bytes);
  assert.notEqual(refined.nodes[0], node);
  assert.deepEqual(withoutAllowedChanges(refined), withoutAllowedChanges(project));
  validateProject(refined);
});

await test("glyph outline and rich-text run colors are calibrated without altering typography or transparent fill", () => {
  const pixels = bitmap(240, 240, "#0768d8");
  paint(pixels, 20, 20, 40, 35, "#173366");
  paint(pixels, 24, 24, 32, 27, "#ffffff");
  paint(pixels, 80, 20, 36, 35, "#ffe05c");
  const node = detected("richtext", { x: 10, y: 10, w: 120, h: 60, text: "原始 $3000", color: "#fafafa", textStroke: "#162f61", textStrokeWidth: 2,
    runs: [{ text: "原始 ", color: "#fafafa", fontSize: 20, fontWeight: "700", italic: false, underline: false },
      { text: "$3000", color: "#ffe461", fontSize: 28, fontWeight: "400", italic: true, underline: true }] });
  const project = projectWith([node]), refined = refineRecognitionColors(project, pixels);
  assert.equal(refined.nodes[0].fill, "none");
  assert.equal(refined.nodes[0].color, "#ffffff");
  assert.equal(refined.nodes[0].textStroke, "#173366");
  assert.deepEqual(refined.nodes[0].runs.map(run => run.color), ["#ffffff", "#ffe05c"]);
  assert.deepEqual(withoutAllowedChanges(refined), withoutAllowedChanges(project));
});

await test("tree paint order excludes foreground panels but never excludes an entire transparent group", () => {
  const pixels = bitmap(240, 240, "#248cdb");
  paint(pixels, 0, 0, 216, 150, "#0048a0");
  paint(pixels, 0, 150, 216, 90, "#ffffff");
  paint(pixels, 218, 0, 5, 180, "#ffffff");
  const backdrop = detected("image", { id: "sky", x: 0, y: 0, w: 240, h: 240 });
  const group = detected("frame", { id: "group", x: 0, y: 0, w: 240, h: 240 });
  const blue = detected("frame", { id: "blue", parentId: "group", x: 0, y: 0, w: 216, h: 150, fill: "#0048a0" });
  const white = detected("frame", { parentId: "group", x: 0, y: 150, w: 216, h: 90, fill: "#ffffff", reviewed: true });
  const text = detected("text", { parentId: "group", x: 216, y: 0, w: 24, h: 180, text: "Foreground", color: "#ffffff" });
  const hidden = detected("frame", { id: "hidden", x: 0, y: 0, w: 240, h: 240, fill: "#111111", hidden: true });
  const child = detected("image", { parentId: "hidden", x: 0, y: 0, w: 240, h: 240 });
  const project = projectWith([blue, white, text, child, backdrop, group, hidden]);
  const refined = refineRecognitionColors(project, pixels);
  assert.equal(refined.nodes.find(node => node.id === "sky").fill, "#248cdb");
  assert.match(refined.nodes.find(node => node.id === "sky").note, /主色近似.*细节未还原/);
  assert.equal(refined.nodes.find(node => node.id === "group").fill, "none");
  assert.deepEqual(refined.nodes[1], white);
  assert.deepEqual(refined.nodes[3], child);
  assert.deepEqual(refined.nodes[6], hidden);
  assert.deepEqual(withoutAllowedChanges(refined), withoutAllowedChanges(project));
});

await test("existing image content and foreground leaves count as occlusion even with no fill", () => {
  const pixels = bitmap(240, 240, "#319bdb");
  paint(pixels, 0, 0, 220, 240, "#f6c124");
  const back = detected("image", { id: "back", x: 0, y: 0, w: 240, h: 240 });
  const front = detected("image", { id: "front", x: 0, y: 0, w: 220, h: 240, reviewed: true });
  const project = projectWith([back, front]);
  const refined = refineRecognitionColors(project, pixels);
  assert.equal(refined.nodes[0].fill, "#319bdb");
  assert.deepEqual(refined.nodes[1], front);
});

await test("transparent, covered, and off-canvas areas retain estimates with explicit insufficient-sample notes", () => {
  const transparent = bitmap(240, 240, "#ff0000", 0);
  paint(transparent, 0, 0, 240, 100, "#ffffff", 128);
  const image = detected("image", { x: 0, y: 0, w: 240, h: 240 });
  assert.equal(refineRecognitionColors(projectWith([image]), transparent).nodes[0].fill, "none");
  assert.match(refineRecognitionColors(projectWith([image]), transparent).nodes[0].note, /取样不足/);
  const cover = makeNode("frame", { x: 0, y: 0, w: 240, h: 240, fill: "#ffffff" });
  const covered = refineRecognitionColors(projectWith([image, cover]), bitmap(240, 240));
  assert.equal(covered.nodes[0].fill, "none");
  assert.match(covered.nodes[0].note, /取样不足/);
  assert.deepEqual(covered.nodes[1], cover);
  const outside = detected("frame", { x: 1000, y: 1000, w: 200, h: 200, fill: "#dddddd" });
  const clipped = refineRecognitionColors(projectWith([outside]), bitmap(240, 240));
  assert.equal(clipped.nodes[0].fill, "#dddddd");
  assert.match(clipped.nodes[0].note, /取样不足/);
});

await test("distant model colors are not replaced from the whole image or majority background", () => {
  const pixels = bitmap(240, 240, "#1267db");
  paint(pixels, 0, 0, 100, 100, "#dc231d");
  const target = detected("frame", { x: 0, y: 0, w: 100, h: 100, fill: "#1267db" });
  const whiteText = detected("text", { x: 120, y: 120, w: 100, h: 100, color: "#ffffff", text: "White text not sampled" });
  const project = projectWith([target, whiteText]), refined = refineRecognitionColors(project, pixels);
  assert.equal(refined.nodes[0].fill, target.fill);
  assert.equal(refined.nodes[1].color, "#ffffff");
  assert.equal(refined.nodes[1].fill, "none");
  for (const node of refined.nodes) assert.match(node.note, /未找到.*接近.*保留原值/);
});

await test("manual and reviewed nodes are untouched, and invalid pixel data fails explicitly", () => {
  const reviewed = detected("icon", { reviewed: true, color: "#eeeeee", fill: "none", textStroke: "#111111", textStrokeWidth: 2 });
  const manual = makeNode("button", { color: "#eeeeee", fill: "#999999", reviewed: false });
  const project = projectWith([reviewed, manual]);
  assert.deepEqual(refineRecognitionColors(project, bitmap(240, 240)), project);
  assert.throws(() => refineRecognitionColors(project, { width: 240, height: 240, data: new Uint8ClampedArray(3) }), /像素数据无效/);
  const fullNote = detected("image", { x: 0, y: 0, w: 240, h: 240, note: "x".repeat(10000) });
  assert.throws(() => refineRecognitionColors(projectWith([fullNote]), bitmap(240, 240)), /备注已满/);
  assert.equal(fullNote.note.length, 10000);
  assert.equal(fullNote.fill, "none");
});

await test("sampling stays bounded independently of source area", () => {
  let reads = 0;
  const source = new Uint8ClampedArray(512 * 512 * 4).fill(255);
  const data = new Proxy(source, { get(target, field) {
    if (typeof field === "string" && /^\d+$/.test(field)) reads++;
    return Reflect.get(target, field, target);
  } });
  const node = detected("image", { x: 0, y: 0, w: 6000, h: 6000, stroke: "#fffefc" });
  const refined = refineRecognitionColors(projectWith([node], 6000, 6000), { data, width: 512, height: 512 });
  assert.equal(refined.nodes[0].fill, "#ffffff");
  assert.ok(reads > 0 && reads <= (2048 + 512) * 4, `Unexpected pixel read count: ${reads}`);
});

await test("a gradient placeholder uses an observed representative rather than an invented average", () => {
  const pixels = bitmap(240, 240, "#54a803");
  paint(pixels, 120, 0, 120, 240, "#65b710");
  const node = detected("image", { x: 0, y: 0, w: 240, h: 240 });
  const refined = refineRecognitionColors(projectWith([node]), pixels).nodes[0];
  assert.ok(["#54a803", "#65b710"].includes(refined.fill));
  assert.match(refined.note, /主色近似.*渐变.*未还原/);
});

if (values.reference) await test("offline reference sky and ribbon samples exclude overlapping foreground regions", async () => {
  const bytes = await readFile(values.reference);
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 720);
  assert.equal(info.height, 1560);
  const pixels = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
  const nodes = [
    detected("image", { id: "sky", x: 0, y: 0, w: 720, h: 1560 }),
    detected("frame", { id: "header", x: 0, y: 0, w: 720, h: 220 }),
    detected("text", { parentId: "header", x: 96, y: 36, w: 90, h: 36, text: "17:08", color: "#ffffff" }),
    detected("image", { parentId: "header", x: 506, y: 36, w: 152, h: 36 }),
    detected("image", { parentId: "header", x: 24, y: 100, w: 80, h: 88 }),
    detected("text", { parentId: "header", x: 186, y: 94, w: 350, h: 80, text: "My Cash", color: "#ffffff" }),
    detected("frame", { x: 26, y: 220, w: 670, h: 416, fill: "#0750b1" }),
    detected("frame", { id: "options", x: 28, y: 660, w: 668, h: 666 }),
    detected("frame", { parentId: "options", x: 28, y: 712, w: 668, h: 614, fill: "#f6f4e7" }),
    detected("frame", { id: "banner", parentId: "options", x: 54, y: 670, w: 612, h: 88 }),
    detected("image", { id: "ribbon", parentId: "banner", x: 54, y: 672, w: 612, h: 80 }),
    detected("text", { parentId: "banner", x: 166, y: 686, w: 390, h: 44, text: "WITHDRAWAL OPTIONS", color: "#ffffff" }),
    detected("icon", { parentId: "banner", x: 118, y: 684, w: 36, h: 38, color: "#ffdc4b" }),
    detected("icon", { parentId: "banner", x: 562, y: 684, w: 38, h: 38, color: "#ffdc4b" }),
    detected("button", { x: 78, y: 1370, w: 562, h: 112, fill: "#2a9900", color: "#ffffff" }),
  ];
  const refined = refineRecognitionColors(projectWith(nodes, 720, 1560), pixels);
  const sky = refined.nodes.find(node => node.id === "sky");
  const ribbon = refined.nodes.find(node => node.id === "ribbon");
  const rgb = value => [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  const [sr, sg, sb] = rgb(sky.fill), [rr, rg, rb] = rgb(ribbon.fill);
  assert.ok(sr < 80 && sg > 90 && sb > 170, `Expected sampled sky blue, received ${sky.fill}`);
  assert.ok(rg > 80 && rr < rg && rb < 80, `Expected sampled ribbon green, received ${ribbon.fill}`);
  assert.match(sky.note, /主色近似/);
  assert.match(ribbon.note, /主色近似/);
  assert.deepEqual(await readFile(values.reference), bytes);
  console.log(JSON.stringify({ reference: values.reference, sky: sky.fill, ribbon: ribbon.fill, sourceUnchanged: true }));
});

console.log(`Recognition color checks passed: ${passed}; no DOM, app windows, or model requests`);
