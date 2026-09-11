import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./desktop/renderer", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  css: { postcss: fileURLToPath(new URL(".", import.meta.url)) },
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome144",
  },
});
