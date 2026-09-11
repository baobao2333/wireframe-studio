import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
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
    console.log(`Building Wireframe Studio ${staged.version} from ${staged.appDir}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [builder, "--config", path.join(projectRoot, "electron-builder.config.cjs"), "--win", "nsis", "--x64", "--publish", "never"], {
        cwd: projectRoot, stdio: "inherit", windowsHide: true,
        env: { ...process.env, WIREFRAME_SIGN_RELEASE: values.signed ? "1" : "0" },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`electron-builder failed (${signal || code}).`)));
    });
  } catch (error) {
    console.error(`Desktop packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
