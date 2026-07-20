// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build
export default defineConfig({
	site: "https://bramble.sh",
	// Emit flat files (/privacy.html, /support.html) rather than directories, so
	// the existing bramble.sh/support.html URL keeps working after the cut-over.
	build: { format: "file" },
	vite: {
		plugins: [tailwindcss()],
	},
});
