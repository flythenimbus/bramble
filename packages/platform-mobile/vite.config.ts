import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Single-page app that mounts @core's App with the mobile (Capacitor) adapters.
// webDir for Capacitor is the build output (dist).
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@core": resolve(__dirname, "../core/src"),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
