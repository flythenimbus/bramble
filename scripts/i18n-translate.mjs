#!/usr/bin/env node
// Translate the Lingui web/extension catalogs (.po) via local Ollama. This is the
// `i18n:translate` step between `lingui extract` and `lingui compile`. For the
// native surfaces (fastlane, Android, iOS) use scripts/i18n-all.mjs.

import { modelInfo } from "./i18n/ollama.mjs";
import { run as runPo } from "./i18n/po.mjs";

console.log(`i18n translate (${modelInfo})`);
runPo().catch((e) => {
	console.error(e);
	process.exit(1);
});
