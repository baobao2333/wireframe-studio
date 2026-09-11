import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const publisher = Object.freeze(JSON.parse(await readFile(new URL("./publisher.json", import.meta.url), "utf8")));
const source = await readFile(new URL("./verify-signature.ps1", import.meta.url), "utf8");
const encodedCommand = Buffer.from(source, "utf16le").toString("base64");

async function inspect(file, expected) {
  if (process.platform !== "win32") throw new Error("Windows signature verification requires Windows");
  if (!/^[A-F0-9]{64}$/.test(publisher.certificateSha256) || publisher.trust !== "self-signed")
    throw new Error("Invalid pinned publisher configuration");
  const target = resolve(file);
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let stdout;
  try {
    ({ stdout } = await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
      windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PSModulePath: "", WIREFRAME_SIGNATURE_FILE: target,
        WIREFRAME_SIGNATURE_SIZE: expected ? String(expected.size) : "",
        WIREFRAME_SIGNATURE_SHA256: expected?.sha256 ?? "" },
    }));
  } catch (error) {
    throw new Error(`Windows signature verification failed: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
  const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (result.path !== target) throw new Error("Signature verification returned a different file");
  if (expected && (result.size !== expected.size || result.sha256 !== expected.sha256))
    throw new Error("Installer does not match the signed manifest");
  if (!["0x00000000", "0x800B0109"].includes(result.winTrustStatus))
    throw new Error(`Authenticode verification failed: ${result.winTrustStatus}`);
  if (!result.certificate) throw new Error("Authenticode signer certificate is missing");
  const certificate = new X509Certificate(Buffer.from(result.certificate, "base64"));
  const fingerprint = certificate.fingerprint256.replaceAll(":", "");
  if (fingerprint !== publisher.certificateSha256 || certificate.subject !== publisher.subject)
    throw new Error("Authenticode signer does not match the pinned publisher certificate");
  if (!certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3"))
    throw new Error("The pinned certificate is not a code-signing certificate");
  if (certificate.issuer !== certificate.subject || !certificate.verify(certificate.publicKey))
    throw new Error("The pinned self-signed certificate is invalid");
  const now = Date.now();
  if (!(certificate.validFromDate.getTime() <= now && now <= certificate.validToDate.getTime()))
    throw new Error("The pinned publisher certificate is outside its validity period");
  return { file: target, size: result.size, sha256: result.sha256, publisher: publisher.name,
    subject: certificate.subject, certificateSha256: fingerprint, winTrustStatus: result.winTrustStatus,
    windowsTrusted: result.winTrustStatus === "0x00000000", trust: "pinned-self-signed" };
}

// Release gate only. Runtime installer downloads must use verifyWindowsInstaller.
export async function verifyWindowsSignature(file) {
  return inspect(file);
}

// expected must come from the already Ed25519-verified native manifest, not latest.yml.
export async function verifyWindowsInstaller(file, expected) {
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))
    throw new Error("A verified installer size and SHA256 are required");
  return inspect(file, { size: expected.size, sha256: expected.sha256 });
}
