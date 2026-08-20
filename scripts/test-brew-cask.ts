#!/usr/bin/env node
// Check the Homebrew cask against the live release, in a container.
//
//   pnpm run test:brew
//
// The third of the packaging tests, after test:apt (installs the published .deb the way a Debian
// user does) and test:nix (builds the flake from source the way a NixOS user does). This one is
// the odd one out: Homebrew refuses to install a cask on Linux, so it cannot finish the job on the
// maintainer's Debian machine.
//
// It runs everything up to that line anyway, which turns out to be most of the value: style,
// audit, a livecheck against the real GitHub API, and a real download whose checksum is verified.
// The install, Gatekeeper and the zap round trip are the only parts that need a Mac.
//
// On macOS it runs against the local brew and skips Docker entirely. Not for speed: four of the
// audit's checks mount the disk image to look inside the .app, which only macOS can do, so the
// container is a strictly weaker run of the same script. Docker is what makes the check possible
// on the machine that has no Homebrew.
//
// The expected version comes from the update manifest rather than the working tree, because the
// cask has to point at a release that exists, not at whatever version is being developed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerProblem } from "./docker-available.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "homebrew/brew:latest";
const CASK = "packages/platform-desktop/homebrew/bramble.rb";
const SCRIPT = "e2e/brew/cask-test.sh";
const MANIFEST = "website/public/desktop/latest.json";

// Only the container path needs Docker, and a Mac with brew never takes it.
const nativeBrew = process.platform === "darwin" && hasBrew();
if (!nativeBrew) {
	const dockerIssue = dockerProblem();
	if (dockerIssue) {
		console.error(dockerIssue);
		process.exit(1);
	}
}

function hasBrew() {
	try {
		execFileSync("brew", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const { version } = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8")) as { version: string };
console.log(`the released desktop version is ${version} (${MANIFEST})`);

if (nativeBrew) {
	try {
		execFileSync("bash", [join(ROOT, SCRIPT), version, join(ROOT, CASK)], {
			stdio: "inherit",
			cwd: ROOT,
		});
	} catch {
		console.error("\n\x1b[1;31mFAILED\x1b[0m: brew cask");
		process.exit(1);
	}
	process.exit(0);
}

try {
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			// Read-only: the script copies the cask into a throwaway tap inside the container, and
			// nothing it does should be able to reach back into the checkout.
			"-v",
			`${ROOT}/${CASK}:/cask/bramble.rb:ro`,
			"-v",
			`${ROOT}/${SCRIPT}:/cask-test.sh:ro`,
			IMAGE,
			"bash",
			"/cask-test.sh",
			version,
		],
		{ stdio: "inherit", cwd: ROOT },
	);
} catch {
	console.error("\n[1;31mFAILED[0m: brew cask");
	process.exit(1);
}
