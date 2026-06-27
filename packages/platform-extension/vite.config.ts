import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { linguiMacroPlugin } from "../../scripts/vite-lingui.mjs";

const root = resolve(__dirname, "src");
const outDir = resolve(__dirname, "dist");

export default defineConfig({
	root,
	publicDir: resolve(__dirname, "public"),
	plugins: [
		// Rewrites <Trans>/t`` macros (English stays inline; i18n:extract pulls it
		// into catalogs). Must run before react(): see scripts/vite-lingui.mjs.
		linguiMacroPlugin(),
		react(),
		tailwindcss(),
		{
			name: "copy-manifest",
			writeBundle() {
				mkdirSync(outDir, { recursive: true });
				copyFileSync(
					resolve(__dirname, "../manifests/chromium/manifest.json"),
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
		chunkSizeWarningLimit: 600,
		// Chrome 116+ has native modulepreload; dropping the polyfill keeps autofill-ui flat.
		modulePreload: { polyfill: false },
		rollupOptions: {
			input: {
				popup: resolve(root, "popup.html"),
				options: resolve(root, "options.html"),
				offscreen: resolve(root, "offscreen.html"),
				"autofill-ui": resolve(root, "autofill-ui.html"),
				background: resolve(root, "background/background.ts"),
				"content-script": resolve(root, "content/content.ts"),
			},
			output: {
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
