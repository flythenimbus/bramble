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
		// happy-dom otherwise fetches external resources referenced by site
		// fixtures (e.g. reddit-login.html pulls redditstatic CSS and recaptcha
		// JS). CI has no network, so those aborted fetches surface as unhandled
		// errors and fail the run. Tests only assert on DOM structure, so disable
		// all resource loading and frame navigation; treat disabled loads as success
		// so they don't emit error events either.
		environmentOptions: {
			happyDOM: {
				settings: {
					disableJavaScriptEvaluation: true,
					disableJavaScriptFileLoading: true,
					disableCSSFileLoading: true,
					handleDisabledFileLoadingAsSuccess: true,
					navigation: {
						disableMainFrameNavigation: true,
						disableChildFrameNavigation: true,
					},
				},
			},
		},
	},
});
