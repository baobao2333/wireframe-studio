import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import semver from "semver";

export const UPDATE_FEED_URL = "https://github.com/baobao2333/wireframe-studio/releases/latest/download/renderer-update.json";
export const UPDATE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  archiveBytes: 64 * 1024 * 1024,
  extractedBytes: 256 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  entries: 10000,
  nativeBytes: 1024 * 1024 * 1024,
});
const REPO_PATH = "/baobao2333/wireframe-studio/releases/";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireValue(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validVersion(value) {
  return typeof value === "string" && value.length <= 96 && semver.valid(value) === value;
}

function validFilename(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,179}$/.test(value)
    && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The signed bytes are UTF-8 JSON with recursively sorted keys and no whitespace.
export function canonicalPayload(payload) {
  const sorted = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sorted);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  };
  return JSON.stringify(sorted(payload));
}

export function validateManifestPayload(payload, limits = UPDATE_LIMITS) {
  requireValue(exactKeys(payload, ["schemaVersion", "version", "minAppVersion", "tag", "archive"], ["native"]), "MANIFEST_SCHEMA", "Invalid manifest payload fields.");
  requireValue(payload.schemaVersion === 1 && validVersion(payload.version) && validVersion(payload.minAppVersion), "MANIFEST_SCHEMA", "Manifest versions must be canonical semantic versions.");
  requireValue(payload.tag === `v${payload.version}`, "MANIFEST_SCHEMA", "Release tag must match the renderer version.");
  const validateAsset = (asset, native) => {
    requireValue(exactKeys(asset, native ? ["version", "filename", "size", "sha256"] : ["filename", "size", "sha256"]), "MANIFEST_SCHEMA", "Invalid asset fields.");
    requireValue(validFilename(asset.filename) && (native ? /\.exe$/i.test(asset.filename) : asset.filename === `renderer-${payload.version}.zip`), "MANIFEST_PATH", "Invalid release asset filename.");
    requireValue(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (native ? limits.nativeBytes : limits.archiveBytes), "SIZE_LIMIT", "Release asset exceeds its size limit.");
    requireValue(typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.sha256), "MANIFEST_SCHEMA", "Invalid SHA-256 digest.");
    if (native) requireValue(validVersion(asset.version), "MANIFEST_SCHEMA", "Invalid native app version.");
  };
  validateAsset(payload.archive, false);
  if (payload.native) validateAsset(payload.native, true);
  else requireValue(!Object.hasOwn(payload, "native"), "MANIFEST_SCHEMA", "Native metadata cannot be empty.");
  return payload;
}

export function verifyManifest(manifest, publicKey, limits = UPDATE_LIMITS) {
  requireValue(exactKeys(manifest, ["payload", "signature"]), "MANIFEST_SCHEMA", "Invalid signed manifest fields.");
  validateManifestPayload(manifest.payload, limits);
  requireValue(typeof manifest.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(manifest.signature), "SIGNATURE_INVALID", "Invalid Ed25519 signature encoding.");
  requireValue(publicKey.asymmetricKeyType === "ed25519", "KEY_INVALID", "The update public key must use Ed25519.");
  const signature = Buffer.from(manifest.signature, "base64");
  requireValue(signature.length === 64 && signature.toString("base64") === manifest.signature
    && verify(null, Buffer.from(canonicalPayload(manifest.payload)), publicKey, signature), "SIGNATURE_INVALID", "The update manifest signature does not match the trusted public key.");
  return manifest.payload;
}

