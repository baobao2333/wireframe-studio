import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const release = JSON.parse(
  readFileSync(new URL("./desktop/release.json", import.meta.url), "utf8"),
);

export default defineConfig({
  root: fileURLToPath(new URL("./desktop/renderer", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  define: { __WIREFRAME_UI_VERSION__: JSON.stringify(release.rendererVersion) },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  css: { postcss: fileURLToPath(new URL(".", import.meta.url)) },
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome144",
  },
});
