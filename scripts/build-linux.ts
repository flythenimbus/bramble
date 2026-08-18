#!/usr/bin/env node
// Build the desktop app's Linux artifacts (.deb, .rpm, AppImage) in a container, from any host.
//
// Usage:
//   pnpm run build:linux              signed, for a release (needs the updater key)
//   pnpm run build:linux --unsigned   a throwaway key, for iterating
//
// Why a container: a Debian package has to be built on Debian, and the maintainer's machine is a
// Mac. Why this shape in particular:
//
// - **The repository is copied in, not built in place.** The obvious `-v $PWD:/work` would have
//   the container's `pnpm install` overwrite node_modules with Linux binaries, breaking the host's
//   dev environment until it is reinstalled. So the tree is mounted read-only and rsynced into a
//   named volume, minus node_modules and target, which also keeps rebuilds incremental.
// - **It runs as the invoking user**, so artifacts are owned by them rather than by root.
// - **Signing stays outside.** The updater key is passed through the environment for the one
//   artifact that needs it (only the AppImage self-updates) and never written to disk, exactly as
//   the macOS build does. The APT repository's GPG key never comes near a container: it lives on a
//   YubiKey, and Docker Desktop on macOS cannot pass a USB device through, so the repository is
//   signed and published from the host. See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signingKey } from "./desktop-signing-key.ts";
import { dockerProblem } from "./docker-available.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "bramble-linux-build";
const DOCKERFILE = "packages/platform-desktop/docker/linux-build.Dockerfile";
const OUT = join(ROOT, "dist-linux");
/** Persists between runs, so cargo and pnpm do not start from nothing every time. */
const WORKSPACE_VOLUME = "bramble-linux-workspace";

const unsigned = process.argv.slice(2).includes("--unsigned");

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const run = (bin: string, argv: string[], env?: NodeJS.ProcessEnv): void => {
	execFileSync(bin, argv, { stdio: "inherit", cwd: ROOT, env: env ?? process.env });
};

const dockerIssue = dockerProblem();
if (dockerIssue) fail(`${dockerIssue}\nSee docs/release-signing.md.`);

/**
 * A key for this build only. The bundler refuses to emit updater artifacts unsigned, and making a
 * local build wait on a YubiKey touch would defeat the point of `--unsigned`. Written to a 0700
 * scratch dir and read straight back, because the generator has no stdout mode.
 */
function throwawayKey(): string {
	const tmp = mkdtempSync(join(tmpdir(), "bramble-linux-key-"));
	try {
		const path = join(tmp, "throwaway.key");
		execFileSync(
			"pnpm",
			[
				"--filter",
				"@vault/platform-desktop",
				"exec",
				"tauri",
				"signer",
				"generate",
				"-w",
				path,
				"-p",
				"",
			],
			{ cwd: ROOT, stdio: "ignore" },
		);
		return readFileSync(path, "utf8");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const key = unsigned ? throwawayKey() : signingKey(fail);
if (!key) {
	fail(
		"no updater signing key. Set TAURI_SIGNING_PRIVATE_KEY, or plug in the YubiKey.\n" +
			"For a local build that nobody will install, use --unsigned.",
	);
}

console.log(`building the image (${IMAGE})…`);
run("docker", ["build", "-f", DOCKERFILE, "-t", IMAGE, "packages/platform-desktop/docker"]);

mkdirSync(OUT, { recursive: true });

// One shell rather than several `docker exec`s: a single layer of quoting, and `set -e` stops the
// rest the moment anything fails.
const script = [
	"set -euo pipefail",
	// Into a subdirectory we create, not into /work itself: the volume root is owned by root, and
	// `rsync -a` sets times on the destination root, which a non-owner cannot do however writable
	// the directory is.
	"mkdir -p /work/repo",
	// --delete so a file removed on the host does not linger in the volume and get built anyway.
	"rsync -a --delete" +
		" --exclude .git --exclude node_modules --exclude target --exclude dist" +
		" --exclude dist-chromium --exclude dist-firefox --exclude dist-linux" +
		" /src/ /work/repo/",
	"cd /work/repo",
	"corepack pnpm install --frozen-lockfile",
	// `build:macos` despite running on Debian: it is one host-target build script, named for the
	// platform it is normally invoked from, and on Linux it bundles the .deb, .rpm and AppImage.
	"corepack pnpm run build:macos",
	// Only the bundles: the rest of target/ is gigabytes of intermediate objects.
	"rm -rf /out/*",
	"cp -a packages/platform-desktop/src-tauri/target/release/bundle/. /out/",
].join("\n");

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

console.log("building the Linux bundles…");
run(
	"docker",
	[
		"run",
		"--rm",
		"--user",
		`${uid}:${gid}`,
		"-v",
		`${ROOT}:/src:ro`,
		"-v",
		`${WORKSPACE_VOLUME}:/work`,
		"-v",
		`${OUT}:/out`,
		// `-e NAME` without a value forwards it from OUR environment rather than putting it in argv.
		// argv is world-readable in /proc and gets echoed back in any error message, so the value form
		// would leak the updater key to every process on the machine and into CI logs.
		"-e",
		"TAURI_SIGNING_PRIVATE_KEY",
		"-e",
		"TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
		IMAGE,
		"bash",
		"-lc",
		script,
	],
	{
		...process.env,
		TAURI_SIGNING_PRIVATE_KEY: key.trim(),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
	},
);

console.log(`\nartifacts in ${OUT}:`);
run("bash", ["-lc", `find ${JSON.stringify(OUT)} -maxdepth 2 -type f | sort`]);
if (unsigned) {
	console.log(
		"\nsigned with a throwaway key: fine for testing an install, NOT publishable — the updater\n" +
			"in every installed app verifies against the real public key and would reject this.",
	);
}
