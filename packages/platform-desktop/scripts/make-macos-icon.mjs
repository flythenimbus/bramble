/*
 * Build src-tauri/icons/icon.icns from the shared 1024px app icon.
 *
 * macOS does NOT mask app icons. iOS does, which is why icon/ios/AppIcon~ios-marketing.png
 * is a full-bleed square and looks right on a phone; dropped into a .icns unchanged it shows
 * up in the Dock as a hard square next to every other app's rounded one. Every macOS app
 * ships its own rounded artwork, so we have to bake the shape in here.
 *
 * Apple's icon grid (Big Sur onwards): a 824x824 body centred on a 1024x1024 transparent
 * canvas, corner radius 185.4. The 100px margin is not padding to taste, it is what keeps
 * this icon optically the same size as its neighbours in the Dock.
 *
 * The PNGs are shaped too, not just the .icns, because `tauri dev` runs a bare executable
 * rather than a .app bundle: macOS never reads the .icns there, and Tauri sets the Dock icon
 * at runtime from an embedded PNG. Shaping only the .icns would leave the whole development
 * loop looking wrong. Linux reads the same PNGs and renders them as-is, so it inherits the
 * rounding, which is fine.
 *
 * The Windows art (icon.ico, Square*Logo.png) is deliberately left square: Windows does not
 * mask either, but its convention is full-bleed, and the 100px margin would just make the
 * icon look shrunken in the taskbar.
 *
 * Run: pnpm icons:macos   (from packages/platform-desktop)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const SOURCE = resolve(import.meta.dirname, "../../../icon/ios/AppIcon~ios-marketing.png");
const OUT_DIR = resolve(import.meta.dirname, "../src-tauri/icons");

const CANVAS = 1024;
const BODY = 824;
const RADIUS = 185.4;
const INSET = (CANVAS - BODY) / 2;

/** The sizes an .iconset must contain; iconutil rejects the bundle if any are missing. */
const ICONSET = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];

// Round the corners by masking with a rounded rect (dest-in keeps only what the mask covers).
const mask = Buffer.from(
	`<svg width="${BODY}" height="${BODY}"><rect width="${BODY}" height="${BODY}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);

const body = await sharp(SOURCE)
	.resize(BODY, BODY, { fit: "cover" })
	.composite([{ input: mask, blend: "dest-in" }])
	.png()
	.toBuffer();

const shaped = await sharp({
	create: {
		width: CANVAS,
		height: CANVAS,
		channels: 4,
		background: { r: 0, g: 0, b: 0, alpha: 0 },
	},
})
	.composite([{ input: body, left: INSET, top: INSET }])
	.png()
	.toBuffer();

const staging = mkdtempSync(join(tmpdir(), "bramble-icns-"));
const iconset = join(staging, "icon.iconset");
try {
	execFileSync("mkdir", ["-p", iconset]);
	await Promise.all(
		ICONSET.map(([name, size]) =>
			sharp(shaped).resize(size, size).png().toFile(join(iconset, name)),
		),
	);
	execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(OUT_DIR, "icon.icns")]);
	console.log(`icon.icns (${BODY}/${CANVAS} body, r=${RADIUS})`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}

// The PNGs tauri.conf.json's bundle.icon points at, plus icon.png as the canonical one.
// These are what the Dock reads in dev and what Linux packaging ships.
const PNGS = [
	["icon.png", 512],
	["128x128@2x.png", 256],
	["128x128.png", 128],
	["64x64.png", 64],
	["32x32.png", 32],
];

await Promise.all(
	PNGS.map(([name, size]) => sharp(shaped).resize(size, size).png().toFile(join(OUT_DIR, name))),
);
console.log(`shaped ${PNGS.map(([n]) => n).join(", ")}`);
