import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import ts from "typescript";
import { listPackage, extractFile } from "@electron/asar";
import { unpackRendererArchive, verifyManifest } from "../desktop/hot-update.mjs";
import { verifyWindowsInstaller, verifyWindowsSignature } from "../desktop/windows-signature.mjs";

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
const publisher = JSON.parse(await readFile(join(root, "desktop/publisher.json"), "utf8"));
const certificate = new X509Certificate(await readFile(join(root, "assets/publisher.cer")));
assert.equal(certificate.subject, publisher.subject);
assert.equal(certificate.fingerprint256.replaceAll(":", ""), publisher.certificateSha256);
const installerSignature = await verifyWindowsInstaller(join(output, payload.native.filename), payload.native);
await verifyWindowsSignature(join(output, "win-unpacked/Wireframe Studio.exe"));
const rendererZip = await readFile(join(output, payload.archive.filename));
assert.equal(rendererZip.length, payload.archive.size);
assert.equal(createHash("sha256").update(rendererZip).digest("hex"), payload.archive.sha256);
const rendererFiles = unpackRendererArchive(rendererZip);
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
  files = listPackage(archive).map((file) => file.replaceAll("\\", "/"));
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
assert.equal(bundled.rendererVersion, payload.version);
assert.equal(payload.minAppVersion, bundled.minAppVersion);
for (const name of ["main.mjs", "preload.cjs", "electron-fetch.mjs", "hot-update.mjs",
  "storage.mjs", "vision-service.mjs", "vision-progress.mjs", "release.json", "update-public-key.pem",
  "publisher.json", "windows-signature.mjs", "verify-signature.ps1"]) {
  assert.deepEqual(extractFile(archive, join("desktop", name)), await readFile(join(root, "desktop", name)), name);
}
assert.deepEqual(extractFile(archive, join("server", "vision-schema.mjs")), await readFile(join(root, "server", "vision-schema.mjs")));
assert.deepEqual(await readFile(join(output, "win-unpacked/resources/vision-instructions.txt")), await readFile(join(root, "server/vision-instructions.txt")));
let healthCalls = 0;
for (const [name, bytes] of Object.entries(rendererFiles)) {
  assert.deepEqual(extractFile(archive, join("renderer", name)), Buffer.from(bytes), name);
  assert.deepEqual(await readFile(join(root, "dist-renderer", name)), Buffer.from(bytes), name);
  if (!name.endsWith(".js")) continue;
  const source = ts.createSourceFile(name, Buffer.from(bytes).toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "rendererReady") {
      assert.equal(node.arguments.length, 1);
      assert.ok(ts.isStringLiteralLike(node.arguments[0]));
      assert.equal(node.arguments[0].text, bundled.rendererVersion);
      healthCalls++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
assert.equal(healthCalls, 1, "Renderer health acknowledgement must contain its compiled version");
for (const resource of [
  "ocr/opencv.js",
  "ocr/worker.min.js",
  "ocr/shape-worker.js",
  "THIRD-PARTY-NOTICES.txt",
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
      authenticode: installerSignature,
      asarEntries: files.length,
      assets,
      passed: true,
    },
    null,
    2,
  ),
);