export function validateArchivePath(name) {
  requireValue(typeof name === "string" && name.length > 0 && name.length <= 240
    && !name.startsWith("/") && !name.includes("\\") && !/[\x00-\x1f\x7f<>:"|?*]/.test(name), "ARCHIVE_PATH", "Archive contains an unsafe path.");
  const directory = name.endsWith("/");
  const parts = (directory ? name.slice(0, -1) : name).split("/");
  requireValue(parts.every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), "ARCHIVE_PATH", `Archive contains an unsafe path: ${name}`);
  requireValue(!["ocr", ".release-secrets"].includes(parts[0].toLowerCase()), "ARCHIVE_CONTENT", "OCR resources and release secrets do not belong in renderer updates.");
  return { name, directory, parts };
}

export function unpackRendererArchive(bytes, limits = UPDATE_LIMITS) {
  requireValue(bytes.length > 0 && bytes.length <= limits.archiveBytes, "SIZE_LIMIT", "Renderer archive exceeds its size limit.");
  let total = 0;
  let count = 0;
  const names = new Set();
  const fileNames = new Set();
  const originalSizes = new Map();
  let files;
  try {
    files = unzipSync(bytes, {
      filter(entry) {
        const parsed = validateArchivePath(entry.name);
        const key = entry.name.replace(/\/$/, "").toLowerCase();
        requireValue(!names.has(key), "ARCHIVE_PATH", `Duplicate archive path: ${entry.name}`);
        names.add(key);
        count += 1;
        requireValue(count <= limits.entries, "SIZE_LIMIT", "Renderer archive contains too many entries.");
        requireValue(Number.isSafeInteger(entry.originalSize) && entry.originalSize >= 0
          && entry.originalSize <= limits.fileBytes, "SIZE_LIMIT", "An extracted renderer file exceeds its size limit.");
        requireValue(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= bytes.length
          && (entry.compression !== 0 || entry.size === entry.originalSize), "ARCHIVE_INVALID", "Archive entry sizes are inconsistent.");
        total += entry.originalSize;
        requireValue(total <= limits.extractedBytes, "SIZE_LIMIT", "Extracted renderer exceeds its size limit.");
        requireValue(!parsed.directory || entry.originalSize === 0, "ARCHIVE_CONTENT", "Directory entry contains file data.");
        if (!parsed.directory) {
          fileNames.add(key);
          originalSizes.set(entry.name, entry.originalSize);
        }
        return !parsed.directory;
      },
    });
  } catch (error) {
    if (error.code && typeof error.code === "string") throw error;
    throw failure("ARCHIVE_INVALID", `Cannot decode renderer archive: ${error.message}`);
  }
  requireValue(Object.keys(files).length === originalSizes.size
    && Object.entries(files).every(([name, data]) => data.length === originalSizes.get(name)), "ARCHIVE_INVALID", "Decoded archive entries do not match their declared sizes or names.");
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      requireValue(!fileNames.has(parts.join("/")), "ARCHIVE_PATH", "Archive uses a file as a directory.");
    }
  }
  requireValue(Object.hasOwn(files, "index.html") && files["index.html"].length > 0, "ARCHIVE_CONTENT", "Renderer archive must contain a nonempty root index.html.");
  return files;
}

function childPath(parent, ...segments) {
  const root = path.resolve(parent);
  const result = path.resolve(root, ...segments);
  requireValue(result.startsWith(root + path.sep), "STORAGE_PATH", "Update storage path escaped its root.");
  return result;
}

async function regularFile(filename, maxBytes) {
  const info = await lstat(filename);
  requireValue(info.isFile() && !info.isSymbolicLink(), "STORAGE_PATH", "Update storage contains a nonregular file.");
  requireValue(info.size <= maxBytes, "SIZE_LIMIT", "Stored update exceeds its size limit.");
  return readFile(filename);
}

