import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { linguiMacroPlugin } from "../../scripts/vite-lingui.mjs";

const root = resolve(__dirname, "src");

// TARGET=firefox builds the Gecko variant into dist-firefox with the Firefox
// manifest (event-page background, no offscreen/webAuthenticationProxy). Default is
// the Chromium build into dist. The two outputs never clobber each other.
const target = process.env.TARGET === "firefox" ? "firefox" : "chromium";
const outDir = resolve(__dirname, target === "firefox" ? "dist-firefox" : "dist-chromium");
const manifestSrc = resolve(__dirname, `../manifests/${target}/manifest.json`);

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
				copyFileSync(manifestSrc, resolve(outDir, "manifest.json"));
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
				"sync-frame": resolve(root, "sync-frame.html"),
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
