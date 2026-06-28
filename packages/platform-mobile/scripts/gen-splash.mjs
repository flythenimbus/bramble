// Regenerates the native splash assets: a full-black screen with the white Bramble
// mark + "Bramble" wordmark centered (the "<icon> Bramble" lockup). Source mark is
// the app icon's white foreground (icon/android/.../ic_launcher_foreground.png).
//
// Run: node scripts/gen-splash.mjs   (from packages/platform-mobile)
// Re-run after changing the logo source or the lockup constants below.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..");
const repo = join(mobile, "..", "..");

const BG = "#000000";
const FG = "#ffffff";
// Lockup geometry, in the lockup's own pixel space (then scaled per target).
const LOGO_H = 440; // logo mark height
const GAP = 120; // space between mark and wordmark
const TEXT_H = 220; // visual height of the "Bramble" wordmark
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
// Lockup width as a fraction of the target's shorter side (keeps it proportional
// on both portrait phones and the square iOS launch image).
const FRAC = 0.6;

const logoSrc = join(repo, "icon/android/res/mipmap-xxxhdpi/ic_launcher_foreground.png");
if (!existsSync(logoSrc)) throw new Error(`missing logo source: ${logoSrc}`);

// Tight white mark: trim the adaptive safe-zone padding, scale to LOGO_H.
const logo = await sharp(logoSrc)
	.trim()
	.resize({ height: LOGO_H })
	.png()
	.toBuffer();
const logoMeta = await sharp(logo).metadata();

// Wordmark rendered as SVG text, then trimmed to its ink bounds and scaled to TEXT_H.
const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="600">
  <text x="0" y="450" font-family="${FONT}" font-size="420" font-weight="600" fill="${FG}">Bramble</text>
</svg>`;
const text = await sharp(Buffer.from(textSvg))
	.trim()
	.resize({ height: TEXT_H })
	.png()
	.toBuffer();
const textMeta = await sharp(text).metadata();

// Compose the lockup on a transparent canvas: [mark][gap][wordmark], vertically centered.
const lockH = Math.max(logoMeta.height, textMeta.height);
const lockW = logoMeta.width + GAP + textMeta.width;
const lockup = await sharp({
	create: { width: lockW, height: lockH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
	.composite([
		{ input: logo, left: 0, top: Math.round((lockH - logoMeta.height) / 2) },
		{ input: text, left: logoMeta.width + GAP, top: Math.round((lockH - textMeta.height) / 2) },
	])
	.png()
	.toBuffer();

async function render(width, height, out) {
	const target = Math.min(width, height) * FRAC;
	const scaledW = Math.min(Math.round(target), Math.round(width * 0.88));
	const piece = await sharp(lockup).resize({ width: scaledW }).png().toBuffer();
	const pm = await sharp(piece).metadata();
	const canvas = await sharp({
		create: { width, height, channels: 4, background: BG },
	})
		.composite([
			{
				input: piece,
				left: Math.round((width - pm.width) / 2),
				top: Math.round((height - pm.height) / 2),
			},
		])
		.png()
		.toBuffer();
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, canvas);
	console.log(`  ${out.replace(mobile + "/", "")}  ${width}x${height}`);
}

// iOS: single universal launch image (1x/2x/3x all reference the same 2732 square).
const ios = join(mobile, "ios/App/App/Assets.xcassets/Splash.imageset");
console.log("iOS:");
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
	await render(2732, 2732, join(ios, name));
}

// Android: density buckets, portrait + landscape, plus the default drawable.
console.log("Android:");
const androidRes = join(mobile, "android/app/src/main/res");
const port = { hdpi: [480, 800], mdpi: [320, 480], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
const land = { hdpi: [800, 480], mdpi: [480, 320], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] };
for (const [d, [w, h]] of Object.entries(port)) await render(w, h, join(androidRes, `drawable-port-${d}/splash.png`));
for (const [d, [w, h]] of Object.entries(land)) await render(w, h, join(androidRes, `drawable-land-${d}/splash.png`));
await render(480, 320, join(androidRes, "drawable/splash.png"));

console.log("done");
