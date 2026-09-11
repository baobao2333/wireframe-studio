import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function readRegularFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular key file: ${filename}`);
    return await readFile(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function keyDirectory(directory, mode) {
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Key directory must not be a link: ${directory}`);
}

export async function prepareReleaseKey({ root = projectRoot } = {}) {
  const privateKeyPath = path.resolve(root, ".release-secrets/update-private-key.pem");
  const publicKeyPath = path.resolve(root, "desktop/update-public-key.pem");
  await keyDirectory(path.dirname(privateKeyPath), 0o700);
  await keyDirectory(path.dirname(publicKeyPath), 0o755);
  const privateBytes = await readRegularFile(privateKeyPath);
  const publicBytes = await readRegularFile(publicKeyPath);
  if (!privateBytes && publicBytes) {
    throw new Error("A trusted public key already exists, but its private key is missing. Restore the original private key; automatic key rotation is forbidden.");
  }

  let privateKey;
  let status;
  if (privateBytes) {
    privateKey = createPrivateKey(privateBytes);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The existing private key is not Ed25519.");
    status = publicBytes ? "verified" : "public-key-restored";
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    status = "created";
  }

  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  if (publicBytes) {
    if (!publicBytes.toString("utf8").trim().startsWith("-----BEGIN PUBLIC KEY-----")) {
      throw new Error("The public key file must contain a public key, not private material.");
    }
    const existing = createPublicKey(publicBytes);
    if (existing.asymmetricKeyType !== "ed25519" || !publicDer.equals(existing.export({ type: "spki", format: "der" }))) {
      throw new Error("The existing public and private keys do not match. Neither file was overwritten.");
    }
  } else {
    await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
  }
  return {
    status, privateKeyPath, publicKeyPath,
    publicKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log("node scripts/prepare-release-key.mjs\nCreate the first local Ed25519 signing key or verify the existing pair. Never overwrites or rotates an existing key. Not required to package a public-only source clone.");
  } else {
    prepareReleaseKey().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(`Release key preparation failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
