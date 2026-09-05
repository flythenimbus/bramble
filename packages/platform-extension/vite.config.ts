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
		{
			// Content scripts load as classic scripts, and Firefox shares ONE isolated-world
			// global across all of an extension's content scripts in a document, so bare
			// top-level declarations collide between files — e.g. the autofill script's
			// minified `t` (a regex) clobbering the passkey bridge's `t` (isReq), which then
			// throws "t is not a function". Wrap each content script (and the MAIN-world
			// in-page override, which shares the page realm) in an IIFE so nothing leaks. The
			// module entries (popup/options/offscreen/autofill-ui/background) load as ES
			// modules with their own scope, so they're left untouched.
			name: "iife-content-scripts",
			renderChunk(code, chunk) {
				const CONTENT_SCRIPTS = new Set([
					"content-script.js",
					"webauthn-inpage.js",
					"webauthn-bridge.js",
				]);
				if (!CONTENT_SCRIPTS.has(chunk.fileName)) return null;
				return { code: `(function(){\n${code}\n})();\n`, map: null };
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
		// Explicit: extension contexts (SW, offscreen, per-tab content script) stay
		// resident in Chromium RAM, so no source maps ship and dev builds must not
		// land in the release directory (see package.json dev/devDir note).
		sourcemap: false,
		minify: "esbuild",
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
				// Firefox-only passkey-provider transport (Chrome uses webAuthenticationProxy):
				// the MAIN-world override + its isolated-world relay. Each must bundle flat (no
				// chunk imports) since content scripts load as classic scripts; keep them import-
				// light. See docs/firefox-port.md.
				...(target === "firefox"
					? {
							"webauthn-inpage": resolve(root, "content/webauthn-inpage.ts"),
							"webauthn-bridge": resolve(root, "content/webauthn-bridge.ts"),
						}
					: {}),
			},
			output: {
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
