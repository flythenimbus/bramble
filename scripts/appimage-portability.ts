// Fixes what linuxdeploy bundles into the AppImage, then repacks and re-signs it.
// Why each rule: docs/desktop-port.md, "What the AppImage may and may not bundle".

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { packerMatchesPin, packerPath } from "./appimage-tools.ts";

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
	// WebKit's Skia is built against this one's headers. 2.13 changed the color glyph structs, so a
	// newer host's copy overruns Skia's stack on the first COLRv1 emoji and kills the page.
	"libfreetype.so.6",
];

// The bundled FreeType cannot read COLRv1 fonts (Fedora's Noto Color Emoji is one), which leaves
// every emoji blank, the pairing SAS included. So the build host's CBDT copy goes in, and a hook
// points fontconfig at a config that draws emoji with it and nothing else.
const EMOJI_FONT = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf";
const FONT_DIR = "usr/share/bramble/fonts";
const FONTS_CONF = "usr/share/bramble/fonts.conf";
const HOOK = "bramble-fontconfig.sh";

// The bundled font is tagged at scan time and accepted by that tag, because a file glob in
// acceptfont does not protect a font from a pattern in rejectfont.
const FONTS_CONF_XML = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
	<include ignore_missing="yes">/etc/fonts/fonts.conf</include>
	<dir prefix="relative">fonts</dir>
	<match target="scan">
		<test name="file" compare="contains"><string>/${FONT_DIR}/</string></test>
		<edit name="foundry" mode="assign"><string>bramble</string></edit>
	</match>
	<selectfont>
		<acceptfont><pattern><patelt name="foundry"><string>bramble</string></patelt></pattern></acceptfont>
		<rejectfont><pattern><patelt name="color"><bool>true</bool></patelt></pattern></rejectfont>
	</selectfont>
</fontconfig>
`;

// Without the host's own fonts.conf to include there would be no text fonts at all.
const HOOK_SH = `#! /usr/bin/env bash

if [ -z "\${FONTCONFIG_FILE:-}" ] && [ -f /etc/fonts/fonts.conf ]; then
	export FONTCONFIG_FILE="$APPDIR/${FONTS_CONF}"
fi
`;

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
	bundleEmojiFont(appDir, changes);
	if (changes.size === 0) {
		console.log("AppImage bundle already as intended; left as built.");
		return;
	}

	// The pinned packer, put there by ensureTools before the bundler ran (appimage-tools.ts).
	// Warned about rather than refused if it has changed underneath: tauri fetches into the same
	// cache, so this says the bundle was packed by something other than the pin, which is worth
	// knowing without failing a build over a packer that still works.
	const packer = packerPath();
	if (!existsSync(packer)) throw new Error(`no AppImage packer at ${packer}`);
	if (!packerMatchesPin())
		console.warn(`warning: ${packer} is not the pinned build; tauri replaced it`);

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

/** The emoji font, its fontconfig file, and the AppRun line that sources the hook selecting it. */
function bundleEmojiFont(appDir: string, changes: Set<string>): void {
	const font = join(appDir, FONT_DIR, basename(EMOJI_FONT));
	if (!existsSync(font)) {
		if (!existsSync(EMOJI_FONT)) {
			throw new Error(`${EMOJI_FONT} is not on this build host (fonts-noto-color-emoji)`);
		}
		mkdirSync(join(appDir, FONT_DIR), { recursive: true });
		copyFileSync(EMOJI_FONT, font);
		writeFileSync(join(appDir, FONTS_CONF), FONTS_CONF_XML);
		changes.add(`+${basename(EMOJI_FONT)}`);
	}

	// linuxdeploy's AppRun sources each hook by name, so a new one needs its own line.
	const appRun = join(appDir, "AppRun");
	const script = readFileSync(appRun, "utf8");
	const source = `source "$this_dir"/apprun-hooks/"${HOOK}"`;
	if (script.includes(source)) return;
	const exec = 'exec "$this_dir"/AppRun.wrapped';
	if (!script.includes(exec)) throw new Error(`no \`${exec}\` in ${appRun} to hook in front of`);
	writeFileSync(join(appDir, "apprun-hooks", HOOK), HOOK_SH, { mode: 0o755 });
	writeFileSync(appRun, script.replace(exec, `${source}\n\n${exec}`));
	changes.add(`+${HOOK}`);
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
