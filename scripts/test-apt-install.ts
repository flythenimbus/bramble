#!/usr/bin/env node
// End-to-end test of the published APT repository: install Bramble the way a user does, in a
// container that has never seen it.
//
// Usage:
//   pnpm run test:apt                    debian:12 and ubuntu:22.04
//   pnpm run test:apt ubuntu:24.04 ...   specific images
//
// This is the only test that exercises what a user actually runs: the snippet from the website,
// against the live repository, on a distribution we did not build on. It covers three things
// nothing else does.
//
// - **The signature, as apt validates it.** Our own checks verify the chain by hand; apt has its
//   own opinion about what a valid `InRelease` is, and only apt's opinion decides whether anyone
//   can install.
// - **The glibc floor.** The package is built on Ubuntu 22.04 so it installs on distributions
//   older than the builder. That claim is only worth anything if something checks it, so the
//   default images are the oldest we say we support.
// - **Where the sidecar lands.** `manifest.rs` resolves the browser proxy as a sibling of the
//   running executable, and where Tauri's externalBin ends up in a .deb was an open question.
//
// It tests the LIVE repository, deliberately: the failure mode this catches is a publish that went
// wrong (an unsynced index, a stale key, a pool file that 404s), which a local build cannot show.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "e2e/apt/install-test.sh";

// The oldest we claim to support, which is the point: building on 22.04 sets the floor, and a
// package that only installs on the builder's own distribution is not a package.
const DEFAULT_IMAGES = ["debian:12", "ubuntu:22.04"];

const images = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = images.length > 0 ? images : DEFAULT_IMAGES;

try {
	execFileSync("docker", ["version"], { stdio: "ignore" });
} catch {
	console.error("docker not found, or its daemon is not running.");
	process.exit(1);
}

const failed: string[] = [];
for (const image of targets) {
	console.log(`\n[1m### ${image}[0m`);
	try {
		execFileSync(
			"docker",
			[
				"run",
				"--rm",
				// The script is mounted rather than copied in, so editing it does not mean rebuilding
				// anything, and the container needs no image of ours at all: these are stock images,
				// which is what makes this a test of the repository rather than of our tooling.
				"-v",
				`${ROOT}/${SCRIPT}:/install-test.sh:ro`,
				image,
				"bash",
				"/install-test.sh",
				image,
			],
			{ stdio: "inherit", cwd: ROOT },
		);
	} catch {
		failed.push(image);
	}
}

console.log("");
if (failed.length > 0) {
	console.error(`[1;31mFAILED[0m on: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`[1;32mAll passed[0m: ${targets.join(", ")}`);