async function realDirectory(dirname) {
  const info = await lstat(dirname);
  requireValue(info.isDirectory() && !info.isSymbolicLink(), "STORAGE_PATH", "Update storage contains a linked or invalid directory.");
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function makeNetworkPolicy(feedUrl, allowLoopbackHttpForTests) {
  const feed = new URL(feedUrl);
  const test = allowLoopbackHttpForTests === true && feed.protocol === "http:"
    && ["127.0.0.1", "[::1]"].includes(feed.hostname) && !feed.username && !feed.password && !feed.hash && !feed.search;
  requireValue(test || feed.href === UPDATE_FEED_URL, "FEED_NOT_ALLOWED", "Production updates must use the fixed HTTPS GitHub release feed.");
  const assetUrl = (payload, filename) => `${test ? feed.origin : "https://github.com"}${REPO_PATH}download/${encodeURIComponent(payload.tag)}/${encodeURIComponent(filename)}`;
  const allowedRedirect = (url, initial) => {
    if (url.username || url.password || url.hash) return false;
    if (test) return url.origin === feed.origin;
    if (url.protocol !== "https:" || url.port) return false;
    if (["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) return true;
    if (url.hostname !== "github.com" || url.search) return false;
    if (initial.href !== UPDATE_FEED_URL) return url.pathname === initial.pathname;
    if (url.href === UPDATE_FEED_URL) return true;
    const prefix = `${REPO_PATH}download/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const parts = url.pathname.slice(prefix.length).split("/");
    return parts.length === 2 && parts[1] === "renderer-update.json"
      && parts[0].startsWith("v") && validVersion(decodeURIComponent(parts[0].slice(1)));
  };
  return { feed, assetUrl, allowedRedirect };
}

async function fetchBytes(fetchImpl, policy, initialUrl, { limit, expectedSize, timeoutMs, onProgress }) {
  const initial = new URL(initialUrl);
  let current = initial;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(current.href, {
      method: "GET", redirect: "manual", signal, cache: "no-store",
      headers: { Accept: "application/octet-stream, application/json", "Cache-Control": "no-cache" },
    });
    requireValue(!response.url || new URL(response.url).href === current.href, "REDIRECT_POLICY", "The fetch adapter followed a redirect without validation.");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      requireValue(location && redirects < 5, "REDIRECT_POLICY", "Update download exceeded its redirect limit.");
      const next = new URL(location, current);
      requireValue(policy.allowedRedirect(next, initial), "REDIRECT_POLICY", "Update download redirected outside the trusted release hosts.");
      current = next;
      continue;
    }
    requireValue(response.ok && response.status === 200, "HTTP_ERROR", `Update server returned HTTP ${response.status}.`);
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null) {
      requireValue(/^\d+$/.test(lengthHeader) && Number.isSafeInteger(Number(lengthHeader))
        && Number(lengthHeader) <= limit && (expectedSize === undefined || Number(lengthHeader) === expectedSize), "SIZE_MISMATCH", "Update response size does not match the signed manifest.");
    }
    requireValue(response.body && typeof response.body.getReader === "function", "HTTP_ERROR", "Update response has no readable body.");
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastProgress = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        requireValue(received <= limit && (expectedSize === undefined || received <= expectedSize), "SIZE_LIMIT", "Update response exceeded its allowed size.");
        chunks.push(Buffer.from(value));
        if (Date.now() - lastProgress >= 100) {
          onProgress?.(received);
          lastProgress = Date.now();
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    requireValue(received > 0 && (expectedSize === undefined || received === expectedSize), "SIZE_MISMATCH", "Update response was truncated or has an unexpected size.");
    onProgress?.(received);
    return Buffer.concat(chunks, received);
  }
  throw failure("REDIRECT_POLICY", "Update download exceeded its redirect limit.");
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure("JSON_INVALID", "Update metadata is not valid UTF-8 JSON.");
  }
}

function validatePointer(pointer) {
  requireValue(exactKeys(pointer, ["schemaVersion", "current", "previous", "pending", "highWaterVersion", "rollbackReason"])
    && pointer.schemaVersion === 1 && typeof pointer.pending === "boolean" && validVersion(pointer.highWaterVersion)
    && [pointer.current, pointer.previous].every((version) => version === null || validVersion(version))
    && (pointer.rollbackReason === null || (typeof pointer.rollbackReason === "string" && pointer.rollbackReason.length <= 1000))
    && (!pointer.pending || pointer.current !== null), "STORAGE_CORRUPT", "Stored update pointer is invalid.");
  if (pointer.current) requireValue(semver.gte(pointer.highWaterVersion, pointer.current), "STORAGE_CORRUPT", "Stored update pointer has an invalid version boundary.");
  if (pointer.previous) requireValue(pointer.current !== null && semver.lt(pointer.previous, pointer.current), "STORAGE_CORRUPT", "Stored rollback version must precede the active renderer.");
  return pointer;
}

export async function createHotUpdater({
  appVersion, bundledVersion, bundledRoot, userDataDir, publicKeyPath,
  feedUrl = UPDATE_FEED_URL, fetchImpl = globalThis.fetch, onState,
  allowLoopbackHttpForTests = false, requestTimeoutMs = 120000, limits = UPDATE_LIMITS,
}) {
  requireValue(validVersion(appVersion) && validVersion(bundledVersion), "VERSION_INVALID", "App and bundled renderer versions must be canonical semantic versions.");
  requireValue(typeof fetchImpl === "function", "FETCH_INVALID", "A fetch implementation is required.");
  requireValue(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0, "TIMEOUT_INVALID", "The update request timeout must be positive.");
  for (const key of Object.keys(UPDATE_LIMITS)) requireValue(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= UPDATE_LIMITS[key], "SIZE_LIMIT", "Update limits may only narrow the built-in limits.");
  const policy = makeNetworkPolicy(feedUrl, allowLoopbackHttpForTests);
  const publicKey = createPublicKey(await readFile(publicKeyPath));
  requireValue(publicKey.asymmetricKeyType === "ed25519", "KEY_INVALID", "The update public key must use Ed25519.");
  const bundled = path.resolve(bundledRoot);
  requireValue((await lstat(path.join(bundled, "index.html"))).isFile(), "BUNDLE_INVALID", "The packaged renderer is missing index.html.");
  const updatesRoot = childPath(userDataDir, "updates");
  const versionsRoot = childPath(updatesRoot, "versions");
  await mkdir(updatesRoot, { recursive: true });
  await realDirectory(updatesRoot);
  await mkdir(versionsRoot, { recursive: true });
  await realDirectory(versionsRoot);
  const pointerPath = childPath(updatesRoot, "active.json");
  let pointer = { schemaVersion: 1, current: null, previous: null, pending: false, highWaterVersion: bundledVersion, rollbackReason: null };
  let activeRoot = bundled;
  let candidate = null;
  let ready = null;
  let busy = false;
  let state = {
    status: "idle", appVersion, bundledVersion, currentVersion: bundledVersion,
    availableVersion: null, minAppVersion: null, progress: { received: 0, total: 0, percent: 0 },
    error: null, rollbackReason: null, native: null, pending: false,
  };
  const getState = () => structuredClone(state);
  const emit = (patch) => {
    state = { ...state, ...patch };
    onState?.(getState());
    return getState();
  };
  const errorState = (error) => emit({ status: "error", error: { code: typeof error.code === "string" ? error.code : "UPDATE_ERROR", message: error.message } });
  const persist = async (next) => {
    validatePointer(next);
    await realDirectory(updatesRoot);
    await atomicJson(pointerPath, next);
    pointer = next;
  };
  const run = async (action) => {
    requireValue(!busy, "UPDATE_BUSY", "Another update operation is in progress.");
    busy = true;
    try {
      return await action();
    } catch (error) {
      errorState(error);
      throw error;
    } finally {
      busy = false;
    }
  };
  const versionDirectory = (version) => {
    requireValue(validVersion(version), "STORAGE_PATH", "Invalid stored renderer version.");
    return childPath(versionsRoot, version);
  };
  const nativeInfo = (payload) => payload.native ? { ...payload.native, url: policy.assetUrl(payload, payload.native.filename) } : null;
  const readInstalled = async (version) => {
    await realDirectory(updatesRoot);
    await realDirectory(versionsRoot);
    const dir = versionDirectory(version);
    await realDirectory(dir);
    const manifest = parseJson(await regularFile(childPath(dir, "manifest.json"), limits.manifestBytes));
    const payload = verifyManifest(manifest, publicKey, limits);
    requireValue(payload.version === version && semver.lte(payload.minAppVersion, appVersion), "INCOMPATIBLE", "Stored renderer is not compatible with this app.");
    const archive = await regularFile(childPath(dir, "renderer.zip"), limits.archiveBytes);
    requireValue(archive.length === payload.archive.size && sha256(archive) === payload.archive.sha256, "HASH_MISMATCH", "Stored renderer archive was modified.");
    const files = unpackRendererArchive(archive, limits);
    const root = childPath(dir, "renderer");
    let fileCount = 0;
    const inspect = async (directory, prefix = "") => {
      await realDirectory(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        const target = childPath(root, relative);
        if (entry.isDirectory()) await inspect(target, `${relative}/`);
        else {
          requireValue(entry.isFile() && Object.hasOwn(files, relative), "STORAGE_CORRUPT", "Stored renderer contains an unexpected file or link.");
          const data = await regularFile(target, limits.fileBytes);
          requireValue(data.length === files[relative].length && sha256(data) === sha256(files[relative]), "HASH_MISMATCH", `Stored renderer file was modified: ${relative}`);
          fileCount += 1;
        }
      }
    };
    await inspect(root);
    requireValue(fileCount === Object.keys(files).length, "STORAGE_CORRUPT", "Stored renderer is incomplete.");
    return { root, manifest, payload };
  };
  const selectRollback = async (reason) => {
    let previous = pointer.previous;
    let root = bundled;
    if (previous && semver.gt(previous, bundledVersion)) {
      try {
        root = (await readInstalled(previous)).root;
      } catch (error) {
        reason += ` Previous renderer was also rejected: ${error.message}`;
        previous = null;
      }
    } else previous = null;
    await persist({ ...pointer, current: previous, previous: null, pending: false, rollbackReason: reason.slice(0, 1000) });
    activeRoot = root;
    candidate = null;
    ready = null;
    return emit({ status: "error", currentVersion: previous || bundledVersion, pending: false,
      availableVersion: null, minAppVersion: null, native: null,
      rollbackReason: pointer.rollbackReason, error: { code: "ROLLED_BACK", message: pointer.rollbackReason } });
  };

  try {
    pointer = validatePointer(parseJson(await regularFile(pointerPath, limits.manifestBytes)));
    if (semver.gt(bundledVersion, pointer.highWaterVersion)) pointer.highWaterVersion = bundledVersion;
  } catch (error) {
    if (error.code !== "ENOENT") {
      const quarantine = childPath(updatesRoot, `active.corrupt.${randomUUID()}.json`);
      await rename(pointerPath, quarantine);
      pointer.rollbackReason = `Stored update pointer was rejected: ${error.message}`.slice(0, 1000);
      state = { ...state, status: "error", rollbackReason: pointer.rollbackReason,
        error: { code: "STORAGE_CORRUPT", message: pointer.rollbackReason } };
      await persist(pointer);
    }
  }
  if (pointer.pending) {
    await selectRollback(`Renderer ${pointer.current} did not confirm a successful boot before the app restarted.`);
  } else if (pointer.current && semver.gt(pointer.current, bundledVersion)) {
    try {
      const installed = await readInstalled(pointer.current);
      activeRoot = installed.root;
      state = { ...state, currentVersion: pointer.current, native: nativeInfo(installed.payload), rollbackReason: pointer.rollbackReason };
    } catch (error) {
      await selectRollback(`Stored renderer ${pointer.current} was rejected: ${error.message}`);
    }
  } else if (pointer.current) {
    await persist({ ...pointer, current: null, previous: null, pending: false });
  }
  if (pointer.rollbackReason && !state.error) state = { ...state, status: "error", rollbackReason: pointer.rollbackReason,
    error: { code: "ROLLED_BACK", message: pointer.rollbackReason } };
  emit({ pending: pointer.pending });

  return Object.freeze({
    getState,
    getActiveRoot: () => activeRoot,
    check: () => run(async () => {
      requireValue(!pointer.pending, "BOOT_PENDING", "Confirm or roll back the pending renderer before checking again.");
      candidate = null;
      ready = null;
      emit({ status: "checking", error: null, availableVersion: null, minAppVersion: null, native: null,
        progress: { received: 0, total: 0, percent: 0 } });
      const bytes = await fetchBytes(fetchImpl, policy, policy.feed.href, { limit: limits.manifestBytes, timeoutMs: requestTimeoutMs });
      const manifest = parseJson(bytes);
      const payload = verifyManifest(manifest, publicKey, limits);
      const information = { availableVersion: payload.version, minAppVersion: payload.minAppVersion, native: nativeInfo(payload) };
      emit(information);
      if (semver.lt(payload.version, state.currentVersion) || semver.lt(payload.version, pointer.highWaterVersion)
        || (semver.eq(payload.version, pointer.highWaterVersion) && semver.gt(pointer.highWaterVersion, state.currentVersion))) {
        throw failure("ROLLBACK_VERSION", "The release would downgrade or retry a previously rolled-back renderer version.");
      }
      if (semver.lte(payload.version, state.currentVersion)) return emit({ status: "idle", availableVersion: null });
      if (semver.gt(payload.minAppVersion, appVersion)) return emit({ status: "incompatible",
        error: { code: "INCOMPATIBLE", message: `This renderer requires app ${payload.minAppVersion} or newer.` } });
      candidate = { manifest, payload };
      return emit({ status: "available" });
    }),
    download: () => run(async () => {
      requireValue(candidate !== null && !pointer.pending, "NO_UPDATE", "Check for a compatible update before downloading.");
      ready = null;
      const { manifest, payload } = candidate;
      emit({ status: "downloading", error: null, progress: { received: 0, total: payload.archive.size, percent: 0 } });
      const archive = await fetchBytes(fetchImpl, policy, policy.assetUrl(payload, payload.archive.filename), {
        limit: limits.archiveBytes, expectedSize: payload.archive.size, timeoutMs: requestTimeoutMs,
        onProgress: (received) => emit({ progress: { received, total: payload.archive.size, percent: Math.floor(received / payload.archive.size * 100) } }),
      });
      requireValue(sha256(archive) === payload.archive.sha256, "HASH_MISMATCH", "Renderer archive SHA-256 does not match the signed manifest.");
      verifyManifest(manifest, publicKey, limits);
      const files = unpackRendererArchive(archive, limits);
      const destination = versionDirectory(payload.version);
      const staging = childPath(versionsRoot, `.staging-${randomUUID()}`);
      try {
        await realDirectory(updatesRoot);
        await realDirectory(versionsRoot);
        await mkdir(childPath(staging, "renderer"), { recursive: true });
        for (const [name, data] of Object.entries(files)) {
          const filename = childPath(staging, "renderer", name);
          await mkdir(path.dirname(filename), { recursive: true });
          await writeFile(filename, data, { flag: "wx" });
        }
        await writeFile(childPath(staging, "renderer.zip"), archive, { flag: "wx" });
        await writeFile(childPath(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
        try {
          await rename(staging, destination);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
          const installed = await readInstalled(payload.version);
          requireValue(canonicalPayload(installed.payload) === canonicalPayload(payload), "VERSION_CONFLICT", "This version was already downloaded with different signed contents.");
        }
      } finally {
        await realDirectory(versionsRoot);
        await rm(childPath(versionsRoot, path.basename(staging)), { recursive: true, force: true });
      }
      ready = { version: payload.version, root: childPath(destination, "renderer") };
      return emit({ status: "ready" });
    }),
    apply: () => run(async () => {
      requireValue(ready !== null && !pointer.pending, "NOT_READY", "Download and verify an update before applying it.");
      requireValue(semver.gt(ready.version, state.currentVersion) && semver.gt(ready.version, pointer.highWaterVersion), "ROLLBACK_VERSION", "The renderer update is not newer than the accepted version boundary.");
      const installed = await readInstalled(ready.version);
      await persist({ ...pointer, current: ready.version, previous: pointer.current, pending: true,
        highWaterVersion: ready.version, rollbackReason: null });
      activeRoot = installed.root;
      ready = null;
      candidate = null;
      return emit({ status: "applied", currentVersion: pointer.current, pending: true, rollbackReason: null, error: null });
    }),
    confirmBoot: (expectedVersion) => run(async () => {
      if (expectedVersion !== undefined) requireValue(expectedVersion === state.currentVersion, "BOOT_VERSION_MISMATCH", "The renderer boot confirmation belongs to another version.");
      if (!pointer.pending) return getState();
      await persist({ ...pointer, pending: false, rollbackReason: null });
      return emit({ status: "applied", pending: false, rollbackReason: null, error: null });
    }),
    rollback: (reason = "The renderer failed its startup health check.") => run(async () => {
      requireValue(typeof reason === "string" && reason.length > 0 && reason.length <= 800, "REASON_INVALID", "Rollback requires a concise reason.");
      requireValue(pointer.current !== null, "NO_ROLLBACK", "The bundled renderer has no earlier hot update to roll back to.");
      return selectRollback(reason);
    }),
  });
}
