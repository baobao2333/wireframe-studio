import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { operationLogEventSchema, operationLogRecordSchema, operationLogRuntimeSchema } from "../control/operation-log-schema.mjs";

const error = code => Object.assign(new Error(`Operation log: ${code}`), { code });
const safeCodes = new Set(["PATH_UNSAFE", "WRITE_FAILED", "READ_FAILED", "CLOSED", "RECORD_TOO_LARGE"]);

async function existingFile(path) {
  const info = await lstat(path).catch(cause => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)) throw error("PATH_UNSAFE");
  return info;
}

async function safeDirectory(directory, create = false) {
  let current = parse(directory).root;
  for (const segment of relative(current, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (create) await mkdir(current).catch(cause => { if (cause.code !== "EEXIST") throw cause; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw error("PATH_UNSAFE");
  }
}

export function createOperationLog({ directory, runtime, maxFileBytes = 2 * 1024 * 1024, maxFiles = 5 }) {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw error("PATH_UNSAFE");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 512 || maxFileBytes > 16 * 1024 * 1024) throw new RangeError("Invalid operation log file limit");
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 2 || maxFiles > 20) throw new RangeError("Invalid operation log retention limit");
  const context = runtime === undefined ? undefined : operationLogRuntimeSchema.safeParse(runtime);
  if (context && !context.success) throw error("INVALID_RUNTIME");
  directory = resolve(directory);
  const sessionId = randomUUID();
  const filename = index => join(directory, index ? `operations.${index}.jsonl` : "operations.jsonl");
  let queue = Promise.resolve();
  let handle = null;
  let size = 0;
  let sequence = 0;
  let closed = false;
  let failure = null;
  let closing = null;

  function remember(cause) {
    failure ||= error(safeCodes.has(cause?.code) ? cause.code : "WRITE_FAILED");
    return failure;
  }

  function enqueue(action) {
    const result = queue.then(async () => {
      if (failure) throw failure;
      try { return await action(); }
      catch (cause) { throw remember(cause); }
    });
    queue = result.catch(() => {});
    return result;
  }

  async function openCurrent() {
    await safeDirectory(directory);
    const before = await existingFile(filename(0));
    handle = await open(filename(0), constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
    const opened = await handle.stat();
    const after = await existingFile(filename(0));
    if (!opened.isFile() || opened.nlink !== 1 || !after || opened.ino !== after.ino || opened.dev !== after.dev ||
        (before && (before.ino !== opened.ino || before.dev !== opened.dev))) throw error("PATH_UNSAFE");
    size = opened.size;
    if (size > maxFileBytes) throw error("READ_FAILED");
    if (size) {
      const tail = Buffer.alloc(1);
      const result = await handle.read(tail, 0, 1, size - 1);
      if (result.bytesRead !== 1 || tail[0] !== 10) throw error("READ_FAILED");
    }
  }

  async function checkCurrent() {
    await safeDirectory(directory);
    const current = await existingFile(filename(0));
    const opened = await handle.stat();
    if (!current || current.ino !== opened.ino || current.dev !== opened.dev || current.size !== size) throw error("PATH_UNSAFE");
  }

  async function rotate() {
    await handle.sync();
    await handle.close();
    handle = null;
    await safeDirectory(directory);
    const files = await Promise.all(Array.from({ length: maxFiles }, (_, index) => existingFile(filename(index))));
    if (files[maxFiles - 1]) await unlink(filename(maxFiles - 1));
    for (let index = maxFiles - 2; index >= 0; index -= 1) {
      if (files[index]) await rename(filename(index), filename(index + 1));
    }
    await openCurrent();
  }

  async function writeEvent(event) {
    const record = { ...event, version: 1, sessionId, sequence: sequence + 1, time: new Date().toISOString() };
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (line.length > maxFileBytes) throw error("RECORD_TOO_LARGE");
    await checkCurrent();
    if (size + line.length > maxFileBytes) await rotate();
    let written = 0;
    while (written < line.length) {
      const result = await handle.write(line, written, line.length - written);
      if (!result.bytesWritten) throw error("WRITE_FAILED");
      written += result.bytesWritten;
    }
    size += written;
    sequence = record.sequence;
    return record;
  }

  async function readRecords(limit) {
    await safeDirectory(directory);
    const records = [];
    for (let index = 0; index < maxFiles && records.length < limit; index += 1) {
      const info = await existingFile(filename(index));
      if (!info) continue;
      if (info.size > maxFileBytes) throw error("READ_FAILED");
      const reader = await open(filename(index), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await reader.stat();
        if (!opened.isFile() || opened.nlink !== 1 || info.ino !== opened.ino || info.dev !== opened.dev || opened.size > maxFileBytes) throw error("PATH_UNSAFE");
        const text = await reader.readFile("utf8");
        if (text && !text.endsWith("\n")) throw error("READ_FAILED");
        const lines = text.trimEnd().split("\n").filter(Boolean).slice(-(limit - records.length));
        let parsed;
        try { parsed = lines.map(line => operationLogRecordSchema.parse(JSON.parse(line))); }
        catch { throw error("READ_FAILED"); }
        records.unshift(...parsed);
      } finally { await reader.close(); }
    }
    return records;
  }

  enqueue(async () => {
    await safeDirectory(directory, true);
    await openCurrent();
    await writeEvent({ event: "session.start", source: "desktop", ...(context ? { runtime: context.data } : {}) });
  });

  return {
    async append(input) {
      if (closed) throw error("CLOSED");
      const parsed = operationLogEventSchema.safeParse(input);
      if (!parsed.success) throw error("INVALID_EVENT");
      return enqueue(() => writeEvent(parsed.data));
    },
    async readRecent(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Invalid operation log read limit");
      if (closed) {
        await closing;
        try { return await readRecords(limit); }
        catch (cause) { throw remember(cause); }
      }
      return enqueue(() => readRecords(limit));
    },
    async flush() {
      if (closed) {
        await closing;
        if (failure) throw failure;
        return;
      }
      return enqueue(() => handle.sync());
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = queue.then(async () => {
        try {
          if (failure) throw failure;
          await writeEvent({ event: "session.end", source: "desktop" });
          await handle.sync();
        } catch (cause) {
          throw remember(cause);
        } finally {
          if (handle) {
            try { await handle.close(); }
            catch (cause) { throw remember(cause); }
            finally { handle = null; }
          }
        }
      });
      return closing;
    },
    status() { return { sessionId, sequence, closed, error: failure?.code || null }; },
  };
}
