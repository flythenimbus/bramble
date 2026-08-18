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
 * A universal build needs more than the host slice. Tauri lipos the APP binary itself, but a
 * sidecar is copied, not built, so whatever is staged here is what ships: staging only the host
 * arch produces a universal app whose proxy is Apple Silicon only, and the browser link would
 * simply not work on an Intel Mac.
 *
 * Tauri does not combine them for us. It lipos the app's MAIN binary and nothing else, and the
 * proxy is both a [[bin]] in this crate and an externalBin, so a universal build wants it in two
 * places: `binaries/bramble-proxy-universal-apple-darwin` for the sidecar copy, and
 * `target/universal-apple-darwin/release/bramble-proxy` for the binary copy. Missing either one
 * fails at the bundling step, after everything has been compiled twice.
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
mkdirSync(staged, { recursive: true });

// The placeholder that breaks the build-order circularity lives in src-tauri/build.rs, so
// that a bare `cargo test` works too and not just a build driven from here.

/**
 * Build the proxy for one target and return the binary's path.
 *
 * Release, to match what `tauri build` produces for the app itself. A debug proxy in a release
 * bundle would work but ship a much larger binary with debug info in it.
 */
function build(forTriple) {
	const args = ["build", "--release", "--bin", "bramble-proxy"];
	if (forTriple) args.push("--target", forTriple);
	execFileSync("cargo", args, { cwd: tauri, stdio: "inherit" });
	// cargo writes under target/<triple>/ whenever a target is in play, whether it came from our
	// flag or from the environment. Nix sets CARGO_BUILD_TARGET even for a native build, so
	// assuming target/release/ here looked for a binary that was one directory away.
	const dir = forTriple ?? process.env.CARGO_BUILD_TARGET ?? "";
	const root = process.env.CARGO_TARGET_DIR ?? join(tauri, "target");
	return join(root, ...(dir ? [dir] : []), "release", "bramble-proxy");
}

// Set by build-macos.ts when it passes --target universal-apple-darwin. Read from our own
// side rather than guessed from Tauri's environment, so it cannot silently stop being true.
if (process.env.BRAMBLE_UNIVERSAL) {
	const slices = [];
	for (const [forTriple, arch] of [
		["aarch64-apple-darwin", "arm64"],
		["x86_64-apple-darwin", "x86_64"],
	]) {
		const built = build(forTriple);
		// build.rs writes an EMPTY placeholder for whatever triple is being compiled, to break the
		// circularity of a sidecar living in the crate that declares it. That placeholder is
		// indistinguishable from a real sidecar to the bundler, so check this is the real thing,
		// and the arch it claims to be, before a release can carry it.
		const info = execFileSync("lipo", ["-info", built], { encoding: "utf8" });
		if (!info.includes(arch)) {
			console.error(`stage-proxy: the ${forTriple} proxy is not ${arch}:\n  ${info.trim()}`);
			process.exit(1);
		}
		copyFileSync(built, join(staged, `bramble-proxy-${forTriple}`));
		slices.push(built);
	}

	const fat = join(staged, "bramble-proxy-universal-apple-darwin");
	execFileSync("lipo", ["-create", "-output", fat, ...slices], { stdio: "inherit" });

	// The same binary where the bundler looks for this crate's own bins. Tauri lipos only the
	// main one, so for a multi-bin crate this is the gap nothing else fills.
	const universalDir = join(tauri, "target", "universal-apple-darwin", "release");
	mkdirSync(universalDir, { recursive: true });
	copyFileSync(fat, join(universalDir, "bramble-proxy"));

	console.log("stage-proxy: staged bramble-proxy for arm64, x86_64 and universal");
} else {
	copyFileSync(build(null), join(staged, `bramble-proxy-${triple}`));
	console.log(`stage-proxy: staged bramble-proxy-${triple}`);
}
