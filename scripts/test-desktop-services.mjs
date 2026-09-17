import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { atomicJson, createStorage } from "../desktop/storage.mjs";
import { createVisionService } from "../desktop/vision-service.mjs";
import { createVisionProgress, VISION_TIMEOUT_MS } from "../desktop/vision-progress.mjs";
import { isolatedVisionMcpOptions, visionFeatureOptions } from "../desktop/vision-config.mjs";
import { createOperationLog } from "../desktop/operation-log.mjs";
import { operationLogRecordSchema } from "../control/operation-log-schema.mjs";
import { createOperationRecorder } from "../lib/operation-log.ts";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wireframe-services-test-"));
const services = [];
const operationLogs = [];
const input = { image: `data:image/png;base64,${Buffer.from("image fixture").toString("base64")}`, width: 390, name: "fixture.png" };
const eventLine = event => Buffer.from(JSON.stringify(event) + "\n");
const resultFixture = () => {
  const node = { id: "frame", parentId: null, type: "frame", name: "Panel", x: 0, y: 0, w: 390, h: 800,
    text: "", fontSize: 16, fontWeight: "400", align: "left", lineHeight: 1.5, color: "#202020", fill: "#ffffff",
    stroke: "#cccccc", radius: 0, priority: "primary", note: "", confidence: 95, runs: [], items: [], rows: [], value: 0, icon: "home" };
  return { title: "Fixture", width: 390, height: 800, background: "#ffffff", summary: "Fixture output", nodes: [node,
    { ...node, id: "text", parentId: "frame", type: "text", name: "Title", x: 20, y: 20, w: 200, h: 40, text: "Fixture title" }] };
};
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
    findCodexImpl: async () => "fixture-codex.exe", mcpIsolationImpl:async()=>["-c","mcp_servers={}"], ...options });
  services.push(service);
  return { service, runtimeDir };
}

