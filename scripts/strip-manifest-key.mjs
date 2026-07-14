// Remove the `key` field from a built dist manifest before it's packaged for release.
//   node scripts/strip-manifest-key.mjs <path/to/manifest.json>
//
// The source chromium manifest carries a `key` to pin the UNPACKED dev extension ID so the OAuth
// redirect (https://<id>.chromiumapp.org/) matches production during local testing. That dev key
// is NOT the production signing key: the released item's ID comes from the store, and the signed
// .crx gets its ID from the CWS signing key's signature. Shipping the stale dev `key` would leave
// a mismatched key inside the packaged manifest, so the release bundle strips it. Unpacked dev
// builds use `build:chromium` (no strip) and keep the key.

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/strip-manifest-key.mjs <manifest.json>");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(file, "utf8"));
if (manifest.key === undefined) process.exit(0); // nothing to strip
delete manifest.key;
writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`stripped "key" from ${file}`);
