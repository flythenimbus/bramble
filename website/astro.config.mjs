// @ts-check
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build
export default defineConfig({
	site: "https://bramble.sh",
	// Emit flat files (/privacy.html, /support.html) rather than directories.
	// Cloudflare Pages serves these at the clean /privacy and /support paths (the
	// canonical URLs; see the page `path` props and Footer links) and redirects the
	// legacy .html URLs to them, so both keep working.
	build: { format: "file" },
	integrations: [mdx()],
	markdown: {
		shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, wrap: true },
	},
	vite: {
		plugins: [tailwindcss()],
	},
});
