import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const filename = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const prefix = "wireframe-electron-fetch-";
const { values } = parseArgs({ options: { live: { type: "boolean" }, "expect-version": { type: "string" } } });

async function localChecks(electronFetch) {
  let targetRequests = 0, releaseStream, releaseStall, cancelClosed;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/redirect") { response.writeHead(302, { location: "/target" }); response.end(); }
    else if (request.url === "/target") { targetRequests++; response.end("target"); }
    else if (request.url === "/stream") { response.writeHead(200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }); response.write("a".repeat(16384)); releaseStream = () => response.end("last"); }
    else if (request.url === "/stall") { releaseStall(); }
    else if (request.url === "/cancel") { response.on("close", () => cancelClosed()); response.writeHead(200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }); response.write("a".repeat(16384)); }
    else if (request.url === "/broken") { response.writeHead(200, { "content-length": "100" }); response.write("short"); setTimeout(() => response.destroy(), 20); }
    else if (request.url === "/empty") { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = () => ({ redirect: "manual", signal: AbortSignal.timeout(5000) });
  try {
    const redirect = await electronFetch(`${base}/redirect`, options());
    assert.equal(redirect.status, 302);
    assert.equal(redirect.url, `${base}/redirect`);
    assert.equal(redirect.headers.get("location"), `${base}/target`);
    assert.equal(targetRequests, 0);
    assert.equal(await (await electronFetch(redirect.headers.get("location"), options())).text(), "target");
    assert.equal(targetRequests, 1);
    console.log("PASS real manual redirect returns status/location without following");

    const streamed = await electronFetch(`${base}/stream`, options());
    const reader = streamed.body.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^a+$/);
    releaseStream();
    while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    assert.equal(text, "a".repeat(16384) + "last");
    await reader.closed;
    console.log("PASS response is readable before the HTTP body finishes");

    const before = new AbortController();
    before.abort(new Error("abort before request"));
    await assert.rejects(electronFetch(`${base}/target`, { signal: before.signal }), /abort before request/);
    const stalled = new AbortController();
    const requested = new Promise(resolve => { releaseStall = resolve; });
    const pending = electronFetch(`${base}/stall`, { signal: stalled.signal });
    const rejected = assert.rejects(pending, /abort before headers/);
    await requested;
    stalled.abort(new Error("abort before headers"));
    await rejected;

    const streaming = new AbortController();
    let closed = new Promise(resolve => { cancelClosed = resolve; });
    const inProgress = await electronFetch(`${base}/cancel`, { signal: streaming.signal });
    const reading = inProgress.body.getReader();
    let received = 0;
    while (received < 16384) received += (await reading.read()).value.length;
    const interrupted = assert.rejects(reading.read(), /abort during body/);
    const closedError = assert.rejects(reading.closed, /abort during body/);
    streaming.abort(new Error("abort during body"));
    await interrupted;
    await closedError;
    await closed;

    closed = new Promise(resolve => { cancelClosed = resolve; });
    const cancelled = await electronFetch(`${base}/cancel`, options());
    await cancelled.body.cancel();
    await closed;
    await assert.rejects(electronFetch(`${base}/broken`, options()).then(response => response.text()));
    const empty = await electronFetch(`${base}/empty`, options());
    assert.equal(empty.status, 204);
    assert.equal(empty.body, null);
    console.log("PASS preflight/header/body abort, stream cancel, truncated body, and bodyless response");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function liveCheck(electronFetch, dataPath) {
  const { createHotUpdater, verifyManifest } = await import("../desktop/hot-update.mjs");
  const release = JSON.parse(await readFile(path.join(root, "desktop/release.json"), "utf8"));
  const bundledRoot = path.join(dataPath, "fixture-bundle");
  await mkdir(bundledRoot);
  await writeFile(path.join(bundledRoot, "index.html"), "<title>Isolated update transport fixture</title>");
  const publicKeyPath = path.join(root, "desktop/update-public-key.pem");
  const requests = [];
  const updater = await createHotUpdater({
    appVersion: release.appVersion, bundledVersion: "1.0.1", bundledRoot,
    userDataDir: dataPath, publicKeyPath,
    fetchImpl: async (url, init) => {
      const response = await electronFetch(url, init);
      const parsed = new URL(url);
      requests.push({ url: parsed.origin + parsed.pathname, status: response.status,
        redirectHost: response.headers.has("location") ? new URL(response.headers.get("location")).hostname : null });
      return response;
    },
  });
  const checked = await updater.check();
  assert.equal(checked.status, "available", checked.error?.message);
  if (values["expect-version"]) assert.equal(checked.availableVersion, values["expect-version"]);
  const downloaded = await updater.download();
  assert.equal(downloaded.status, "ready", downloaded.error?.message);
  assert.equal(updater.getActiveRoot(), bundledRoot);
  const versionRoot = path.join(dataPath, "updates", "versions", checked.availableVersion);
  const manifest = JSON.parse(await readFile(path.join(versionRoot, "manifest.json"), "utf8"));
  const payload = verifyManifest(manifest, createPublicKey(await readFile(publicKeyPath)));
  const archive = await readFile(path.join(versionRoot, "renderer.zip"));
  const sha256 = createHash("sha256").update(archive).digest("hex");
  assert.equal(sha256, payload.archive.sha256);
  assert.equal(archive.length, payload.archive.size);
  assert.ok(requests.some(item => item.status === 302));
  console.log(JSON.stringify({ live: true, status: downloaded.status, version: payload.version,
    tag: payload.tag, archiveBytes: archive.length, sha256, signatureVerified: true, hashVerified: true, applied: false, requests }));
}

async function runElectron({ app }) {
  const dataPath = process.env.WIREFRAME_ELECTRON_FETCH_TEST_DATA;
  assert.ok(dataPath, "Run with node scripts/test-electron-fetch.mjs");
  assert.equal(path.dirname(dataPath), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataPath).startsWith(prefix));
  app.setName("Wireframe Electron Fetch Check");
  app.setPath("userData", dataPath);
  await app.whenReady();
  const { electronFetch } = await import("../desktop/electron-fetch.mjs");
  await localChecks(electronFetch);
  if (values.live) await liveCheck(electronFetch, dataPath);
  console.log(`Electron fetch checks passed; Electron ${process.versions.electron}; no windows created`);
}

async function launch() {
  const electron = (await import("electron")).default;
  await access(electron);
  const dataPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const env = { ...process.env, WIREFRAME_ELECTRON_FETCH_TEST_DATA: dataPath };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [filename, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error("Electron fetch checks exceeded 180 seconds")); }, 180000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Electron fetch check failed (${signal || code})`)); });
    });
  } finally {
    assert.equal(path.dirname(dataPath), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataPath).startsWith(prefix));
    await rm(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.versions.electron) {
  const electron = await import("electron");
  runElectron(electron).then(() => electron.app.exit(0), error => { console.error(error); electron.app.exit(1); });
} else {
  launch().catch(error => { console.error(error); process.exitCode = 1; });
}
