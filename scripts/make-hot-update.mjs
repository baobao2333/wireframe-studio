import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import {
  canonicalPayload, sha256, unpackRendererArchive, UPDATE_LIMITS,
  validateArchivePath, validateManifestPayload, verifyManifest,
} from "../desktop/hot-update.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function replaceFile(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function digestFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function makeHotUpdate({
  rendererDir = path.join(projectRoot, "dist-renderer"), outputDir,
  privateKeyPath, version, minAppVersion, tag = `v${version}`,
  nativePath, nativeVersion,
}) {
  if (!version || !minAppVersion || !outputDir || !privateKeyPath) {
    throw new Error("version, minAppVersion, outputDir, and privateKeyPath are required.");
  }
  if (Boolean(nativePath) !== Boolean(nativeVersion)) throw new Error("nativePath and nativeVersion must be supplied together.");
  const renderer = path.resolve(rendererDir);
  const output = path.resolve(outputDir);
  const keyPath = path.resolve(privateKeyPath);
  if (!keyPath.split(path.sep).includes(".release-secrets")) throw new Error("The signing key must remain inside a .release-secrets directory.");
  if (output === renderer || output.startsWith(renderer + path.sep) || output.split(path.sep).includes(".release-secrets")) {
    throw new Error("Release output must be outside the renderer and signing-secret directories.");
  }
  const keyInfo = await lstat(keyPath);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new Error("The signing key must be a regular private file.");
  const privateKey = createPrivateKey(await readFile(keyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The signing key must use Ed25519.");
  const files = Object.create(null);
  let total = 0;
  let count = 0;
  const collect = async (directory, prefix = "") => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Renderer input must not contain linked directories.");
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!prefix && entry.name.toLowerCase() === "ocr") continue;
      const name = `${prefix}${entry.name}`;
      validateArchivePath(name);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(filename, `${name}/`);
      else {
        const fileInfo = await lstat(filename);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`Renderer input contains a link or nonregular file: ${name}`);
        count += 1;
        total += fileInfo.size;
        if (count > UPDATE_LIMITS.entries || fileInfo.size > UPDATE_LIMITS.fileBytes || total > UPDATE_LIMITS.extractedBytes) {
          throw new Error("Renderer input exceeds the updater's file count or extracted size limit.");
        }
        files[name] = await readFile(filename);
      }
    }
  };
  await collect(renderer);
  const archive = zipSync(files, { level: 9, mtime: new Date(2020, 0, 1, 0, 0, 0), os: 0 });
  unpackRendererArchive(archive);
  const filename = `renderer-${version}.zip`;
  const payload = {
    schemaVersion: 1, version, minAppVersion, tag,
    archive: { filename, size: archive.byteLength, sha256: sha256(archive) },
  };
  if (nativePath) {
    const installer = path.resolve(nativePath);
    const info = await lstat(installer);
    if (!info.isFile() || info.isSymbolicLink() || info.size > UPDATE_LIMITS.nativeBytes) throw new Error("Native installer is invalid or exceeds its size limit.");
    payload.native = { version: nativeVersion, filename: path.basename(installer), size: info.size, sha256: await digestFile(installer) };
  }
  validateManifestPayload(payload);
  const manifest = { payload, signature: sign(null, Buffer.from(canonicalPayload(payload)), privateKey).toString("base64") };
  verifyManifest(manifest, createPublicKey(privateKey));
  await mkdir(output, { recursive: true });
  const archivePath = path.join(output, filename);
  const manifestPath = path.join(output, "renderer-update.json");
  await replaceFile(archivePath, archive);
  await replaceFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { archivePath, manifestPath, files: count, extractedBytes: total, payload };
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" }, "min-app-version": { type: "string" },
      tag: { type: "string" }, output: { type: "string", default: "release/renderer" },
      "private-key": { type: "string" }, "native-path": { type: "string" },
      "native-version": { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("node scripts/make-hot-update.mjs --version 1.0.1 --min-app-version 1.0.0 --tag v1.0.1 --output release --private-key .release-secrets/update-private-key.pem [--native-path release/Wireframe-Studio-Setup-1.0.1.exe --native-version 1.0.1]");
    return;
  }
  const result = await makeHotUpdate({
    version: values.version, minAppVersion: values["min-app-version"], tag: values.tag,
    outputDir: path.resolve(projectRoot, values.output),
    privateKeyPath: values["private-key"] ? path.resolve(projectRoot, values["private-key"]) : undefined,
    nativePath: values["native-path"] ? path.resolve(projectRoot, values["native-path"]) : undefined,
    nativeVersion: values["native-version"],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Hot update build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
