#!/usr/bin/env node
// Build the desktop app's Linux artifacts (.deb, .rpm, AppImage) in a container, from any host.
//
// Usage:
//   pnpm run build:linux              both architectures, signed, for a release
//   pnpm run build:linux --amd64      one architecture, for iterating (or --arm64)
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
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKER_SHA256, PACKER_VERSION } from "./appimage-packer.ts";
import { signingKey } from "./desktop-signing-key.ts";
import { dockerProblem } from "./docker-available.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "bramble-linux-build";
const DOCKERFILE = "packages/platform-desktop/docker/linux-build.Dockerfile";
const OUT = join(ROOT, "dist-linux");

/**
 * Debian's names for the two architectures, which are also Docker's.
 *
 * Both, by default. The container inherits the host's architecture unless told otherwise, so a
 * release cut on an Apple Silicon Mac produced arm64 packages and nothing else, which is how
 * 0.3.0 shipped a Linux channel that most Linux desktops cannot install. Asking for one is for
 * iterating; a release wants both.
 */
const ARCHES = ["amd64", "arm64"] as const;
type Arch = (typeof ARCHES)[number];

/** Per architecture: cargo's target dir and pnpm's store are not portable between them, and one
 * shared volume would rebuild the world on every switch. */
const volumeFor = (arch: Arch) => `bramble-linux-workspace-${arch}`;

/** Where one architecture's bundles land before they are merged into dist-linux/. Kept between
 * runs: it is the record of which files that architecture owns, so the next build of it can
 * replace exactly those and leave the other architecture's alone. */
const stageFor = (arch: Arch) => join(OUT, `.stage-${arch}`);

const argv = process.argv.slice(2);
const unsigned = argv.includes("--unsigned");
const asked = ARCHES.filter((a) => argv.includes(`--${a}`));
const arches: Arch[] = asked.length > 0 ? asked : [...ARCHES];

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const run = (bin: string, argv: string[], env?: NodeJS.ProcessEnv): void => {
	execFileSync(bin, argv, { stdio: "inherit", cwd: ROOT, env: env ?? process.env });
};

/** Every file one level under `dir`, sorted: the bundles, not the AppDir tree beside them. */
const artifacts = (dir: string): string[] =>
	readdirSync(dir)
		.flatMap((kind) => {
			const at = join(dir, kind);
			if (!statSync(at).isDirectory()) return [at];
			return readdirSync(at)
				.map((file) => join(at, file))
				.filter((file) => statSync(file).isFile());
		})
		.sort();

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

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

// One shell rather than several `docker exec`s: a single layer of quoting, and `set -e` stops the
// rest the moment anything fails. Run with `bash -c`, NOT `-lc`: Debian's /etc/profile rewrites
// PATH for non-root users, and the container runs as the invoking user, so a login shell would
// throw away the image's own PATH and take cargo (/opt/cargo/bin) with it.
const script = [
	"set -euo pipefail",
	// Into a subdirectory we create, not into /work itself: the volume root is owned by root, and
	// `rsync -a` sets times on the destination root, which a non-owner cannot do however writable
	// the directory is.
	"mkdir -p /work/repo",
	// A cached target/ from a different base image is compiled against a different distribution's
	// glibc and webkit, and cargo cannot see that it changed: it would silently link a release out
	// of objects from the image we just moved off. The marker is a hash of the image's layers, so
	// any change to the image invalidates it and nothing else does.
	'if [ "$(cat /work/.base-image 2>/dev/null)" != "$BRAMBLE_BASE_IMAGE" ]; then' +
		" echo 'base image changed: rebuilding from scratch';" +
		" rm -rf /work/repo/packages/platform-desktop/src-tauri/target;" +
		" fi",
	'printf %s "$BRAMBLE_BASE_IMAGE" > /work/.base-image',
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
	// Only the bundles: the rest of target/ is gigabytes of intermediate objects. Clearing /out
	// first is safe now that it is this architecture's staging directory rather than dist-linux
	// itself, which used to mean a second architecture deleted the first one's packages.
	"rm -rf /out/*",
	"cp -a packages/platform-desktop/src-tauri/target/release/bundle/. /out/",
].join("\n");

