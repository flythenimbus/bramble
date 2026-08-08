/*
 * Build the native-messaging proxy and stage it where Tauri's bundler expects a sidecar.
 *
 * The proxy has to end up in Contents/MacOS, beside the app binary, because that is where
 * manifest.rs looks for it: the host manifest names an absolute path, resolved as a sibling of
 * the running executable. In development both live in target/debug and it works by accident of
 * layout; in a bundle something has to put it there, and that something is Tauri's
 * `externalBin`, which copies each entry into Contents/MacOS.
 *
 * The target-triple suffix is Tauri's convention for choosing the right binary per platform.
 * It strips the suffix when bundling, so `bramble-proxy-aarch64-apple-darwin` here lands as
 * `bramble-proxy` there, which is the name the manifest expects.
 *
 * Run automatically by beforeBuildCommand; safe to run by hand.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauri = join(here, "..", "src-tauri");

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
	.split("\n")
	.find((line) => line.startsWith("host: "))
	?.slice("host: ".length)
	.trim();

if (!triple) {
	console.error("stage-proxy: could not read the host target triple from rustc -vV");
	process.exit(1);
}

const staged = join(tauri, "binaries");
const target = join(staged, `bramble-proxy-${triple}`);
mkdirSync(staged, { recursive: true });

// The placeholder that breaks the build-order circularity lives in src-tauri/build.rs, so
// that a bare `cargo test` works too and not just a build driven from here.

// Release, to match what `tauri build` produces for the app itself. A debug proxy in a release
// bundle would work but ship a much larger binary with debug info in it.
execFileSync("cargo", ["build", "--release", "--bin", "bramble-proxy"], {
	cwd: tauri,
	stdio: "inherit",
});

copyFileSync(join(tauri, "target", "release", "bramble-proxy"), target);
console.log(`stage-proxy: staged bramble-proxy-${triple}`);
