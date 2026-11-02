import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { linguiMacroPlugin } from "../../scripts/vite-lingui.mjs";

const root = resolve(import.meta.dirname, "src");

// TARGET=firefox builds the Gecko variant into dist-firefox with the Firefox
// manifest (event-page background, no offscreen/webAuthenticationProxy). Default is
// the Chromium build into dist. The two outputs never clobber each other.
// EXTENSION_OUT_DIR builds into another folder (the combining e2e's build).
const target = process.env.TARGET === "firefox" ? "firefox" : "chromium";
const outDir = resolve(
	import.meta.dirname,
	process.env.EXTENSION_OUT_DIR ?? (target === "firefox" ? "dist-firefox" : "dist-chromium"),
);
const manifestSrc = resolve(
	import.meta.dirname,
	`../../packages/manifests/${target}/manifest.json`,
);

export default defineConfig({
	root,
	publicDir: resolve(import.meta.dirname, "public"),
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
			// Firefox's action icon: one SVG that picks the black or white mark by the browser
			// theme, from the same PNGs Chrome uses. Manifest theme_icons only reach a button
			// pinned to the toolbar; in the Extensions panel Firefox showed the black mark on
			// dark themes too.
			name: "firefox-themed-icon",
			writeBundle() {
				if (target !== "firefox") return;
				const png = (name: string) =>
					readFileSync(resolve(import.meta.dirname, "public/icons", name)).toString("base64");
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><style>.d{display:none}@media (prefers-color-scheme: dark){.l{display:none}.d{display:inline}}</style><image class="l" width="32" height="32" href="data:image/png;base64,${png("icon-32.png")}"/><image class="d" width="32" height="32" href="data:image/png;base64,${png("icon-32-dark.png")}"/></svg>\n`;
				writeFileSync(resolve(outDir, "icons/icon-themed.svg"), svg);
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
			"@core": resolve(import.meta.dirname, "../../packages/core/src"),
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
