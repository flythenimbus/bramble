import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// node by default; DOM tests opt in per-file with `@vitest-environment
// happy-dom` (convention: `*.dom.test.ts`).
export default defineConfig({
	resolve: {
		alias: {
			"@core": resolve(__dirname, "../core/src"),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
