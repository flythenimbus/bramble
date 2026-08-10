#!/usr/bin/env node
// Assemble a GitHub release for the desktop app: the .dmg people download, the .tar.gz the
// in-app updater downloads, and the latest.json that points at it.
//
// The updater endpoint is the `latest.json` asset on the latest release, so this file IS the
// update channel. Getting it wrong does not break the download, it breaks updating for everyone
// already running the app, which is the failure nobody notices until it matters.
//
// Reads what the build actually produced rather than reconstructing names, because the signature
// has to belong to the exact bytes being published.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const BUNDLE = "packages/platform-desktop/src-tauri/target/release/bundle";
const CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";

const { version } = JSON.parse(readFileSync(CONF, "utf8"));

/** macOS arch as the updater names it: `darwin-aarch64` / `darwin-x86_64`. */
function platformKey(file) {
  return file.includes("x64") || file.includes("x86_64") ? "darwin-x86_64" : "darwin-aarch64";
}

const macos = join(BUNDLE, "macos");
if (!existsSync(macos)) {
  console.error(`no bundle at ${macos}. Run pnpm build:desktop first.`);
  process.exit(1);
}

const files = await readdir(macos);
const archives = files.filter((f) => f.endsWith(".app.tar.gz"));
if (archives.length === 0) {
  console.error(
    "no .app.tar.gz in the bundle. createUpdaterArtifacts must be true in tauri.conf.json,\n" +
      "and TAURI_SIGNING_PRIVATE_KEY* must be set so the archive gets signed.",
  );
  process.exit(1);
}

const platforms = {};
for (const archive of archives) {
  const sig = `${archive}.sig`;
  if (!files.includes(sig)) {
    // An unsigned archive would be rejected by every installed app, so publishing it is worse
    // than publishing nothing: the release looks complete and updating silently fails.
    console.error(`${archive} has no ${sig}. Was the signing key set for this build?`);
    process.exit(1);
  }
  platforms[platformKey(archive)] = {
    signature: readFileSync(join(macos, sig), "utf8").trim(),
    // Tags are `v<version>`; the asset name is whatever the bundler produced.
    url: `https://github.com/flythenimbus/bramble/releases/download/v${version}/${archive}`,
  };
}

const manifest = {
  version,
  // Release notes come from the GitHub release body; the updater shows this instead, so keep it
  // short rather than duplicating a changelog nobody reads in a modal.
  notes: `Bramble ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = join(BUNDLE, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`latest.json -> ${out}`);
for (const [key, value] of Object.entries(platforms)) {
  console.log(`  ${key}: ${value.url.split("/").pop()}`);
}
const dmgs = existsSync(join(BUNDLE, "dmg"))
  ? (await readdir(join(BUNDLE, "dmg"))).filter((f) => f.endsWith(".dmg"))
  : [];
console.log("\nUpload to the v" + version + " release:");
for (const f of dmgs) console.log(`  ${join(BUNDLE, "dmg", f)}`);
for (const a of archives) console.log(`  ${join(macos, a)}`);
console.log(`  ${out}`);
console.log(
  "\nlatest.json must be an asset on the LATEST release, or installed apps check a stale one.",
);
