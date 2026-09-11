import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash, createPublicKey } from "node:crypto";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { listPackage, extractFile } from "@electron/asar";
import { verifyManifest } from "../desktop/hot-update.mjs";

const root = resolve(import.meta.dirname, ".."),
  output = join(root, "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(
  await readFile(join(output, "renderer-update.json"), "utf8"),
);
const payload = verifyManifest(
  manifest,
  createPublicKey(await readFile(join(root, "desktop/update-public-key.pem"))),
);
assert.equal(payload.version, pkg.version);
assert.equal(payload.native.version, pkg.version);
const installer = await readFile(join(output, payload.native.filename));
assert.equal(installer.length, payload.native.size);
assert.equal(
  createHash("sha256").update(installer).digest("hex"),
  payload.native.sha256,
);
const latest = yaml.load(await readFile(join(output, "latest.yml"), "utf8"));
assert.equal(latest.version, pkg.version);
assert.equal(latest.files[0].url, payload.native.filename);
assert.equal(latest.files[0].size, installer.length);
assert.equal(
  latest.files[0].sha512,
  createHash("sha512").update(installer).digest("base64"),
);
const archive = join(output, "win-unpacked/resources/app.asar"),
  files = listPackage(archive).map(file=>file.replaceAll("\\", "/"));
assert.ok(files.includes("/desktop/update-public-key.pem"));
assert.ok(files.includes("/renderer/index.html"));
assert.ok(
  !files.some((file) =>
    /private.?key|release-secrets|exports|\.wireframe-runtime|\.codex|\.env|^\/work[\/\\]/i.test(
      file,
    ),
  ),
);
const bundled = JSON.parse(
  extractFile(archive, "desktop/release.json").toString(),
);
assert.equal(bundled.appVersion, pkg.version);
assert.equal(
  extractFile(archive, "desktop/main.mjs").toString(),
  await readFile(join(root, "desktop/main.mjs"), "utf8"),
);
for (const resource of [
  "ocr/opencv.js",
  "ocr/worker.min.js",
  "vision-instructions.txt",
  "app.ico",
])
  assert.ok(
    (await stat(join(output, "win-unpacked/resources", resource))).size > 0,
  );
const assets = [
  payload.native.filename,
  `${payload.native.filename}.blockmap`,
  "latest.yml",
  payload.archive.filename,
  "renderer-update.json",
];
const checksums = [];
for (const name of assets) {
  const bytes = await readFile(join(output, name));
  checksums.push(
    `${createHash("sha256").update(bytes).digest("hex")}  ${name}`,
  );
}
await writeFile(join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      installer: payload.native.filename,
      size: installer.length,
      sha256: payload.native.sha256,
      asarEntries: files.length,
      assets,
      passed: true,
    },
    null,
    2,
  ),
);
