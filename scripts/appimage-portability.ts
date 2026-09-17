// Fixes what linuxdeploy bundles into the AppImage, then repacks and re-signs it.
// Why each rule: docs/desktop-port.md, "What the AppImage may and may not bundle".

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bundled copies that break the app on hosts newer or older than the builder. */
const DROP = [
	// Older than the user's Mesa, which then cannot start EGL at all (issue #100).
	"libwayland-client.so.0",
	// Wants GLIBC_2.36, which is above the floor the rest of the bundle holds. Nothing prints.
	"libcups.so.2",
	"libprintbackend-cups.so",
];

/** Host libraries linuxdeploy excludes that the bundle nonetheless needs. */
const ADD = [
	// Bundled pango calls harfbuzz 4.0+, so an older host's copy is a missing symbol at startup.
	"libharfbuzz.so.0",
];

const SEARCH = [
	"/usr/lib/x86_64-linux-gnu",
	"/usr/lib/aarch64-linux-gnu",
	"/usr/lib",
	"/usr/lib64",
];

/** `env` must carry the updater signing key, the same one `tauri build` signed with. */
export function makeAppImagePortable(bundleDir: string, env: NodeJS.ProcessEnv): void {
	const dir = join(bundleDir, "appimage");
	if (!existsSync(dir)) return;

	// The bundler empties this directory before every build, so one of each is this build's.
	const entries = readdirSync(dir);
	const appDirs = entries.filter((f) => f.endsWith(".AppDir"));
	const images = entries.filter((f) => f.endsWith(".AppImage"));
	if (appDirs.length !== 1 || images.length !== 1) {
		throw new Error(`expected one AppDir and one AppImage in ${dir}, found: ${entries.join(", ")}`);
	}
	const appDir = join(dir, appDirs[0] as string);
	const image = join(dir, images[0] as string);

	// A set, because linuxdeploy keeps a GTK module under the architecture directory and symlinks
	// it back up into usr/lib: two paths, one library, one line worth logging.
	const changes = new Set<string>();
	for (const name of DROP) {
		for (const found of find(appDir, name)) {
			rmSync(found);
			changes.add(`-${name}`);
		}
	}
	for (const name of ADD) {
		if (find(appDir, name).length > 0) continue;
		const source = SEARCH.map((d) => join(d, name)).find((p) => existsSync(p));
		if (!source) throw new Error(`${name} is not on this build host; the AppImage needs it`);
		copyFileSync(realpathSync(source), join(appDir, "usr/lib", name));
		changes.add(`+${name}`);
	}
	if (changes.size === 0) {
		console.log("AppImage bundle already as intended; left as built.");
		return;
	}

	// The packer tauri build just used, from Tauri's tool cache (`dirs::cache_dir()/tauri`).
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const packer = join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage");
	if (!existsSync(packer)) throw new Error(`no AppImage packer at ${packer}`);

	console.log(`repacking ${image}: ${[...changes].join(" ")}`);
	execFileSync(packer, ["--appdir", appDir], {
		stdio: "inherit",
		env: {
			...process.env,
			APPIMAGE_EXTRACT_AND_RUN: "1",
			ARCH: process.arch === "arm64" ? "aarch64" : "x86_64",
			OUTPUT: image,
		},
	});

	// The old .sig covers the old bytes. stdout is only the signature echoed back.
	execFileSync(
		"pnpm",
		["--filter", "@vault/platform-desktop", "exec", "tauri", "signer", "sign", image],
		{ stdio: ["ignore", "ignore", "inherit"], env },
	);
}

/**
 * Every copy of `name` under the AppDir: GTK's modules sit below an architecture directory, and
 * linuxdeploy symlinks them back up into usr/lib. lstat rather than stat, so a symlink is a match
 * to delete rather than a directory to descend into or a dangling path to throw on.
 */
function find(appDir: string, name: string): string[] {
	const out: string[] = [];
	const walk = (at: string): void => {
		for (const entry of readdirSync(at)) {
			const path = join(at, entry);
			if (lstatSync(path).isDirectory()) walk(path);
			else if (entry === name) out.push(path);
		}
	};
	walk(join(appDir, "usr/lib"));
	return out;
}
