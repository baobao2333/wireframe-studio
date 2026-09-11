import vinext from "vinext";
import { defineConfig } from "vite";
import { visionBridge } from "./server/vision-bridge.mjs";

// Legacy loopback preview for migrating browser projects. Desktop builds use vite.desktop.config.ts.
export default defineConfig({
  plugins: [visionBridge(), vinext()],
  server: { host: "127.0.0.1", watch: { ignored: ["**/public/ocr/**"] } },
});
