#!/usr/bin/env node
// Launch a BUILT desktop app, as opposed to `dev:desktop` which runs one from source.
//
//   pnpm run:macos     the signed .app bundle
//   pnpm run:debian    install the .deb, then launch what the package manager installed
//   pnpm run:linux     the AppImage, run in place
//
// Three targets rather than one because they exercise genuinely different things. `dev:desktop`
// is the loop for looking at the UI; these are for the install-shaped questions it cannot answer:
// where files land, whether the tray and the desktop entry work, and whether the app knows a
// package manager owns it (`can_self_update`, which is false for the .deb and true for the
// AppImage).
//
// Each one runs the app attached, so its stdout lands in the terminal. On Linux that is the only
// place WebKitGTK's complaints show up, and the reason to prefer this over clicking the icon.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["macos", "debian", "linux"] as const;
type Target = (typeof TARGETS)[number];

const target = process.argv[2] as Target | undefined;
if (!target || !TARGETS.includes(target)) {
	console.error(`usage: node scripts/run-desktop.ts <${TARGETS.join("|")}>`);
	process.exit(1);
}

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const needsPlatform = (want: NodeJS.Platform, what: string) => {
	if (process.platform !== want) fail(`${what} needs ${want}; this is ${process.platform}.`);
};

/** The one file in a directory with this extension, or undefined. */
function artifact(dir: string, extension: string): string | undefined {
	const at = join(ROOT, dir);
	if (!existsSync(at)) return undefined;
	const found = readdirSync(at).find((f) => f.endsWith(extension));
	return found && join(at, found);
}

/** Inherit stdio so the app's own logging reaches the terminal, and pass the exit code on. */
function run(bin: string, argv: string[] = []) {
	const result = spawnSync(bin, argv, { stdio: "inherit" });
	process.exit(result.status ?? 0);
}

if (target === "macos") {
	needsPlatform("darwin", "run:macos");
	// A universal build lands under its triple, not in release/, so check there first: reading the
	// wrong one launches the previous aarch64 build without saying so.
	const bundles = "packages/platform-desktop/src-tauri/target";
	const app =
		[
			`${bundles}/universal-apple-darwin/release/bundle/macos/Bramble.app`,
			`${bundles}/release/bundle/macos/Bramble.app`,
		]
			.map((p) => join(ROOT, p))
			.find(existsSync) ?? fail("not built yet: pnpm build:macos");
	run("open", [app]);
}

if (target === "linux") {
	needsPlatform("linux", "run:linux");
	const image = artifact("dist-linux/appimage", ".AppImage") ?? fail("not built: pnpm build:linux");
	// Executability does not survive every way an artifact gets copied around, and the failure is
	// a bare "Permission denied" that says nothing about why.
	chmodSync(image, 0o755);
	console.log(`running ${image}\n`);
	run(image);
}

if (target === "debian") {
	needsPlatform("linux", "run:debian");
	const deb = artifact("dist-linux/deb", ".deb") ?? fail("not built: pnpm build:linux");

	// dpkg rather than apt: every rebuild carries the same version until a release bumps it, and
	// apt reads that as "already the newest version" and does nothing. The confusing part is that
	// it succeeds while installing your previous build.
	//
	// Killing a running instance first for the same class of reason: closing the window only hides
	// it to the tray, so without this you reinstall and then look at the old binary still running.
	console.log("stopping any running instance…");
	spawnSync("pkill", ["-f", "bramble-desktop"], { stdio: "ignore" });

	console.log(`installing ${deb} (sudo)…`);
	try {
		execFileSync("sudo", ["dpkg", "-i", deb], { stdio: "inherit" });
	} catch {
		fail("install failed. If it is a dependency error: sudo apt-get -f install");
	}

	console.log("\nlaunching the installed binary (not the one in target/)\n");
	run("bramble-desktop");
}
