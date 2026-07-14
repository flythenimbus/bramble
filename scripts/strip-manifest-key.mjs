// Remove the `key` field from a built dist manifest before it's packaged for release.
//   node scripts/strip-manifest-key.mjs <path/to/manifest.json>
//
// The source chromium manifest carries a `key` to pin the UNPACKED dev extension ID so the OAuth
// redirect (https://<id>.chromiumapp.org/) matches production during local testing. But the
// Chrome Web Store REJECTS a store package that contains a `key` ("You must update your item with
// a crx package"), and the published item's ID comes from the store while the signed .crx gets
// its ID from the signature — so the shipped package must not carry it. Unpacked dev builds use
// `build:chromium` (no strip) and keep the key; the release bundle runs this strip.

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