mkdirSync(OUT, { recursive: true });

for (const arch of arches) {
	const platform = `linux/${arch}`;
	const stage = stageFor(arch);
	// What this architecture produced last time, which is exactly what it may replace in
	// dist-linux/. Anything else there belongs to the other architecture or to an older version
	// somebody still wants.
	if (existsSync(stage)) {
		for (const kind of readdirSync(stage)) {
			for (const file of readdirSync(join(stage, kind))) {
				rmSync(join(OUT, kind, file), { recursive: true, force: true });
			}
		}
		rmSync(stage, { recursive: true, force: true });
	}
	mkdirSync(stage, { recursive: true });

	console.log(`\nbuilding the image for ${platform} (${IMAGE}:${arch})…`);
	// Tagged per architecture so the two do not overwrite each other, and --platform on both the
	// build and the run: off the host's own architecture this is emulated, which is slow but is
	// the difference between a release that covers Linux and one that covers a third of it.
	// The packer pin travels as build args rather than living in the Dockerfile too: one version
	// and digest, in appimage-packer.ts, for the image and for every build outside it.
	const packerArch = arch === "arm64" ? "aarch64" : "x86_64";
	run("docker", [
		"build",
		"--platform",
		platform,
		"-f",
		DOCKERFILE,
		"-t",
		`${IMAGE}:${arch}`,
		"--build-arg",
		`LINUXDEPLOY_APPIMAGE_VERSION=${PACKER_VERSION}`,
		"--build-arg",
		`LINUXDEPLOY_APPIMAGE_SHA256=${PACKER_SHA256[packerArch]}`,
		"packages/platform-desktop/docker",
	]);

	// The image's layers, not its id: `docker build` stamps a fresh id on every run even when every
	// layer was cached, so keying on the id would wipe the build cache each time and recompile the
	// world. Layer digests are the filesystem the build actually runs on, and only move when it does.
	const layers = execFileSync(
		"docker",
		["image", "inspect", "--format", "{{json .RootFS.Layers}}", `${IMAGE}:${arch}`],
		{ encoding: "utf8" },
	).trim();

	console.log(`building the ${arch} bundles…`);
	run(
		"docker",
		[
			"run",
			"--rm",
			"--platform",
			platform,
			"--user",
			`${uid}:${gid}`,
			"-v",
			`${ROOT}:/src:ro`,
			"-v",
			`${volumeFor(arch)}:/work`,
			"-v",
			`${stage}:/out`,
			// `-e NAME` without a value forwards it from OUR environment rather than putting it in argv.
			// argv is world-readable in /proc and gets echoed back in any error message, so the value form
			// would leak the updater key to every process on the machine and into CI logs.
			"-e",
			"TAURI_SIGNING_PRIVATE_KEY",
			"-e",
			"TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
			"-e",
			"BRAMBLE_BASE_IMAGE",
			`${IMAGE}:${arch}`,
			"bash",
			"-c",
			script,
		],
		{
			...process.env,
			BRAMBLE_BASE_IMAGE: createHash("sha256").update(layers).digest("hex"),
			TAURI_SIGNING_PRIVATE_KEY: key.trim(),
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
		},
	);

	// Into the flat layout the release script and the updater manifest both read: dist-linux/deb,
	// dist-linux/rpm, dist-linux/appimage, with every architecture's packages side by side. Tauri
	// puts the architecture in each filename, so nothing collides.
	//
	// Copied in-process rather than by shelling out to `cp -a`: these paths come from a directory
	// listing and from where the repository happens to sit, and interpolating either into a shell
	// string is a quoting bug waiting for the first filename with something clever in it.
	for (const kind of readdirSync(stage)) {
		mkdirSync(join(OUT, kind), { recursive: true });
		cpSync(join(stage, kind), join(OUT, kind), {
			recursive: true,
			force: true,
			preserveTimestamps: true,
		});
	}
}

console.log(`\nartifacts in ${OUT}:`);
for (const file of artifacts(OUT)) console.log(`  ${file}`);
if (unsigned) {
	console.log(
		"\nsigned with a throwaway key: fine for testing an install, NOT publishable — the updater\n" +
			"in every installed app verifies against the real public key and would reject this.",
	);
}
