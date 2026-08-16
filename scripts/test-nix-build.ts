#!/usr/bin/env node
// Build the flake in a container and assert what it produced.
//
//   pnpm run test:nix
//
// The counterpart to test:apt. That one installs the published .deb the way a Debian user does;
// this one builds from source the way a NixOS user does, which is a different set of failures:
// a Nix build has no network, so anything the build reaches for at build time fails here and
// nowhere else, and the result has to carry its own dependencies rather than borrowing the
// host's.
//
// The nix store is a named volume rather than a fresh layer per run. A cold build compiles every
// crate in the tree; without the volume this test would take half an hour every time and nobody
// would run it.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "nixos/nix";
const STORE_VOLUME = "bramble-nix-store";

try {
	execFileSync("docker", ["version"], { stdio: "ignore" });
} catch {
	console.error("docker not found, or its daemon is not running.");
	process.exit(1);
}

// Created on first use; `docker volume create` is idempotent.
execFileSync("docker", ["volume", "create", STORE_VOLUME], { stdio: "ignore" });

try {
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			"-v",
			`${STORE_VOLUME}:/nix`,
			// Read-only, and the script copies out of it: a Nix build needs a writable tree, and
			// writing into the host checkout from a container is how a build ends up depending on
			// state nobody can reproduce.
			"-v",
			`${ROOT}:/src:ro`,
			IMAGE,
			"bash",
			"/src/e2e/nix/build-test.sh",
		],
		{ stdio: "inherit", cwd: ROOT },
	);
} catch {
	console.error("\n[1;31mFAILED[0m: nix build");
	process.exit(1);
}
