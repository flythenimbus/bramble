import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";

const root = resolve(__dirname, "src");
const outDir = resolve(__dirname, "dist");

export default defineConfig({
  root,
  publicDir: resolve(__dirname, "public"),
  plugins: [
    react(),
    {
      name: "copy-manifest",
      writeBundle() {
        mkdirSync(outDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, "../manifests/chrome/manifest.json"),
          resolve(outDir, "manifest.json"),
        );
      },
    },
  ],
  resolve: {
    alias: {
      "@core": resolve(__dirname, "../core/src"),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(root, "popup.html"),
        options: resolve(root, "options.html"),
        offscreen: resolve(root, "offscreen.html"),
        background: resolve(root, "background.ts"),
        "content-script": resolve(root, "content-script.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
