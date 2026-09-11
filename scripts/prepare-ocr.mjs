import { cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "public/ocr");
await mkdir(resolve(output, "core"), { recursive: true });
await mkdir(resolve(output, "lang"), { recursive: true });
await cp(resolve(root, "node_modules/@techstark/opencv-js/dist/opencv.js"), resolve(output, "opencv.js"));
await cp(resolve(root, "desktop/renderer/shape-worker.js"), resolve(output, "shape-worker.js"));
await cp(resolve(root, "node_modules/tesseract.js/dist/worker.min.js"), resolve(output, "worker.min.js"));
for (const file of await readdir(resolve(root, "node_modules/tesseract.js-core"))) {
  if (file.endsWith(".wasm.js")) await cp(resolve(root, "node_modules/tesseract.js-core", file), resolve(output, "core", file));
}
for (const lang of ["eng", "chi_sim"]) await cp(resolve(root, `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), resolve(output, "lang", `${lang}.traineddata.gz`));
await cp(resolve(root, "node_modules/tesseract.js-core/LICENSE"), resolve(output, "TESSERACT-LICENSE"));
console.log("OCR engines and language models copied to same-origin assets.");
