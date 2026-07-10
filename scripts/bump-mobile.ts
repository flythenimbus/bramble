// Bump the mobile app's marketing version for one or both native platforms:
//   pnpm run bump:ios <version>      e.g. pnpm run bump:ios 1.1.0      (iOS MARKETING_VERSION only)
//   pnpm run bump:android <version>  e.g. pnpm run bump:android 1.1.0  (Android versionName only)
//   pnpm run bump:mobile <version>   e.g. pnpm run bump:mobile 1.1.0   (both, plus package.json)
// iOS and Android can carry independent marketing versions; bump:mobile moves them together and
// also updates package.json (the greppable source of truth for the shared version). Build numbers
// are NOT touched: each platform computes them at build time (iOS fastlane timestamp, Android
// versionCode timestamp). The browser extension versions separately via scripts/release.ts.

import { readFileSync, writeFileSync } from "node:fs";

const PBXPROJ = "packages/platform-mobile/ios/App/App.xcodeproj/project.pbxproj";
const GRADLE = "packages/platform-mobile/android/app/build.gradle";
const PKG = "packages/platform-mobile/package.json";

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};

const PLATFORMS = ["ios", "android", "mobile"] as const;
type Platform = (typeof PLATFORMS)[number];
const isPlatform = (p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p);

// The pnpm script fixes argv[2] (ios/android/mobile); the caller appends the version as argv[3].
const platform = process.argv[2] ?? "";
if (!isPlatform(platform))
	fail(`usage: pnpm run bump:<ios|android|mobile> <version>  (bad platform "${platform}")`);

// Accept 1.1.0 or v1.1.0; 1-3 dot-separated ints (iOS CFBundleShortVersionString caps at 3).
const version = (process.argv[3] ?? "").replace(/^v/, "");
if (!version) fail(`missing version. usage: pnpm run bump:${platform} <version>  (e.g. 1.1.0)`);
if (!/^\d+(\.\d+){0,2}$/.test(version))
	fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

const doIos = platform === "ios" || platform === "mobile";
const doAndroid = platform === "android" || platform === "mobile";
const doPkg = platform === "mobile"; // the shared source of truth; only when both move together

// Compute all edits before writing, so a regex that doesn't match aborts cleanly instead of
// leaving files half-updated.
const edits: { path: string; next: string; note: string }[] = [];

if (doIos) {
	// Every target config (app + AutoFillProbe extension, Debug + Release) shares the marketing
	// version, so replace all of them. CFBundleVersion stays $(CURRENT_PROJECT_VERSION).
	const pbx = readFileSync(PBXPROJ, "utf8");
	let n = 0;
	const next = pbx.replace(/MARKETING_VERSION = [^;]+;/g, () => {
		n++;
		return `MARKETING_VERSION = ${version};`;
	});
	if (n < 1) fail(`no MARKETING_VERSION found in ${PBXPROJ}`);
	edits.push({ path: PBXPROJ, next, note: `iOS MARKETING_VERSION (${n} target configs)` });
}

if (doAndroid) {
	// versionName is the marketing version; versionCode is the build-time timestamp.
	const gradle = readFileSync(GRADLE, "utf8");
	let n = 0;
	const next = gradle.replace(/versionName "[^"]*"/, () => {
		n++;
		return `versionName "${version}"`;
	});
	if (n !== 1) fail(`expected exactly one versionName in ${GRADLE}, found ${n}`);
	edits.push({ path: GRADLE, next, note: "Android versionName" });
}

if (doPkg) {
	// Not read at runtime (App.getInfo reads the native bundle); kept in sync as the greppable
	// source of truth for the shared version, so only bump:mobile touches it.
	const pkg = readFileSync(PKG, "utf8");
	let n = 0;
	const next = pkg.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
		n++;
		return `${p1}${version}${p2}`;
	});
	if (n !== 1) fail(`expected exactly one "version" in ${PKG}, found ${n}`);
	edits.push({ path: PKG, next, note: PKG });
}

for (const e of edits) writeFileSync(e.path, e.next);

console.log(`bumped ${platform} marketing version to ${version}:`);
for (const e of edits) console.log(`  ${e.note}`);
console.log("build numbers untouched (iOS fastlane timestamp / Android versionCode).");
