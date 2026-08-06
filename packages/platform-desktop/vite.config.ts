import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { linguiMacroPlugin } from "../../scripts/vite-lingui.mjs";

// Single-page app that mounts @core's App with the desktop (Tauri) adapters.
// frontendDist for Tauri is the build output (dist).
export default defineConfig({
	plugins: [linguiMacroPlugin(), react(), tailwindcss()],
	resolve: {
		alias: {
			"@core": resolve(__dirname, "../core/src"),
		},
	},
	// Tauri owns the console; letting Vite clear it hides Rust panics and build errors.
	clearScreen: false,
	server: {
		// Fixed port: tauri.conf.json's devUrl points at it, so a fallback would strand the shell.
		port: 1420,
		strictPort: true,
		watch: {
			// src-tauri churns on every cargo build; watching it would loop the dev server.
			ignored: ["**/src-tauri/**"],
		},
	},
	// TAURI_ENV_* is how the shell tells the frontend its platform and debug state.
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		rollupOptions: {
			// Two documents in one bundle: the main vault window and the quick-access panel.
			// They are separate entries rather than routes because they are separate OS
			// windows, and the panel must not carry the whole app's boot cost to open.
			input: {
				main: resolve(__dirname, "index.html"),
				spotlight: resolve(__dirname, "spotlight.html"),
			},
		},
	},
});
