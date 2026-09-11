import { spawn } from "node:child_process";
import { createPublicKey, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";

const projectRoot = path.resolve(import.meta.dirname, "..");
export const runtimeDependencies = Object.freeze({ "electron-updater": "6.8.9", semver: "7.7.4", fflate: "0.8.3" });
const repository = "baobao2333/wireframe-studio";

async function regular(filename, kind = "file") {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !(kind === "directory" ? info.isDirectory() : info.isFile())) {
    throw new Error(`Expected a regular ${kind}, not a link: ${filename}`);
  }
  return info;
}

async function copyRuntime(source, destination, relative) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Runtime input must not contain links: ${relative}`);
  const parts = relative.toLowerCase().split("/");
  if (parts.includes(".release-secrets") || /private[-_]?key/i.test(path.basename(source))) {
    throw new Error(`Private signing material must not enter staging: ${relative}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      if (relative === "renderer" && name.toLowerCase() === "ocr") continue;
      await copyRuntime(path.join(source, name), path.join(destination, name), `${relative}/${name}`);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported runtime input: ${relative}`);
  if (/\.(pem|key|p12|pfx)$/i.test(relative) && relative !== "desktop/update-public-key.pem") {
    throw new Error(`Only the trusted update public key is allowed in staging: ${relative}`);
  }
  const bytes = await readFile(source);
  if (/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/.test(bytes.toString("utf8"))) {
    throw new Error(`Private-key content was found in runtime input: ${relative}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
}

async function stagePath(buildRoot, filename) {
  const relative = path.relative(buildRoot, path.resolve(filename));
  if (!/^desktop-app(?:\.(?:staging|previous)-[0-9a-f-]+)?$/.test(relative)) {
    throw new Error(`Refusing to replace a path outside the desktop staging area: ${filename}`);
  }
  try {
    await regular(filename, "directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeStage(buildRoot, filename) {
  await stagePath(buildRoot, filename);
  await rm(filename, { recursive: true, force: true });
}

async function installRuntime(directory, npmCli) {
  const cli = npmCli || process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await regular(cli);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--workspaces=false"], {
      cwd: directory, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Staging npm install failed (${signal || code}).`)));
  });
  for (const [name, version] of Object.entries(runtimeDependencies)) {
    const installed = JSON.parse(await readFile(path.join(directory, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== version) throw new Error(`Unexpected runtime dependency: ${name}@${installed.version}; expected ${version}.`);
  }
}

export async function stageDesktop({ root = projectRoot, install = true, npmCli } = {}) {
  root = await realpath(root);
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!semver.valid(rootPackage.version) || semver.clean(rootPackage.version) !== rootPackage.version) {
    throw new Error("The root package must have a canonical semantic version.");
  }
  const desktop = path.join(root, "desktop");
  const renderer = path.join(root, "dist-renderer");
  await regular(desktop, "directory");
  await regular(renderer, "directory");
  for (const name of ["main.mjs", "preload.cjs", "release.json", "update-public-key.pem"]) await regular(path.join(desktop, name));
  await regular(path.join(renderer, "index.html"));
  await regular(path.join(root, "server/vision-schema.mjs"));
  await regular(path.join(root, "server/vision-instructions.txt"));
  await regular(path.join(root, "assets/app.ico"));
  await regular(path.join(root, "public/ocr"), "directory");
  const publicPem = await readFile(path.join(desktop, "update-public-key.pem"), "utf8");
  if (!publicPem.trim().startsWith("-----BEGIN PUBLIC KEY-----") || createPublicKey(publicPem).asymmetricKeyType !== "ed25519") {
    throw new Error("desktop/update-public-key.pem must contain the trusted Ed25519 public key.");
  }

  const buildRoot = path.join(root, "build");
  await mkdir(buildRoot, { recursive: true });
  await regular(buildRoot, "directory");
  const appDir = path.join(buildRoot, "desktop-app");
  const temporary = path.join(buildRoot, `desktop-app.staging-${randomUUID()}`);
  const previous = path.join(buildRoot, `desktop-app.previous-${randomUUID()}`);
  await stagePath(buildRoot, appDir);
  await stagePath(buildRoot, temporary);
  await mkdir(temporary);
  try {
    for (const name of (await readdir(desktop)).sort()) {
      if (/\.(mjs|cjs|json|pem)$/i.test(name) || name === "verify-signature.ps1") await copyRuntime(path.join(desktop, name), path.join(temporary, "desktop", name), `desktop/${name}`);
    }
    await copyRuntime(path.join(root, "server/vision-schema.mjs"), path.join(temporary, "server/vision-schema.mjs"), "server/vision-schema.mjs");
    await copyRuntime(renderer, path.join(temporary, "renderer"), "renderer");
    const release = JSON.parse(await readFile(path.join(temporary, "desktop/release.json"), "utf8"));
    if (release.appVersion !== rootPackage.version || release.repository !== repository) {
      throw new Error("desktop/release.json appVersion and repository must match the root package version and release repository.");
    }
    if (!semver.valid(release.rendererVersion) || !semver.valid(release.minAppVersion) || semver.gt(release.minAppVersion, release.appVersion)) {
      throw new Error("desktop/release.json contains an invalid or incompatible renderer version contract.");
    }
    const runtimePackage = {
      name: rootPackage.name, version: rootPackage.version, private: true, type: "module", main: "desktop/main.mjs",
      description: rootPackage.description, author: rootPackage.author, license: rootPackage.license,
      repository: { type: "git", url: `https://github.com/${repository}.git` },
      dependencies: runtimeDependencies,
    };
    await writeFile(path.join(temporary, "package.json"), JSON.stringify(runtimePackage, null, 2) + "\n", { flag: "wx" });
    if (install) await installRuntime(temporary, npmCli);

    let replaced = false;
    await stagePath(buildRoot, appDir);
    await stagePath(buildRoot, previous);
    try {
      await rename(appDir, previous);
      replaced = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await stagePath(buildRoot, temporary);
      await rename(temporary, appDir);
    } catch (error) {
      if (replaced) {
        await stagePath(buildRoot, previous);
        await stagePath(buildRoot, appDir);
        await rename(previous, appDir);
      }
      throw error;
    }
    if (replaced) await removeStage(buildRoot, previous);
    return { appDir, version: rootPackage.version, dependencies: runtimeDependencies, installed: install };
  } finally {
    await removeStage(buildRoot, temporary);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log("node scripts/stage-desktop.mjs\nStage desktop and prebuilt dist-renderer into build/desktop-app, then install only the pinned production runtime dependencies. Requires the trusted public key, never the private key.");
  } else {
    stageDesktop().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(`Desktop staging failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
