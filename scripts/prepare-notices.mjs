import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");
const noticeName = /^(?:licen[cs]es?|copying|notice)(?:$|[._-])|^third[-_]party[-_](?:licenses?|notices?)/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("License inputs must be regular files, not links.");
  const bytes = await readFile(filename);
  if (bytes.includes(0)) throw new Error("A license input is not a plain text document.");
  return bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
}

async function findNotices(directory, prefix = "") {
  const documents = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const filename = path.join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Linked package content cannot be inventoried: ${relative}`);
    if (entry.isDirectory()) documents.push(...await findNotices(filename, relative + "/"));
    else if (entry.isFile() && noticeName.test(entry.name)) documents.push({ source: relative, text: await regularFile(filename) });
  }
  return documents;
}

async function readmeLicense(directory) {
  const name = (await readdir(directory)).sort().find((entry) => /^readme(?:\.|$)/i.test(entry));
  if (!name) return null;
  const lines = (await regularFile(path.join(directory, name))).split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+.*licen[cs]e/i.test(line));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s+`)).test(lines[end])) end += 1;
  return { source: `${name}, license section`, text: lines.slice(start, end).join("\n").trimEnd() };
}

function publicRepository(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (!value) return null;
  let address = value.replace(/^git\+/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(address)) address = `https://github.com/${address}`;
  try {
    const url = new URL(address);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function prepareNotices({ root = projectRoot } = {}) {
  root = path.resolve(root);
  const lockText = await regularFile(path.join(root, "package-lock.json"));
  const lock = JSON.parse(lockText);
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || Array.isArray(lock.packages)) {
    throw new Error("A structured npm lockfileVersion 2 or 3 packages map is required.");
  }
  const packages = [];
  const skippedOptional = [];
  const readmeOnly = [];
  const metadataOnly = [];
  let licenseDocuments = 0;
  for (const [location, record] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!location || record.dev === true) continue;
    if (!location.startsWith("node_modules/") || location.split("/").some((part) => part === "..") || location.includes("\\") || record.link) {
      throw new Error("Non-development lockfile entries must identify installed node_modules packages, not linked or external paths.");
    }
    const directory = path.join(root, location);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Package is not a regular directory: ${location}`);
    } catch (error) {
      if (error.code === "ENOENT" && record.optional === true) {
        skippedOptional.push(`${location}@${record.version}`);
        continue;
      }
      throw error;
    }
    const metadata = JSON.parse(await regularFile(path.join(directory, "package.json")));
    if (metadata.version !== record.version) throw new Error(`Installed package differs from package-lock.json: ${location}`);
    const documents = await findNotices(directory);
    const excerpt = await readmeLicense(directory);
    if (metadata.name === "font-awesome") {
      if (metadata.version !== "4.7.0") throw new Error("The vendored Font Awesome notice is specific to 4.7.0 and must be reviewed before changing versions.");
      documents.push({ source: "vendor/Font-Awesome-LICENSE.txt (verified upstream font/code terms)", text: await regularFile(path.join(root, "vendor/Font-Awesome-LICENSE.txt")) });
    }
    const declared = metadata.license ?? metadata.licenses ?? record.license ?? "NOT DECLARED";
    const license = typeof declared === "string" ? declared : JSON.stringify(declared);
    const name = `${metadata.name}@${metadata.version}`;
    if (!documents.length) (excerpt ? readmeOnly : metadataOnly).push(name);
    licenseDocuments += documents.length;
    packages.push({ name, location, license, repository: publicRepository(metadata.repository), documents, excerpt });
  }
  const vendorDocuments = [];
  for (const name of (await readdir(path.join(root, "vendor"))).sort()) {
    if (name === "Font-Awesome-LICENSE.txt" || !/licen[cs]e|copying|notice/i.test(name)) continue;
    vendorDocuments.push({ source: `vendor/${name}`, text: await regularFile(path.join(root, "vendor", name)) });
  }

  const lines = [
    "WIREFRAME STUDIO - THIRD-PARTY NOTICES", "====================================", "",
    "This file preserves notices supplied with actually installed non-development npm packages and vendored frontend assets.",
    "The inventory follows package-lock.json, including non-development transitive and installed optional packages; it may be broader than the final renderer bundle.",
    "It does not change Wireframe Studio's UNLICENSED project status or certify legal compliance.",
    "Upstream public copyright and attribution text is preserved. Build-machine paths, account metadata and environment variables are not collected.",
    "A package license declaration or README section is not represented as a substitute for a missing complete license document.", "",
    `Lockfile version: ${lock.lockfileVersion}`,
    `Normalized lockfile SHA256: ${sha256(lockText)}`,
    `Installed non-development packages: ${packages.length}`,
    `Packaged/upstream license documents: ${licenseDocuments}`,
    `Additional vendor license documents: ${vendorDocuments.length}`, "",
    "SOURCE-TEXT COVERAGE GAPS", "-------------------------",
    "README license section only (verbatim below; completeness is not certified):",
    ...(readmeOnly.length ? readmeOnly.map((name) => `  ${name}`) : ["  None"]),
    "No LICENSE/COPYING/NOTICE file or README license section in the installed package:",
    ...(metadataOnly.length ? metadataOnly.map((name) => `  ${name}`) : ["  None"]),
    "For these entries, the declared license and public upstream/package source are listed below. Missing legal text or copyright statements have not been invented.", "",
    "OPTIONAL PACKAGES NOT INSTALLED", "-------------------------------",
    ...skippedOptional.map((name) => `  ${name}`), "",
  ];
  for (const item of packages) {
    lines.push("=".repeat(78), item.name, `Lockfile location: ${item.location}`, `Declared license: ${item.license}`,
      `Package source: https://www.npmjs.com/package/${item.name.slice(0, item.name.lastIndexOf("@"))}/v/${item.name.slice(item.name.lastIndexOf("@") + 1)}`);
    if (item.repository) lines.push(`Upstream repository: ${item.repository}`);
    if (!item.documents.length) lines.push("Status: no standalone complete license document was supplied by this installed package.");
    for (const document of item.documents) lines.push("", `--- Source document: ${document.source} ---`, document.text);
    if (item.excerpt) lines.push("", `--- README license statement: ${item.excerpt.source} (verbatim, not a completeness claim) ---`, item.excerpt.text);
    lines.push("");
  }
  for (const document of vendorDocuments) lines.push("=".repeat(78), `VENDORED ASSET NOTICE: ${document.source}`, "", document.text, "");
  const text = lines.join("\n") + "\n";
  if (/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/.test(text)) throw new Error("Unexpected private-key content in notice inputs.");
  const build = path.join(root, "build");
  await mkdir(build, { recursive: true });
  const buildInfo = await lstat(build);
  if (!buildInfo.isDirectory() || buildInfo.isSymbolicLink()) throw new Error("The notice output directory must not be a link.");
  const output = path.join(build, "THIRD-PARTY-NOTICES.txt");
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { output: "build/THIRD-PARTY-NOTICES.txt", packages: packages.length, licenseDocuments, vendorDocuments: vendorDocuments.length,
    readmeOnly, metadataOnly, skippedOptional: skippedOptional.length, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
  if (values.help) console.log("node scripts/prepare-notices.mjs\nAggregate installed non-development package notices and verified vendor licenses into build/THIRD-PARTY-NOTICES.txt. No network requests are made.");
  else prepareNotices().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(`Third-party notice preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
