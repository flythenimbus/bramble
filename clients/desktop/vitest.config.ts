import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Merged rather than written fresh: the tests need the same `@core` alias and Lingui transform the
// app build uses, and a standalone config would quietly drop both.
//
// The timeout is not because anything here is slow. Every one of these files mocks its way down to
// plain objects, but the FIRST test in a file pays to pull the module graph through vite: ~930ms
// locally against ~12ms for every test after it. CI runs roughly five times slower, which lands
// that one test on the 5s default and turns a transform cost into a failure that looks like a hang.
export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			testTimeout: 20_000,
			hookTimeout: 20_000,
		},
	}),
);
