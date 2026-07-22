// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build
export default defineConfig({
	site: "https://bramble.sh",
	// Emit flat files (/privacy.html, /support.html) rather than directories, so
	// the legacy bramble.sh/support.html URL keeps working. public/_redirects then
	// serves those files at the clean /privacy and /support paths (the canonical
	// URLs; see the page `path` props and Footer links).
	build: { format: "file" },
	vite: {
		plugins: [tailwindcss()],
	},
});
