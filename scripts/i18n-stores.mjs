#!/usr/bin/env node
// Translate the web store listings (Chrome Web Store + AMO) via local Ollama, or
// DeepSeek if DEEPSEEK_API_KEY is set. Source English lives in
// packages/platform-extension/store/<store>/en/*.txt; this fans it out to the other
// locales, idempotently (existing translations are kept). `i18n:native` runs this
// alongside every other surface; use this when only the store copy changed.

import { modelInfo } from "./i18n/ollama.mjs";
import { run as runStores } from "./i18n/store-listings.mjs";

console.log(`i18n store listings (${modelInfo})`);
runStores().catch((e) => {
	console.error(e);
	process.exit(1);
});
