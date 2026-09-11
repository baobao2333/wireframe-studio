import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { copyFile } from "node:fs/promises";
import { stageDesktop } from "./stage-desktop.mjs";
import { prepareNotices } from "./prepare-notices.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, signed: { type: "boolean" } } });
if (values.help) {
  console.log("node scripts/package-desktop.mjs [--signed]\nBuild dist-renderer first. Stages production dependencies and builds the Windows x64 NSIS installer without publishing. --signed requires the pinned code-signing certificate in the current user's Windows certificate store.");
} else {
  try {
    if (process.platform !== "win32") throw new Error("This release entrypoint must run on Windows.");
    const builder = createRequire(import.meta.url).resolve("electron-builder/cli.js");
    await prepareNotices();
    const staged = await stageDesktop();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(staged.version)) throw new Error("Invalid release version.");
    const releaseRoot = path.join(projectRoot, "release");
    const nativeOutput = path.resolve(releaseRoot, `native-${staged.version}`);
    if (!nativeOutput.startsWith(releaseRoot + path.sep)) throw new Error("Native output is outside the release directory.");
    console.log(`Building Wireframe Studio ${staged.version} from ${staged.appDir}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [builder, "--config", path.join(projectRoot, "electron-builder.config.cjs"), `--config.directories.output=${nativeOutput}`, "--win", "nsis", "--x64", "--publish", "never"], {
        cwd: projectRoot, stdio: "inherit", windowsHide: true,
        env: { ...process.env, WIREFRAME_SIGN_RELEASE: values.signed ? "1" : "0" },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`electron-builder failed (${signal || code}).`)));
    });
    for (const name of [`Wireframe-Studio-Setup-${staged.version}-x64.exe`, `Wireframe-Studio-Setup-${staged.version}-x64.exe.blockmap`, "latest.yml"])
      await copyFile(path.join(nativeOutput, name), path.join(releaseRoot, name));
  } catch (error) {
    console.error(`Desktop packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
