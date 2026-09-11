import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import {
  canonicalPayload, createHotUpdater, sha256, unpackRendererArchive,
  UPDATE_FEED_URL, UPDATE_LIMITS, verifyManifest,
} from "../desktop/hot-update.mjs";
import { makeHotUpdate } from "./make-hot-update.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wireframe-hot-update-test-"));
const bundledRoot = path.join(temporaryRoot, "bundled");
const publicKeyPath = path.join(temporaryRoot, "update-public-key.pem");
const secretRoot = path.join(temporaryRoot, ".release-secrets");
const privateKeyPath = path.join(secretRoot, "fixture-private-key.pem");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await mkdir(bundledRoot);
await mkdir(secretRoot);
await writeFile(path.join(bundledRoot, "index.html"), "<title>Bundled 1.0.0</title>");
await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

let served;
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === "/renderer-update.json") {
    if (served.redirect) {
      response.writeHead(302, { Location: served.redirect });
      response.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(served.manifest));
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
    return;
  }
  const expected = `/baobao2333/wireframe-studio/releases/download/${encodeURIComponent(served.manifest.payload.tag)}/${encodeURIComponent(served.manifest.payload.archive.filename)}`;
  if (request.url !== expected) {
    response.writeHead(404);
    response.end();
    return;
  }
  const body = served.archive;
  response.writeHead(200, served.chunked ? {} : { "Content-Length": served.advertisedSize ?? body.length });
  response.write(body.subarray(0, Math.ceil(body.length / 2)));
  response.end(body.subarray(Math.ceil(body.length / 2)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${server.address().port}/renderer-update.json`;

function signedRelease(version, { entries, minAppVersion = "1.0.0", native } = {}) {
  const files = Object.create(null);
  for (const [name, content] of Object.entries(entries || { "index.html": `<title>${version}</title>`, "assets/app.js": `window.rendererVersion = '${version}';` })) {
    files[name] = Buffer.from(content);
  }
  const archive = Buffer.from(zipSync(files));
  const payload = { schemaVersion: 1, version, minAppVersion, tag: `v${version}`,
    archive: { filename: `renderer-${version}.zip`, size: archive.length, sha256: sha256(archive) } };
  if (native) payload.native = native;
  return { archive, manifest: { payload, signature: sign(null, Buffer.from(canonicalPayload(payload)), privateKey).toString("base64") } };
}

async function newUpdater(userDataDir, extra = {}) {
  return createHotUpdater({ appVersion: "1.0.0", bundledVersion: "1.0.0", bundledRoot,
    userDataDir: userDataDir || await mkdtemp(path.join(temporaryRoot, "user-")), publicKeyPath,
    feedUrl, allowLoopbackHttpForTests: true, fetchImpl: fetch, requestTimeoutMs: 5000, ...extra });
}

async function rejectCode(action, code) {
  await assert.rejects(action, (error) => error.code === code, `Expected ${code}`);
}

async function upgrade(updater, version) {
  served = signedRelease(version);
  assert.equal((await updater.check()).status, "available");
  assert.equal((await updater.download()).status, "ready");
  assert.equal((await updater.apply()).status, "applied");
  await updater.confirmBoot(version);
}

let passed = 0;
async function test(name, action) {
  await action();
  passed += 1;
  console.log(`PASS ${name}`);
}

try {
  await test("signed package builder excludes OCR and binds native installer metadata", async () => {
    const rendererDir = path.join(temporaryRoot, "build-input");
    await mkdir(path.join(rendererDir, "ocr"), { recursive: true });
    await writeFile(path.join(rendererDir, "index.html"), "<title>Signed renderer</title>");
    await writeFile(path.join(rendererDir, "ocr", "model.traineddata"), "Not part of a renderer update");
    const nativePath = path.join(temporaryRoot, "Wireframe-Studio-Setup-1.0.1.exe");
    await writeFile(nativePath, "Fixture installer bytes");
    const result = await makeHotUpdate({ rendererDir, outputDir: path.join(temporaryRoot, "release"),
      privateKeyPath, version: "1.0.1", minAppVersion: "1.0.0", tag: "v1.0.1", nativePath, nativeVersion: "1.0.1" });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const payload = verifyManifest(manifest, createPublicKey(privateKey));
    assert.equal(payload.native.sha256, sha256(await readFile(nativePath)));
    const archive = await readFile(result.archivePath);
    assert.equal(payload.archive.sha256, sha256(archive));
    assert.deepEqual(Object.keys(unpackRendererArchive(archive)), ["index.html"]);
    assert.equal(result.files, 1);
    const repeated = await makeHotUpdate({ rendererDir, outputDir: path.join(temporaryRoot, "release-repeat"),
      privateKeyPath, version: "1.0.1", minAppVersion: "1.0.0", nativePath, nativeVersion: "1.0.1" });
    assert.deepEqual(await readFile(repeated.archivePath), archive);
  });

  await test("successful upgrade, progress, durable confirmation, and untouched user projects", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "success-"));
    const project = path.join(userDataDir, "projects", "untouched.json");
    await mkdir(path.dirname(project));
    await writeFile(project, "user-owned project");
    const statuses = [];
    const updater = await newUpdater(userDataDir, { onState: (state) => statuses.push(state.status) });
    served = signedRelease("1.0.1", { native: { version: "1.0.1", filename: "Wireframe-Studio-Setup-1.0.1.exe", size: 123, sha256: "a".repeat(64) } });
    assert.equal((await updater.check()).status, "available");
    assert.equal(updater.getState().native.filename, "Wireframe-Studio-Setup-1.0.1.exe");
    assert.equal(new URL(updater.getState().native.url).origin, new URL(feedUrl).origin);
    assert.equal((await updater.download()).progress.percent, 100);
    assert.equal(updater.getActiveRoot(), bundledRoot);
    assert.equal((await updater.apply()).pending, true);
    assert.notEqual(updater.getActiveRoot(), bundledRoot);
    await rejectCode(() => updater.confirmBoot("0.9.0"), "BOOT_VERSION_MISMATCH");
    await updater.confirmBoot("1.0.1");
    const restarted = await newUpdater(userDataDir);
    assert.equal(restarted.getState().currentVersion, "1.0.1");
    assert.equal(restarted.getState().pending, false);
    assert.match(await readFile(path.join(restarted.getActiveRoot(), "index.html"), "utf8"), /1\.0\.1/);
    assert.equal(await readFile(project, "utf8"), "user-owned project");
    for (const status of ["idle", "checking", "available", "downloading", "ready", "applied"]) assert.ok(statuses.includes(status));
    assert.equal((await readdir(path.join(userDataDir, "updates"))).filter((name) => name.endsWith(".tmp")).length, 0);
  });

  await test("reject modified manifest and invalid signature before archive requests", async () => {
    const updater = await newUpdater();
    served = signedRelease("1.0.1");
    served.manifest.payload.archive.sha256 = "b".repeat(64);
    let before = requests.length;
    await rejectCode(() => updater.check(), "SIGNATURE_INVALID");
    assert.equal(requests.length - before, 1);
    assert.equal(updater.getActiveRoot(), bundledRoot);
    served = signedRelease("1.0.1");
    served.manifest.signature = Buffer.alloc(64).toString("base64");
    before = requests.length;
    await rejectCode(() => updater.check(), "SIGNATURE_INVALID");
    assert.equal(requests.length - before, 1);
    assert.equal(updater.getState().status, "error");
  });

  await test("reject archive hash tampering before extraction or pointer changes", async () => {
    const updater = await newUpdater();
    served = signedRelease("1.0.1");
    await updater.check();
    served.archive[served.archive.length - 1] ^= 1;
    await rejectCode(() => updater.download(), "HASH_MISMATCH");
    assert.equal(updater.getActiveRoot(), bundledRoot);
    await rejectCode(() => updater.apply(), "NOT_READY");
  });

  await test("reject signed traversal, absolute, Windows alternate-stream, and case-collision paths", async () => {
    for (const malicious of ["../escape.txt", "/absolute.txt", "C:/escape.txt", "folder\\escape.txt", "file.txt:stream", "CON.txt", "folder/../escape.txt", "folder./escape.txt"]) {
      const updater = await newUpdater();
      served = signedRelease("1.0.1", { entries: { "index.html": "ok", [malicious]: "bad" } });
      await updater.check();
      await rejectCode(() => updater.download(), "ARCHIVE_PATH");
      assert.equal(updater.getActiveRoot(), bundledRoot);
    }
    const updater = await newUpdater();
    served = signedRelease("1.0.1", { entries: { "index.html": "ok", "assets/app.js": "one", "assets/APP.js": "two" } });
    await updater.check();
    await rejectCode(() => updater.download(), "ARCHIVE_PATH");
    assert.ok(!(await readdir(temporaryRoot)).includes("escape.txt"));
  });

  await test("reject signed archive content outside the renderer contract", async () => {
    for (const entries of [{ "app.js": "no root HTML" }, { "index.html": "ok", "ocr/model.dat": "not updateable" }, { "index.html": "ok", ".release-secrets/private.pem": "never package secrets" }]) {
      const updater = await newUpdater();
      served = signedRelease("1.0.1", { entries });
      await updater.check();
      await rejectCode(() => updater.download(), "ARCHIVE_CONTENT");
    }
  });

  await test("minimum app version blocks hot replacement but exposes signed native metadata", async () => {
    const updater = await newUpdater();
    served = signedRelease("2.0.0", { minAppVersion: "2.0.0", native: { version: "2.0.0", filename: "Wireframe-2.0.0.exe", size: 20, sha256: "a".repeat(64) } });
    assert.equal((await updater.check()).status, "incompatible");
    assert.equal(updater.getState().native.version, "2.0.0");
    await rejectCode(() => updater.download(), "NO_UPDATE");
  });

  await test("semantic version boundary rejects replay and downgrade", async () => {
    const updater = await newUpdater();
    await upgrade(updater, "1.0.10");
    served = signedRelease("1.0.2");
    await rejectCode(() => updater.check(), "ROLLBACK_VERSION");
    assert.equal(updater.getState().currentVersion, "1.0.10");
    served = signedRelease("1.0.10");
    assert.equal((await updater.check()).status, "idle");
    assert.equal(updater.getState().availableVersion, null);
  });

  await test("unconfirmed restart rolls back atomically and prevents retrying the failed version", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "power-loss-"));
    const updater = await newUpdater(userDataDir);
    await upgrade(updater, "1.0.1");
    served = signedRelease("1.0.2");
    await updater.check();
    await updater.download();
    await updater.apply();
    const beforeRestart = JSON.parse(await readFile(path.join(userDataDir, "updates", "active.json"), "utf8"));
    assert.equal(beforeRestart.current, "1.0.2");
    assert.equal(beforeRestart.previous, "1.0.1");
    assert.equal(beforeRestart.pending, true);
    const restarted = await newUpdater(userDataDir);
    assert.equal(restarted.getState().currentVersion, "1.0.1");
    assert.equal(restarted.getState().error.code, "ROLLED_BACK");
    assert.match(restarted.getState().rollbackReason, /did not confirm/);
    const recovered = JSON.parse(await readFile(path.join(userDataDir, "updates", "active.json"), "utf8"));
    assert.equal(recovered.pending, false);
    assert.equal(recovered.highWaterVersion, "1.0.2");
    await rejectCode(() => restarted.check(), "ROLLBACK_VERSION");
    await upgrade(restarted, "1.0.3");
    assert.equal(restarted.getState().currentVersion, "1.0.3");
  });

  await test("first-update crash returns to bundled resources, and pre-apply restart preserves the bundle", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "first-crash-"));
    let updater = await newUpdater(userDataDir);
    served = signedRelease("1.0.1");
    await updater.check();
    await updater.download();
    updater = await newUpdater(userDataDir);
    assert.equal(updater.getActiveRoot(), bundledRoot);
    await updater.check();
    await updater.download();
    await updater.apply();
    updater = await newUpdater(userDataDir);
    assert.equal(updater.getActiveRoot(), bundledRoot);
    assert.equal(updater.getState().currentVersion, "1.0.0");
    assert.equal(updater.getState().pending, false);
  });

  await test("manual health-check rollback preserves the previous confirmed renderer", async () => {
    const updater = await newUpdater();
    await upgrade(updater, "1.0.1");
    served = signedRelease("1.0.2");
    await updater.check();
    await updater.download();
    await updater.apply();
    const state = await updater.rollback("Renderer did not finish loading.");
    assert.equal(state.currentVersion, "1.0.1");
    assert.equal(state.rollbackReason, "Renderer did not finish loading.");
  });

  await test("stored file tampering is detected on boot and restores the verified previous renderer", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "disk-tamper-"));
    const updater = await newUpdater(userDataDir);
    await upgrade(updater, "1.0.1");
    await upgrade(updater, "1.0.2");
    await writeFile(path.join(updater.getActiveRoot(), "index.html"), "tampered local code");
    const restarted = await newUpdater(userDataDir);
    assert.equal(restarted.getState().currentVersion, "1.0.1");
    assert.match(restarted.getState().rollbackReason, /modified/);
  });

  await test("corrupt pointer is quarantined without trusting paths or deleting projects", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "corrupt-pointer-"));
    await newUpdater(userDataDir);
    await writeFile(path.join(userDataDir, "updates", "active.json"), "{incomplete");
    const restarted = await newUpdater(userDataDir);
    assert.equal(restarted.getActiveRoot(), bundledRoot);
    assert.equal(restarted.getState().error.code, "STORAGE_CORRUPT");
    assert.ok((await readdir(path.join(userDataDir, "updates"))).some((name) => name.startsWith("active.corrupt.")));
  });

  await test("download limits reject oversized responses and decompressed files", async () => {
    const updater = await newUpdater();
    served = signedRelease("1.0.1");
    await updater.check();
    served.archive = Buffer.concat([served.archive, Buffer.alloc(10)]);
    served.chunked = true;
    await rejectCode(() => updater.download(), "SIZE_LIMIT");
    const limited = await newUpdater(undefined, { limits: { ...UPDATE_LIMITS, fileBytes: 10 } });
    served = signedRelease("1.0.1");
    await limited.check();
    await rejectCode(() => limited.download(), "SIZE_LIMIT");
  });

  await test("production feed is pinned and loopback tests cannot redirect remotely", async () => {
    await rejectCode(() => newUpdater(undefined, { allowLoopbackHttpForTests: false }), "FEED_NOT_ALLOWED");
    await rejectCode(() => newUpdater(undefined, { feedUrl: "http://example.com/renderer-update.json" }), "FEED_NOT_ALLOWED");
    await rejectCode(() => newUpdater(undefined, { feedUrl: "https://example.com/renderer-update.json" }), "FEED_NOT_ALLOWED");
    assert.equal(new URL(UPDATE_FEED_URL).protocol, "https:");
    const updater = await newUpdater();
    served = { ...signedRelease("1.0.1"), redirect: "http://example.com/renderer-update.json" };
    await rejectCode(() => updater.check(), "REDIRECT_POLICY");
    served = signedRelease("1.0.1");
    served.manifest.payload.url = "https://example.com/evil.zip";
    await rejectCode(() => updater.check(), "MANIFEST_SCHEMA");
  });

  await test("validated GitHub redirects preserve the signed feed contract", async () => {
    const release = signedRelease("1.0.1");
    const fetched = [];
    const updater = await newUpdater(undefined, { feedUrl: UPDATE_FEED_URL, allowLoopbackHttpForTests: false,
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, "manual");
        fetched.push(url);
        if (fetched.length === 1) return new Response(null, { status: 302,
          headers: { location: "/baobao2333/wireframe-studio/releases/download/v1.0.1/renderer-update.json" } });
        if (fetched.length === 2) return new Response(null, { status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=fixture" } });
        return new Response(JSON.stringify(release.manifest));
      },
    });
    assert.equal((await updater.check()).status, "available");
    assert.equal(fetched.length, 3);
    assert.equal(new URL(fetched[2]).hostname, "release-assets.githubusercontent.com");
  });

  await test("canonical signatures are independent of JSON object insertion order", async () => {
    const release = signedRelease("1.0.1");
    const payload = release.manifest.payload;
    release.manifest.payload = { archive: { sha256: payload.archive.sha256, size: payload.archive.size, filename: payload.archive.filename },
      tag: payload.tag, minAppVersion: payload.minAppVersion, version: payload.version, schemaVersion: 1 };
    assert.equal(verifyManifest(release.manifest, publicKey).version, "1.0.1");
  });

  await test("inconsistent ZIP entry sizes are rejected before writing renderer files", async () => {
    const updater = await newUpdater();
    served = signedRelease("1.0.1");
    served.archive = Buffer.from(zipSync({ "index.html": Buffer.from("<title>Stored data</title>") }, { level: 0 }));
    const centralHeader = served.archive.indexOf(Buffer.from("504b0102", "hex"));
    assert.ok(centralHeader >= 0);
    served.archive.writeUInt32LE(1, centralHeader + 24);
    served.manifest.payload.archive.size = served.archive.length;
    served.manifest.payload.archive.sha256 = sha256(served.archive);
    served.manifest.signature = sign(null, Buffer.from(canonicalPayload(served.manifest.payload)), privateKey).toString("base64");
    await updater.check();
    await rejectCode(() => updater.download(), "ARCHIVE_INVALID");
    assert.equal(updater.getActiveRoot(), bundledRoot);
  });

  await test("linked update directories cannot create or remove files outside update storage", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "linked-storage-"));
    const outside = await mkdtemp(path.join(temporaryRoot, "outside-storage-"));
    await writeFile(path.join(outside, "untouched.txt"), "untouched");
    await symlink(outside, path.join(userDataDir, "updates"), process.platform === "win32" ? "junction" : "dir");
    await rejectCode(() => newUpdater(userDataDir), "STORAGE_PATH");
    assert.deepEqual(await readdir(outside), ["untouched.txt"]);
  });

  await test("a newer bundled renderer takes precedence over an older hot renderer", async () => {
    const userDataDir = await mkdtemp(path.join(temporaryRoot, "native-upgrade-"));
    const updater = await newUpdater(userDataDir);
    await upgrade(updater, "1.0.1");
    const restarted = await newUpdater(userDataDir, { appVersion: "1.0.2", bundledVersion: "1.0.2" });
    assert.equal(restarted.getActiveRoot(), bundledRoot);
    assert.equal(restarted.getState().currentVersion, "1.0.2");
  });

  console.log(`Hot update checks passed: ${passed}; platform=${process.platform}; node=${process.version}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("wireframe-hot-update-test-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
