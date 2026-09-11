import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { atomicJson, createStorage } from "../desktop/storage.mjs";
import { createVisionService } from "../desktop/vision-service.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wireframe-services-test-"));
const services = [];
const input = { image: `data:image/png;base64,${Buffer.from("image fixture").toString("base64")}`, width: 390, name: "fixture.png" };
let passed = 0;
async function test(name, action) {
  await action();
  passed += 1;
  console.log(`PASS ${name}`);
}
async function fixtureDirectory() {
  return mkdtemp(path.join(temporaryRoot, "case-"));
}
async function waitUntil(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Service did not settle within 3 seconds");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  return child;
}
async function visionFixture(options = {}) {
  const runtimeDir = await fixtureDirectory();
  const service = createVisionService({ runtimeDir, instructionsPath: path.join(temporaryRoot, "instructions.txt"),
    findCodexImpl: async () => "fixture-codex.exe", ...options });
  services.push(service);
  return { service, runtimeDir };
}

try {
  await test("failed storage batches settle every waiter and retain unsaved values for retry", async () => {
    const directory = await fixtureDirectory();
    const blocked = path.join(directory, "autosave.json");
    await mkdir(blocked);
    const storage = createStorage(directory);
    const first = storage.set("wireframe-studio-v2", { revision: 1 });
    const latest = storage.set("wireframe-studio-v2", { revision: 2 });
    const library = storage.set("wireframe-library-v2", ["preserved component"]);
    const settled = Promise.allSettled([first, latest, library]);
    await assert.rejects(storage.flush(), AggregateError);
    assert.deepEqual((await settled).map((item) => item.status), ["rejected", "rejected", "fulfilled"]);
    await assert.rejects(storage.flush(), AggregateError, "An empty flush must not hide the unsaved project");
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
    await rm(blocked, { recursive: true });
    await storage.flush();
    assert.deepEqual(await storage.get("wireframe-studio-v2"), { revision: 2 });
    assert.deepEqual(await storage.get("wireframe-library-v2"), ["preserved component"]);
  });

  await test("flush drains edits queued by save acknowledgements before reporting close-ready", async () => {
    const directory = await fixtureDirectory();
    const storage = createStorage(directory);
    const first = storage.set("wireframe-studio-v2", { revision: 1 });
    const following = first.then(() => storage.set("wireframe-library-v2", ["saved during close"]));
    await storage.flush();
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "library.json"), "utf8")), ["saved during close"]);
    await following;
  });

  await test("get observes pending writes and backup never claims a nonexistent file", async () => {
    const directory = await fixtureDirectory();
    const storage = createStorage(directory);
    assert.equal(await storage.backup(), null);
    const saving = storage.set("wireframe-studio-v2", { revision: 3 });
    assert.deepEqual(await storage.get("wireframe-studio-v2"), { revision: 3 });
    await saving;
    const backup = await storage.backup();
    assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), { revision: 3 });
    await atomicJson(path.join(directory, "manual.wireframe"), { revision: 4 });
    await atomicJson(path.join(directory, "manual.wireframe"), { revision: 5 });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "manual.wireframe"), "utf8")), { revision: 5 });
  });

  await test("disposing during executable lookup cannot start an orphan recognition process", async () => {
    let completeLookup;
    let spawns = 0;
    const lookup = new Promise((resolve) => { completeLookup = resolve; });
    const { service, runtimeDir } = await visionFixture({ findCodexImpl: () => lookup,
      spawnImpl: () => { spawns += 1; return fakeProcess(); } });
    const launch = service.start(input);
    const rejected = assert.rejects(launch, /已停止/);
    const disposed = service.dispose();
    completeLookup("fixture-codex.exe");
    await rejected;
    await disposed;
    assert.equal(spawns, 0);
    assert.equal(service.isBusy(), false);
    assert.deepEqual(await readdir(runtimeDir), []);
    await assert.rejects(service.start(input), /已停止/);
  });

  await test("synchronous launch failures remove private input files and release the busy state", async () => {
    const { service, runtimeDir } = await visionFixture({ spawnImpl: () => { throw Error("Fixture spawn failure"); } });
    await assert.rejects(service.start(input), /Fixture spawn failure/);
    assert.equal(service.isBusy(), false);
    assert.deepEqual(await readdir(runtimeDir), []);
  });

  await test("cancelled recognition stops elapsed time and dispose waits for child cleanup", async () => {
    const { service, runtimeDir } = await visionFixture({ spawnImpl: () => fakeProcess() });
    const { id } = await service.start(input);
    service.cancel(id);
    const elapsed = service.get(id).elapsed;
    await service.dispose();
    assert.equal(service.get(id).status, "cancelled");
    assert.equal(service.get(id).elapsed, elapsed);
    assert.equal(service.isBusy(), false);
    assert.deepEqual(await readdir(runtimeDir), []);
  });

  await test("successful output and asynchronous spawn errors each finalize exactly once", async () => {
    let launches = 0;
    const { service, runtimeDir } = await visionFixture({ spawnImpl: (_exe, args) => {
      const child = fakeProcess();
      launches += 1;
      if (launches === 1) child.stdin.once("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1];
        writeFile(output, JSON.stringify({ title: "Fixture", width: 390, height: 800, summary: "Fixture output", nodes: [{ id: "one" }] }))
          .then(() => child.emit("close", 0)).catch((error) => child.emit("error", error));
      });
      else queueMicrotask(() => { child.emit("error", Error("Fixture async spawn failure")); child.emit("close", -1); });
      return child;
    } });
    const first = await service.start(input);
    await waitUntil(() => !service.isBusy());
    assert.equal(service.get(first.id).status, "done");
    assert.equal(service.get(first.id).result.title, "Fixture");
    assert.deepEqual(await readdir(runtimeDir), []);
    const second = await service.start(input);
    await waitUntil(() => !service.isBusy());
    assert.equal(service.get(second.id).status, "failed");
    assert.match(service.get(second.id).error, /Fixture async spawn failure/);
    assert.deepEqual(await readdir(runtimeDir), []);
  });

  await test("invalid base64 and images larger than the stated decoded limit never start Codex", async () => {
    let lookups = 0;
    const { service } = await visionFixture({ findCodexImpl: async () => { lookups += 1; return "fixture.exe"; }, spawnImpl: () => fakeProcess() });
    await assert.rejects(service.start({ ...input, image: "data:image/png;base64,====" }), /图片数据无效/);
    const oversized = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")}`;
    await assert.rejects(service.start({ ...input, image: oversized }), /图片数据无效/);
    assert.equal(lookups, 0);
  });

  await test("Codex availability follows login-status exit code without exposing credential output", async () => {
    let loginCode = 1;
    const { service } = await visionFixture({ spawnImpl: (_exe, args, options) => {
      assert.deepEqual(args, ["login", "status"]);
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio, "ignore");
      const child = fakeProcess();
      queueMicrotask(() => child.emit("close", loginCode));
      return child;
    } });
    const unavailable = await service.status();
    assert.equal(unavailable.available, false);
    assert.match(unavailable.error, /尚未登录或配置不可用/);
    assert.equal(unavailable.busy, false);
    loginCode = 0;
    assert.deepEqual(await service.status(), { available: true, busy: false });
  });

  console.log(`Desktop service checks passed: ${passed}; platform=${process.platform}; node=${process.version}`);
} finally {
  await Promise.all(services.map((service) => service.dispose()));
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("wireframe-services-test-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
