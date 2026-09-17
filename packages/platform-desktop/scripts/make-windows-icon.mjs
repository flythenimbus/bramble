/*
 * Build src-tauri/icons/icon.ico from the shared 1024px app icon, masked to a circle.
 *
 * The shared source is a full-bleed square: a white mark on a black field, which is what iOS
 * and Android want because both mask the icon themselves. Windows masks nothing, so dropped in
 * unchanged it renders as a hard black tile in the taskbar and the Start menu, with the round
 * mark sitting inside it. Against the round and shaped icons beside it that reads as a
 * placeholder rather than a logo.
 *
 * So the shape is baked in here, the same argument as make-macos-icon.mjs and a different
 * shape: macOS wants Apple's squircle with a margin, Windows gets the circle the mark already
 * is. The mask is the full inscribed circle rather than an inset one, because Windows does not
 * round or shrink what it is given and a margin would just make the icon look small.
 *
 * Only icon.ico is written. The PNGs in that directory are the macOS and Linux artwork and are
 * squircle-shaped by the other script; the Square*Logo.png files are MSIX art that the NSIS
 * installer never reads. Generating the whole set here would quietly undo macOS.
 *
 * Run: pnpm icons:windows   (from packages/platform-desktop)
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const SOURCE = resolve(import.meta.dirname, "../../../icon/ios/AppIcon~ios-marketing.png");
const OUT_DIR = resolve(import.meta.dirname, "../src-tauri/icons");

const CANVAS = 1024;
/** Full-bleed: the circle touches all four edges. */
const RADIUS = CANVAS / 2;

const staging = mkdtempSync(join(tmpdir(), "bramble-windows-icon-"));

try {
	const round = join(staging, "app-icon.png");

	// The mark's outermost details (the small triangles) sit well inside this radius, so the
	// only thing the mask removes is empty black corner. Verified against the 1024px source:
	// the furthest detail is ~340px from centre against a 512px radius.
	const mask = Buffer.from(
		`<svg width="${CANVAS}" height="${CANVAS}">` +
			`<circle cx="${CANVAS / 2}" cy="${CANVAS / 2}" r="${RADIUS}" fill="#fff"/>` +
			"</svg>",
	);

	await sharp(SOURCE)
		.resize(CANVAS, CANVAS, { fit: "cover" })
		// `dest-in` keeps the source only where the mask is opaque, which leaves the corners
		// transparent rather than white. A white corner would be worse than the black one.
		.composite([{ input: mask, blend: "dest-in" }])
		.png()
		.toFile(round);

	// Tauri's own generator, pointed at a scratch directory. It writes the whole platform set
	// and only the .ico is taken: this is the one format nothing else in the repo can encode,
	// and adding an ICO writer to do it by hand would be a dependency for no gain.
	execFileSync(
		"pnpm",
		["exec", "tauri", "icon", round, "-o", staging],
		{ cwd: resolve(import.meta.dirname, ".."), stdio: "inherit" },
	);

	copyFileSync(join(staging, "icon.ico"), join(OUT_DIR, "icon.ico"));
	console.log(`make-windows-icon: wrote ${join(OUT_DIR, "icon.ico")}`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
