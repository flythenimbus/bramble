import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// Source English lives inline in the components (the macro arg is the message id).
// `extract` pulls strings into per-locale .po catalogs under core/src/locales;
// `compile` turns them into runtime JS. New locales: add the code here, re-extract.
export default defineConfig({
	sourceLocale: "en",
	locales: ["en", "de", "es", "fr", "pt-BR", "it"],
	catalogs: [
		{
			path: "<rootDir>/packages/core/src/locales/{locale}/messages",
			include: ["<rootDir>/packages/core/src"],
		},
	],
	format: formatter({ lineNumbers: false }),
});
