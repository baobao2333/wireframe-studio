import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { NtExecutable } from "pe-library";
import { createPackage } from "@electron/asar";
import { verifyWindowsInstaller, verifyWindowsSignature } from "../desktop/windows-signature.mjs";

const { values } = parseArgs({ options: { signed: { type: "string" } } });
assert.ok(values.signed, "Usage: node scripts/test-windows-signature.mjs --signed <existing signed EXE>");
const signed = path.resolve(values.signed);
const root = fileURLToPath(new URL("..", import.meta.url));
const publisher = JSON.parse(await readFile(new URL("../desktop/publisher.json", import.meta.url), "utf8"));

async function expectedFor(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: (await stat(file)).size, sha256: hash.digest("hex") };
}

if (process.versions.electron && process.env.WIREFRAME_SIGNATURE_TEST_ASAR) {
  const { app } = await import("electron");
  const checkAsar = async () => {
    app.setName("Wireframe Signature ASAR Check");
    app.setPath("userData", process.env.WIREFRAME_SIGNATURE_TEST_DATA);
    await app.whenReady();
    const inside = pathToFileURL(path.join(process.env.WIREFRAME_SIGNATURE_TEST_ASAR, "desktop", "windows-signature.mjs")).href;
    const { verifyWindowsInstaller: verifyPackaged } = await import(inside);
    const result = await verifyPackaged(signed, await expectedFor(signed));
    assert.equal(result.certificateSha256, publisher.certificateSha256);
    console.log(`PASS Electron ${process.versions.electron} reads verification source from ASAR; no windows created`);
  };
  checkAsar().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
const original = await expectedFor(signed);
const prefix = "wireframe-signature-test-";
const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
try {
  const verified = await verifyWindowsSignature(signed);
  assert.equal(verified.certificateSha256, publisher.certificateSha256);
  assert.equal(verified.subject, publisher.subject);
  assert.equal(verified.sha256, original.sha256);
  assert.equal((await verifyWindowsInstaller(signed, original)).sha256, original.sha256);
  console.log(`PASS real pinned signer and full-file hash; WinVerifyTrust ${verified.winTrustStatus}`);

  if (!verified.windowsTrusted) {
    const { verifySignature } = createRequire(import.meta.url)("electron-updater/out/windowsExecutableCodeSignatureVerifier.js");
    const failure = await verifySignature([publisher.subject], signed, { info() {}, warn() {} });
    assert.ok(failure, "The default updater verifier must reject the untrusted self-signed certificate");
    console.log("PASS default electron-updater verifier reproduces the untrusted-root rejection");
  }

  await assert.rejects(verifyWindowsInstaller(signed), /verified installer size and SHA256/);
  await assert.rejects(verifyWindowsInstaller(signed, { ...original, size: original.size + 1 }), /size does not match/);
  await assert.rejects(verifyWindowsInstaller(signed, { ...original, sha256: "0".repeat(64) }), /SHA256 does not match/);
  console.log("PASS missing/incorrect manifest binding is rejected before Authenticode policy");

  const alternate = path.join(temporary, "desktop");
  await mkdir(alternate);
  for (const name of ["windows-signature.mjs", "verify-signature.ps1"])
    await copyFile(path.join(root, "desktop", name), path.join(alternate, name));
  const wrongPin = (publisher.certificateSha256[0] === "0" ? "1" : "0") + publisher.certificateSha256.slice(1);
  await writeFile(path.join(alternate, "publisher.json"), JSON.stringify({ ...publisher, certificateSha256: wrongPin }));
  const { verifyWindowsSignature: wrongPublisher } = await import(pathToFileURL(path.join(alternate, "windows-signature.mjs")).href);
  await assert.rejects(wrongPublisher(signed), /pinned publisher certificate/);
  console.log("PASS the same CN is insufficient when the pinned certificate hash differs");

  const copy = path.join(temporary, "quoted' file-[probe];.exe");
  await copyFile(signed, copy);
  assert.equal((await verifyWindowsInstaller(copy, original)).sha256, original.sha256);
  const handle = await open(copy, "r+");
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 0x50);
    byte[0] ^= 1;
    await handle.write(byte, 0, 1, 0x50);
  } finally { await handle.close(); }
  await assert.rejects(verifyWindowsInstaller(copy, original), /SHA256 does not match/);
  await assert.rejects(verifyWindowsSignature(copy), /0x80096010/);
  await assert.rejects(verifyWindowsInstaller(copy, await expectedFor(copy)), /0x80096010/);
  console.log("PASS path punctuation is literal; a changed PE digest fails even with a matching test checksum");

  const unsigned = path.join(temporary, "unsigned.exe");
  await writeFile(unsigned, Buffer.from(NtExecutable.createEmpty(false).generate()));
  await assert.rejects(verifyWindowsSignature(unsigned), /0x800B0100/);
  console.log("PASS unsigned PE is rejected");

  const asarSource = path.join(temporary, "asar-source", "desktop");
  await mkdir(asarSource, { recursive: true });
  for (const name of ["windows-signature.mjs", "verify-signature.ps1", "publisher.json"])
    await copyFile(path.join(root, "desktop", name), path.join(asarSource, name));
  const asar = path.join(temporary, "verification.asar");
  await createPackage(path.dirname(asarSource), asar);
  const userData = path.join(temporary, "electron-user-data");
  await mkdir(userData);
  const env = { ...process.env, WIREFRAME_SIGNATURE_TEST_ASAR: asar, WIREFRAME_SIGNATURE_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = (await import("electron")).default;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(import.meta.url), "--signed", signed], { env, windowsHide: true, stdio: "inherit" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("ASAR verification exceeded 60 seconds"));
      else if (code === 0) resolve();
      else reject(new Error(`ASAR verification failed (${signal || code})`));
    });
  });
  assert.deepEqual(await expectedFor(signed), original);
  console.log("Windows signature checks passed; source EXE unchanged; no certificates or trust stores modified");
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith(prefix));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
}
