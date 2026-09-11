import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { createVisionService } from "../desktop/vision-service.mjs";
import { recognitionProject } from "../lib/wireframe.ts";

const { values } = parseArgs({ options: { image: { type: "string" } } });
assert.ok(values.image, "--image requires the original local screenshot");
const root = resolve(import.meta.dirname, "..");
const source = resolve(values.image), bytes = await readFile(source);
const metadata = await sharp(bytes).metadata();
assert.ok(["png", "jpeg", "webp"].includes(metadata.format));
const reference = { src: `data:image/${metadata.format};base64,${bytes.toString("base64")}`, name: basename(source), width: metadata.width, height: metadata.height };
await mkdir(join(root, "work"), { recursive: true });
const output = await mkdtemp(join(root, "work/native-vision-check-"));
const runtimeDir = join(output, "jobs");
const service = createVisionService({ runtimeDir, instructionsPath: join(root, "server/vision-instructions.txt") });
let last = "", loggedAt = 0;
try {
  const { id } = await service.start({ image: reference.src, name: reference.name, width: reference.width });
  console.log(JSON.stringify({ started: true, id, output, dimensions: [reference.width, reference.height], imageSha256: createHash("sha256").update(bytes).digest("hex") }));
  for (;;) {
    const job = service.get(id), key = `${job.status}:${job.progress.stage}:${job.progress.eventCount}`;
    if (key !== last || Date.now() - loggedAt > 30000) {
      console.log(JSON.stringify({ status: job.status, elapsedMs: job.elapsed, ...job.progress }));
      last = key; loggedAt = Date.now();
    }
    if (job.status !== "running") {
      while (service.isBusy()) await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(join(output, "job.json"), JSON.stringify({ ...service.get(id), result: undefined }, null, 2));
      assert.equal(job.status, "done", job.error);
      const project = recognitionProject(job.result, reference, reference.width);
      await writeFile(join(output, "case.json"), JSON.stringify({ result: job.result, reference }));
      await writeFile(join(output, "project.json"), JSON.stringify(project));
      assert.deepEqual(await readFile(source), bytes);
      assert.deepEqual(await readdir(runtimeDir), []);
      console.log(JSON.stringify({ passed: true, id, elapsedMs: job.elapsed, nodes: project.nodes.length, frames: project.nodes.filter(node => node.type === "frame").length, images: project.nodes.filter(node => node.type === "image").length, casePath: join(output, "case.json"), sourceUnchanged: true }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
} finally { await service.dispose(); }