try {
  await test("renderer log queues are bounded and failures stay visible without blocking project close", async () => {
    let release, writes = 0, warnings = 0;
    const wait = new Promise(resolve => { release = resolve; });
    const recorder = createOperationRecorder(async () => { writes++; await wait; throw Error("fixture failure"); }, () => { warnings++; });
    for (let index = 0; index < 300; index++) recorder.record({ event: "selection", source: "editor" });
    await Promise.resolve();
    assert.equal(writes, 256);
    assert.equal(warnings, 1, "A bounded queue overflow must be visible");
    release();
    await recorder.flush();
    assert.equal(warnings, 1, "Repeated failures must not flood notifications");
    let failedWarning = false;
    const failed = createOperationRecorder(async () => { throw Error("fixture write failed"); }, () => { failedWarning = true; });
    failed.record({ event: "project.save", source: "editor", code: "OK" });
    await failed.flush();
    assert.equal(failedWarning, true);
  });
  await test("operation logs serialize geometry events and close with a durable ordered session", async () => {
    const directory = await fixtureDirectory();
    const runtime = { appVersion: "1.1.2", rendererVersion: "1.1.2-test.1+fixture" };
    const log = createOperationLog({ directory, runtime });
    runtime.appVersion = "9.9.9";
    operationLogs.push(log);
    const event = {
      event: "component.resize.end", source: "editor", operationId: "resize-1", componentId: "i123",
      parentId: "frame-1", kind: "image", before: { x: 20, y: 30, width: 90, height: 100 },
      after: { x: null, y: null, width: 120, height: 130 },
      viewport: { zoom: 43, scrollX: 0, scrollY: 50, pointerX: 140, pointerY: 180, devicePixelRatio: 1.5 },
      changedProperties: ["width", "height"], code: "MOVED", durationMs: 1200,
    };
    const first = log.append(event);
    event.after.width = 900;
    const remaining = Array.from({ length: 40 }, (_, count) => log.append({ event: "component.update", source: "editor", count }));
    await Promise.all([first, ...remaining]);
    await log.flush();
    const beforeClose = await log.readRecent(200);
    assert.equal(beforeClose.length, 42);
    assert.equal(beforeClose[1].after.width, 120, "Validation must detach caller-owned event objects");
    assert.equal(beforeClose[1].after.x, null, "Unknown geometry must not silently become zero");
    assert.deepEqual(beforeClose.slice(2).map(record => record.count), Array.from({ length: 40 }, (_, count) => count));
    const closing = log.close();
    assert.equal(log.close(), closing);
    await closing;
    await log.flush();
    await assert.rejects(log.append({ event: "selection", source: "editor" }), { code: "CLOSED" });
    const records = (await readFile(path.join(directory, "operations.jsonl"), "utf8")).trim().split("\n").map(line => operationLogRecordSchema.parse(JSON.parse(line)));
    assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 43 }, (_, index) => index + 1));
    assert.equal(records[0].event, "session.start");
    assert.deepEqual(records[0].runtime, { appVersion: "1.1.2", rendererVersion: "1.1.2-test.1+fixture" });
    assert.equal(records.at(-1).event, "session.end");
    assert.ok(records.every(record => record.sessionId === log.status().sessionId));
    assert.deepEqual(log.status(), { sessionId: records[0].sessionId, sequence: 43, closed: true, error: null });
  });

  await test("operation logs reject sensitive fields and unknown values without poisoning valid writes", async () => {
    const directory = await fixtureDirectory();
    assert.throws(() => createOperationLog({ directory, runtime: { appVersion: "PRIVATE_VERSION", rendererVersion: "1.1.2" } }), { code: "INVALID_RUNTIME" });
    const log = createOperationLog({ directory });
    operationLogs.push(log);
    for (const extra of [
      { text: "PRIVATE_TEXT" }, { html: "<p>PRIVATE_HTML</p>" }, { image: "PRIVATE_IMAGE" },
      { filename: "PRIVATE_FILE.png" }, { token: "PRIVATE_TOKEN" }, { code: "PRIVATE_ERROR" },
      { componentId: "PRIVATE_FILE.png" }, { sessionId: "forged" }, { sequence: 1 },
      { before: { x: 1, y: 1, width: 1, height: 1, text: "PRIVATE" } },
      { changedProperties: ["PRIVATE_PROPERTY"] },
    ]) await assert.rejects(log.append({ event: "selection", source: "editor", ...extra }), { code: "INVALID_EVENT" });
    await assert.rejects(log.readRecent(201), RangeError);
    await log.append({ event: "selection", source: "editor", count: 1 });
    await log.close();
    assert.equal(log.status().error, null);
    assert.doesNotMatch(await readFile(path.join(directory, "operations.jsonl"), "utf8"), /PRIVATE|forged|filename|html|token/);
  });

  await test("operation log rotation is bounded and recent records cross rotated files and sessions", async () => {
    const directory = await fixtureDirectory();
    const log = createOperationLog({ directory, maxFileBytes: 1024, maxFiles: 3 });
    operationLogs.push(log);
    await Promise.all(Array.from({ length: 40 }, (_, count) => log.append({ event: "viewport", source: "editor", count, viewport: { zoom: 100, scrollX: count, scrollY: 0 } })));
    await log.close();
    const names = await readdir(directory);
    assert.deepEqual(names.sort(), ["operations.1.jsonl", "operations.2.jsonl", "operations.jsonl"]);
    for (const name of names) assert.ok((await stat(path.join(directory, name))).size <= 1024);
    const retained = await log.readRecent(200);
    assert.ok(retained.length < 42 && retained.length > 3);
    assert.equal(retained.at(-1).event, "session.end");
    assert.deepEqual(retained.map(record => record.sequence), Array.from({ length: retained.length }, (_, index) => retained[0].sequence + index));
    const nextSession = createOperationLog({ directory, maxFileBytes: 1024, maxFiles: 3 });
    operationLogs.push(nextSession);
    await nextSession.flush();
    const latest = await nextSession.readRecent(2);
    assert.equal(latest[0].sessionId, log.status().sessionId);
    assert.equal(latest[1].sessionId, nextSession.status().sessionId);
    assert.equal(latest[1].sequence, 1);
    await nextSession.close();
  });

  await test("operation log file failures remain explicit and never expose native paths", async () => {
    const directory = await fixtureDirectory();
    await mkdir(path.join(directory, "operations.jsonl"));
    const log = createOperationLog({ directory });
    operationLogs.push(log);
    const first = log.append({ event: "project.save", source: "desktop" });
    const second = log.append({ event: "project.failed", source: "desktop", code: "SAVE_FAILED" });
    assert.deepEqual((await Promise.allSettled([first, second])).map(result => result.status), ["rejected", "rejected"]);
    await assert.rejects(log.flush(), { code: "PATH_UNSAFE" });
    await assert.rejects(log.close(), cause => cause.code === "PATH_UNSAFE" && !cause.message.includes(directory));
    assert.equal(log.status().error, "PATH_UNSAFE");
  });

  await test("an interrupted JSONL tail is preserved and cannot silently absorb a new session", async () => {
    const directory = await fixtureDirectory();
    const target = path.join(directory, "operations.jsonl");
    await writeFile(target, '{"event":"component.resize.end"');
    const log = createOperationLog({ directory });
    operationLogs.push(log);
    await assert.rejects(log.flush(), { code: "READ_FAILED" });
    await assert.rejects(log.close(), { code: "READ_FAILED" });
    assert.equal(await readFile(target, "utf8"), '{"event":"component.resize.end"');
    assert.equal(log.status().sequence, 0);
  });

  await test("operation logs reject linked ancestors, hard-linked files and replaced active files", async () => {
    const directory = await fixtureDirectory();
    const target = path.join(directory, "target");
    const linked = path.join(directory, "linked");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const linkedLog = createOperationLog({ directory: path.join(linked, "nested") });
    operationLogs.push(linkedLog);
    await assert.rejects(linkedLog.flush(), { code: "PATH_UNSAFE" });
    await assert.rejects(linkedLog.close(), { code: "PATH_UNSAFE" });
    assert.deepEqual(await readdir(target), [], "A linked ancestor must not be followed even when creating the log directory");
    const privateFile = path.join(directory, "private.txt");
    await writeFile(privateFile, "PRIVATE_SENTINEL");
    await link(privateFile, path.join(target, "operations.jsonl"));
    const hardLinkedLog = createOperationLog({ directory: target });
    operationLogs.push(hardLinkedLog);
    await assert.rejects(hardLinkedLog.flush(), { code: "PATH_UNSAFE" });
    await assert.rejects(hardLinkedLog.close(), { code: "PATH_UNSAFE" });
    assert.equal(await readFile(privateFile, "utf8"), "PRIVATE_SENTINEL");
    const ordinaryDirectory = await fixtureDirectory();
    const ordinaryLog = createOperationLog({ directory: ordinaryDirectory });
    operationLogs.push(ordinaryLog);
    await ordinaryLog.flush();
    await rename(path.join(ordinaryDirectory, "operations.jsonl"), path.join(ordinaryDirectory, "replaced.jsonl"));
    await writeFile(path.join(ordinaryDirectory, "operations.jsonl"), "PRIVATE_REPLACEMENT");
    await assert.rejects(ordinaryLog.append({ event: "selection", source: "editor" }), { code: "PATH_UNSAFE" });
    await assert.rejects(ordinaryLog.close(), { code: "PATH_UNSAFE" });
    assert.equal(await readFile(path.join(ordinaryDirectory, "operations.jsonl"), "utf8"), "PRIVATE_REPLACEMENT");
  });

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
    let child;
    const { service, runtimeDir } = await visionFixture({ spawnImpl: () => (child = fakeProcess()) });
    const { id } = await service.start(input);
    child.stdout.write(eventLine({ type: "turn.started" }));
    service.cancel(id);
    const elapsed = service.get(id).elapsed;
    const progress = service.get(id).progress;
    child.stdout.write(eventLine({ type: "item.completed", item: { id: "late", type: "agent_message", text: "private late output" } }));
    await service.dispose();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(service.get(id).status, "cancelled");
    assert.equal(service.get(id).elapsed, elapsed);
    assert.deepEqual(service.get(id).progress, progress);
    assert.equal(service.get(id).result, null);
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
        writeFile(output, JSON.stringify(resultFixture()))
          .then(() => child.emit("close", 0)).catch((error) => child.emit("error", error));
      });
      else queueMicrotask(() => { child.emit("error", Error("Fixture async spawn failure")); child.emit("close", -1); });
      return child;
    } });
    const first = await service.start(input);
    await waitUntil(() => !service.isBusy());
    assert.equal(service.get(first.id).status, "done");
    assert.equal(service.get(first.id).result.title, "Fixture");
    assert.equal(service.get(first.id).progress.nodeCount, 2);
    assert.equal(service.get(first.id).progress.stage, "complete");
    assert.deepEqual(await readdir(runtimeDir), []);
    const second = await service.start(input);
    await waitUntil(() => !service.isBusy());
    assert.equal(service.get(second.id).status, "failed");
    assert.match(service.get(second.id).error, /无法运行本机 Codex 识别进程/);
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

  await test("JSONL progress handles split UTF8, multiple lines, snapshot updates, and the final tail", async () => {
    let now = 100;
    const progress = createVisionProgress({ now: () => now });
    assert.equal(progress.snapshot().activityAgeMs, null);
    assert.equal(progress.snapshot().timeoutMs, VISION_TIMEOUT_MS);
    progress.push(eventLine({ type: "thread.started", thread_id: "thread-fixture" }));
    now = 120;
    progress.push(eventLine({ type: "turn.started" }));
    assert.equal(progress.snapshot().stage, "recognizing");
    assert.match(progress.message(), /等待模型/);
    progress.push(eventLine({ type: "item.completed", item: { id: "reason", type: "reasoning", text: "PRIVATE_REASONING sk-sensitive-token" } }));
    assert.equal(progress.snapshot().outputChars, 0);
    const text = "中文🙂";
    const lines = Buffer.concat([
      eventLine({ type: "item.started", item: { id: "answer", type: "agent_message", text } }),
      eventLine({ type: "item.updated", item: { id: "answer", type: "agent_message", text: text + " longer" } }),
      eventLine({ type: "item.completed", item: { id: "answer", type: "agent_message", text } }),
      Buffer.from('{"type":"turn.completed"}'),
    ]);
    for (let i = 0; i < lines.length; i++) progress.push(lines.subarray(i, i + 1));
    assert.equal(progress.snapshot().eventCount, 6);
    assert.equal(progress.snapshot().outputChars, (text + " longer").length);
    assert.equal(progress.snapshot().stage, "receiving");
    now = 140;
    progress.end();
    assert.equal(progress.snapshot().eventCount, 7);
    progress.validating();
    now = 150;
    progress.complete(2);
    const snapshot = progress.snapshot();
    assert.equal(snapshot.stage, "complete");
    assert.equal(snapshot.nodeCount, 2);
    assert.equal(snapshot.activityAgeMs, 10);
    assert.equal(snapshot.warning, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|sensitive|中文/);
    now = 5000;
    progress.push(eventLine({ type: "turn.started" }));
    progress.streamError();
    assert.deepEqual(progress.snapshot(), snapshot);
    snapshot.stage = "starting";
    assert.equal(progress.snapshot().stage, "complete");
  });

  await test("late and unknown events never regress stages or fabricate activity", async () => {
    let now = 1;
    const progress = createVisionProgress({ now: () => now });
    progress.push(eventLine({ type: "future.event", text: 'PRIVATE "turn.started"' }));
    assert.equal(progress.snapshot().stage, "starting");
    assert.equal(progress.snapshot().activityAgeMs, null);
    progress.push(eventLine({ type: "item.updated", item: { id: "answer", type: "agent_message", text: "abc" } }));
    now = 5;
    progress.push(eventLine({ type: "turn.started" }));
    assert.equal(progress.snapshot().stage, "receiving");
    const count = progress.snapshot().eventCount;
    now = 15;
    progress.push(eventLine({ type: "future.event", percent: 100, secret: "PRIVATE" }));
    progress.push(eventLine({ type: "item.completed", item: { id: "future", type: "future_item", text: "PRIVATE" } }));
    assert.equal(progress.snapshot().eventCount, count);
    assert.equal(progress.snapshot().activityAgeMs, 10);
    assert.equal(progress.snapshot().outputChars, 3);
    assert.equal("percent" in progress.snapshot(), false);
    progress.validating();
    progress.push(eventLine({ type: "item.completed", item: { id: "reason", type: "reasoning", text: "PRIVATE" } }));
    assert.equal(progress.snapshot().stage, "validating");
    progress.stop();
  });

  await test("large messages are framed without losing UTF8 or retaining message content", async () => {
    const progress = createVisionProgress();
    const text = "界面🙂".repeat(100000);
    const line = eventLine({ type: "item.completed", item: { id: "large", type: "agent_message", text } });
    for (let i = 0; i < line.length; i += 4093) progress.push(line.subarray(i, i + 4093));
    progress.end();
    assert.equal(progress.snapshot().outputChars, text.length);
    assert.equal(progress.snapshot().eventCount, 1);
    assert.equal(progress.snapshot().warning, null);
    assert.ok(JSON.stringify(progress.snapshot()).length < 400);
  });

  await test("invalid, truncated, non-UTF8 and oversized JSONL produce safe explicit warnings", async () => {
    for (const bytes of [Buffer.from('PRIVATE not JSON\n'), Buffer.from('{"type":'), Buffer.from([0xff, 0x0a]), eventLine({ type: "item.updated", item: null })]) {
      const progress = createVisionProgress();
      progress.push(bytes);
      progress.end();
      assert.equal(progress.snapshot().eventCount, 0);
      assert.equal(progress.snapshot().activityAgeMs, null);
      assert.match(progress.snapshot().warning, /格式异常/);
      assert.doesNotMatch(JSON.stringify(progress.snapshot()), /PRIVATE/);
    }
    const lineLimited = createVisionProgress({ maxLineBytes: 128 });
    lineLimited.push(Buffer.from("x".repeat(256) + '\n{"type":"turn.started"}\n'));
    assert.equal(lineLimited.snapshot().eventCount, 1);
    assert.match(lineLimited.snapshot().warning, /单条.*限制/);
    const streamLimited = createVisionProgress({ maxStreamBytes: 128 });
    streamLimited.push(eventLine({ type: "turn.started" }));
    streamLimited.push(Buffer.alloc(129, 0x20));
    streamLimited.push(eventLine({ type: "turn.completed" }));
    assert.equal(streamLimited.snapshot().eventCount, 1);
    assert.match(streamLimited.snapshot().warning, /流超过大小限制/);
    const itemLimited = createVisionProgress({ maxItems: 1 });
    for (const id of ["one", "two"]) itemLimited.push(eventLine({ type: "item.completed", item: { id, type: "agent_message", text: "abc" } }));
    assert.equal(itemLimited.snapshot().outputChars, 3);
    assert.match(itemLimited.snapshot().warning, /条目超过限制/);
  });

  await test("service stages follow real events and validated files, returning independent copies", async () => {
    let child, output;
    const { service, runtimeDir } = await visionFixture({ spawnImpl: (_exe, args) => {
      assert.ok(args.includes("--json"));
      assert.ok(args.includes("--ephemeral"));
      assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
      assert.equal(args.includes("--model"), false);
      output = args[args.indexOf("--output-last-message") + 1];
      return (child = fakeProcess());
    } });
    const { id } = await service.start(input);
    assert.equal(service.get(id).progress.stage, "starting");
    assert.equal(service.get(id).progress.activityAgeMs, null);
    child.stdout.write(Buffer.from('BROKEN PRIVATE EVENT\n'));
    child.stdout.write(eventLine({ type: "turn.started" }));
    assert.match(service.get(id).message, /等待模型/);
    child.stdout.write(eventLine({ type: "item.completed", item: { id: "answer", type: "agent_message", text: '{"nodes":["not-the-result"]}' } }));
    assert.equal(service.get(id).progress.stage, "receiving");
    child.stdout.write(Buffer.from('{"type":"turn.completed"}'));
    await writeFile(output, JSON.stringify(resultFixture()));
    child.emit("close", 0);
    assert.equal(service.get(id).progress.stage, "validating");
    assert.equal(service.get(id).progress.nodeCount, null);
    await waitUntil(() => !service.isBusy());
    const done = service.get(id);
    assert.equal(done.status, "done");
    assert.equal(done.progress.stage, "complete");
    assert.equal(done.progress.nodeCount, 2);
    assert.equal(done.progress.eventCount, 3);
    assert.match(done.progress.warning, /格式异常/);
    assert.doesNotMatch(JSON.stringify(done), /PRIVATE|not-the-result/);
    const frozen = structuredClone(done);
    done.result.nodes[0].name = "changed outside service";
    done.progress.outputChars = 99999;
    await new Promise(resolve => setTimeout(resolve, 15));
    child.stdout.write(eventLine({ type: "turn.started" }));
    assert.deepEqual(service.get(id), frozen);
    assert.deepEqual(await readdir(runtimeDir), []);
  });

  await test("failure freezes progress and never exposes reasoning, raw errors, or credential-like output", async () => {
    let child;
    const { service } = await visionFixture({ spawnImpl: () => (child = fakeProcess()) });
    const { id } = await service.start(input);
    child.stdout.write(eventLine({ type: "turn.started" }));
    child.stdout.write(eventLine({ type: "error", message: "PRIVATE token=credential-value" }));
    child.stderr.write("PRIVATE token=credential-value authorization=Bearer should-not-escape");
    child.emit("close", 1);
    await waitUntil(() => !service.isBusy());
    const failed = service.get(id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /识别进程失败 \(1\)/);
    assert.match(failed.progress.warning, /事件异常/);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|credential|Bearer/);
    await new Promise(resolve => setTimeout(resolve, 15));
    child.stdout.write(eventLine({ type: "item.completed", item: { id: "late", type: "agent_message", text: "PRIVATE" } }));
    assert.deepEqual(service.get(id), failed);
  });

  await test("progress stream failures and malformed result files are visible without leaking source text", async () => {
    let child, output;
    const { service } = await visionFixture({ spawnImpl: (_exe, args) => {
      output = args[args.indexOf("--output-last-message") + 1];
      return (child = fakeProcess());
    } });
    const { id } = await service.start(input);
    child.stdout.emit("error", Error("PRIVATE stream error"));
    await writeFile(output, "PRIVATE invalid result JSON");
    child.emit("close", 0);
    await waitUntil(() => !service.isBusy());
    const failed = service.get(id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.progress.nodeCount, null);
    assert.match(failed.progress.warning, /读取失败/);
    assert.match(failed.error, /不是有效 JSON/);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  });

  await test("vision isolation disables every listed MCP without starting it or changing provider settings", async () => {
    const options = await isolatedVisionMcpOptions("fixture.exe", (_exe, args) => {
      assert.deepEqual(args, [...visionFeatureOptions, "mcp", "list", "--json"]);
      const child = fakeProcess();
      queueMicrotask(() => { child.stdout.write(JSON.stringify([{name:"wireframe-studio"},{name:"node_repl"}])); child.emit("close",0); });
      return child;
    });
    assert.deepEqual(options,["-c","mcp_servers.wireframe-studio.enabled=false","-c","mcp_servers.node_repl.enabled=false"]);
    const {service,runtimeDir}=await visionFixture({mcpIsolationImpl:async()=>{throw Error("Isolation fixture failure");},spawnImpl:()=>{throw Error("Must not spawn vision");}});
    await assert.rejects(service.start(input),/Isolation fixture failure/);
    assert.deepEqual(await readdir(runtimeDir),[]);
    assert.equal(service.isBusy(),false);
  });

  await test("the longer bounded wait ends safely and preserves only sanitized diagnostics", async () => {
    assert.equal(VISION_TIMEOUT_MS,600000);
    let child;
    const diagnosticsDir=await fixtureDirectory();
    const {service,runtimeDir}=await visionFixture({timeoutMs:50,diagnosticsDir,spawnImpl:()=>child=fakeProcess()});
    const {id}=await service.start({...input,name:"PRIVATE_FILENAME.png"});
    child.stdout.write(eventLine({type:"thread.started",thread_id:"11111111-2222-3333-4444-555555555555"}));
    child.stdout.write(eventLine({type:"turn.started"}));
    child.stdout.write(eventLine({type:"error",message:"TLS connection reset PRIVATE_TOKEN"}));
    await waitUntil(()=>!service.isBusy());
    const failed=service.get(id);
    assert.equal(failed.status,"failed");assert.match(failed.error,/10 分钟/);assert.equal(failed.result,null);
    const diagnostic=JSON.parse(await readFile(path.join(diagnosticsDir,`${id}.json`),"utf8"));
    assert.equal(diagnostic.stopReason,"TIMEOUT");assert.equal(diagnostic.errorKind,"NETWORK");
    assert.equal(diagnostic.threadId,"11111111-2222-3333-4444-555555555555");assert.equal(diagnostic.eventCount,3);
    assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE|base64|image fixture/);
    assert.deepEqual(await readdir(runtimeDir),[]);
    child.stdout.write(eventLine({type:"item.completed",item:{id:"late",type:"agent_message",text:"PRIVATE"}}));
    assert.deepEqual(service.get(id),failed);
  });

  await test("known network, account and authentication failures do not become generic login advice",async()=>{
    for(const [message,expected] of [["429 usage limit PRIVATE",/额度/],["401 authentication PRIVATE",/凭据/],["stream disconnected PRIVATE",/连接中断/]]){
      let child;const {service}=await visionFixture({spawnImpl:()=>child=fakeProcess()});
      const {id}=await service.start(input);
      child.stdout.write(eventLine({type:"turn.failed",error:{message}}));child.emit("close",1);
      await waitUntil(()=>!service.isBusy());assert.match(service.get(id).error,expected);assert.doesNotMatch(JSON.stringify(service.get(id)),/PRIVATE/);
    }
  });

  console.log(`Desktop service checks passed: ${passed}; platform=${process.platform}; node=${process.version}`);
} finally {
  await Promise.allSettled(operationLogs.map(log => log.close()));
  await Promise.all(services.map((service) => service.dispose()));
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("wireframe-services-test-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
