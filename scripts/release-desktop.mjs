#!/usr/bin/env node
// Build and assemble a GitHub release for the desktop app: the .dmg people download, the .tar.gz
// the in-app updater downloads, and the latest.json that points at it.
//
// Usage:
//   pnpm package:desktop              build (universal) and assemble
//   pnpm package:desktop --aarch64    Apple Silicon only, for iterating
//   pnpm package:desktop --resume     assemble what is already built, no rebuild
//
// For a real release use `pnpm release desktop <version>`, which bumps, tags, publishes, and
// commits the manifest in the order that keeps the update channel honest. This is the packaging
// half of that, usable on its own.
//
// It builds rather than assuming a build, the way the other targets do. Assembling from whatever
// happened to be in the bundle directory is how a release ends up carrying an artifact from an
// older commit, and the signature in latest.json would still verify against it — the manifest
// would be internally consistent and simply describe the wrong software.
//
// The updater endpoint is this file on the website, so it IS the update channel. Getting it wrong
// does not break the download, it breaks updating for everyone already running the app, which is
// the failure nobody notices until it matters. It is served from bramble.sh rather than the
// GitHub release because `/releases/latest` means the newest release of ANY target, and this repo
// ships chromium, firefox and android from the same tag namespace — the next extension release
// would quietly point every desktop install at a 404.
//
// Reads what the build actually produced rather than reconstructing names, because the signature
// has to belong to the exact bytes being published.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const TARGET = "packages/platform-desktop/src-tauri/target";
const CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";
const PATCH = "packages/platform-desktop/src-tauri/tauri.local-update.conf.json";

const { version } = JSON.parse(readFileSync(CONF, "utf8"));

const args = process.argv.slice(2);
const resume = args.includes("--resume");
// Universal unless told otherwise, matching the build. cargo puts a --target build under
// target/<triple>/, so the two land in different places, and reading the wrong one is not an
// empty directory and an error: it is the OTHER build, published as though it were this one.
const universal = !args.includes("--aarch64");
const BUNDLE = universal
  ? join(TARGET, "universal-apple-darwin/release/bundle")
  : join(TARGET, "release/bundle");
// Set when `pnpm release desktop` drives this: the assets are already uploaded by then, so the
// upload instructions below would be telling you to do something you just did.
const quiet = args.includes("--quiet");

if (!resume) {
  // Inherited stdio, because the build wants a YubiKey PIN at the terminal and a swallowed
  // prompt looks exactly like a hang.
  console.log(`building Bramble ${version}${universal ? " (universal)" : ""}…`);
  try {
    execFileSync("pnpm", ["run", "build:desktop", ...(universal ? [] : ["--aarch64"])], {
      stdio: "inherit",
    });
  } catch {
    // The build already said why; repeating its output as a stack trace only buries it.
    console.error("\nbuild failed; nothing was assembled.");
    process.exit(1);
  }
}

/**
 * macOS arches an archive serves, as the updater names them.
 *
 * A universal archive runs on both, and its filename says neither: the bundler names it
 * `Bramble.app.tar.gz` exactly as it names an aarch64-only one. Keyed under one arch it would be
 * invisible to the other, and the updater errors with TargetNotFound rather than reporting no
 * update, so an Intel user would see a broken check rather than an update built for them.
 */
function platformKeys(file) {
  if (universal) return ["darwin-aarch64", "darwin-x86_64"];
  return [file.includes("x64") || file.includes("x86_64") ? "darwin-x86_64" : "darwin-aarch64"];
}

const macos = join(BUNDLE, "macos");
if (!existsSync(macos)) {
  console.error(
    `no bundle at ${macos}. Drop --resume to build it` +
      (universal ? "." : ", or drop --aarch64 if that is not what you built."),
  );
  process.exit(1);
}

// The local-update test build points the app at 127.0.0.1 and turns off the https requirement.
// Publishing one would ship an app that checks a machine that is not there, and would never
// update again — unfixable, since the fix would arrive over the channel that is broken. The
// endpoint is a plain string in the binary, so this catches it whatever produced the build.
const localEndpoint = existsSync(PATCH)
  ? JSON.parse(readFileSync(PATCH, "utf8")).plugins?.updater?.endpoints?.[0]
  : undefined;
if (localEndpoint) {
  const host = new URL(localEndpoint).host;
  for (const binary of ["Bramble.app/Contents/MacOS/bramble-desktop"]) {
    const path = join(macos, binary);
    if (existsSync(path) && readFileSync(path).includes(host)) {
      console.error(
        `${binary} was built against the local update endpoint (${host}).\n` +
          "That build must not be released: it would check a machine that is not there and could\n" +
          "never be updated afterwards. Rebuild without --config tauri.local-update.conf.json.",
      );
      process.exit(1);
    }
  }
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
  for (const key of platformKeys(archive))
    platforms[key] = {
      signature: readFileSync(join(macos, sig), "utf8").trim(),
      // Tags are `<version>-desktop` (the repo's shared namespace); the asset name is whatever
      // the bundler produced.
      url: `https://github.com/flythenimbus/bramble/releases/download/${version}-desktop/${archive}`,
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

const out = "website/public/desktop/latest.json";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`latest.json -> ${out}`);
for (const [key, value] of Object.entries(platforms)) {
  console.log(`  ${key}: ${value.url.split("/").pop()}`);
}
const dmgs = existsSync(join(BUNDLE, "dmg"))
  ? (await readdir(join(BUNDLE, "dmg"))).filter((f) => f.endsWith(".dmg"))
  : [];
if (!quiet) {
  console.log(`\nUpload to the ${version}-desktop release:`);
  for (const f of dmgs) console.log(`  ${join(BUNDLE, "dmg", f)}`);
  for (const a of archives) console.log(`  ${join(macos, a)}`);
  console.log(
    `\n${out} is the update channel; commit it AFTER the release assets exist, or apps read a` +
      "\nmanifest whose download 404s. `pnpm release desktop` does that ordering for you.",
  );
}
