// Bump the mobile app's marketing version across iOS + Android in one shot. Both stores
// ship the same product, so they share one marketing version (the extension versions
// separately via scripts/release.ts). Build numbers are NOT touched: each platform
// computes them at build time (iOS fastlane timestamp, Android versionCode timestamp).
// Usage: pnpm run bump:mobile <version>   e.g. pnpm run bump:mobile 1.1.0

import { readFileSync, writeFileSync } from "node:fs";

const PBXPROJ = "packages/platform-mobile/ios/App/App.xcodeproj/project.pbxproj";
const GRADLE = "packages/platform-mobile/android/app/build.gradle";
const PKG = "packages/platform-mobile/package.json";

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};

// Accept 0.1.0 or v0.1.0; 1-3 dot-separated ints (iOS CFBundleShortVersionString caps at 3).
const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) fail("missing version. usage: pnpm run bump:mobile <version>  (e.g. 1.1.0)");
if (!/^\d+(\.\d+){0,2}$/.test(version))
	fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

// Compute all edits before writing, so a regex that doesn't match aborts cleanly
// instead of leaving the three files half-updated.
const edits: { path: string; next: string }[] = [];

// iOS: every target config (app + AutoFillProbe extension, Debug + Release) shares the
// marketing version, so replace all of them. CFBundleVersion stays $(CURRENT_PROJECT_VERSION).
const pbx = readFileSync(PBXPROJ, "utf8");
let pbxCount = 0;
const pbxNext = pbx.replace(/MARKETING_VERSION = [^;]+;/g, () => {
	pbxCount++;
	return `MARKETING_VERSION = ${version};`;
});
if (pbxCount < 1) fail(`no MARKETING_VERSION found in ${PBXPROJ}`);
edits.push({ path: PBXPROJ, next: pbxNext });

// Android: versionName is the marketing version; versionCode is the build-time timestamp.
const gradle = readFileSync(GRADLE, "utf8");
let gradleCount = 0;
const gradleNext = gradle.replace(/versionName "[^"]*"/, () => {
	gradleCount++;
	return `versionName "${version}"`;
});
if (gradleCount !== 1) fail(`expected exactly one versionName in ${GRADLE}, found ${gradleCount}`);
edits.push({ path: GRADLE, next: gradleNext });

// package.json: not read at runtime (App.getInfo reads the native bundle), kept in sync
// as the greppable source of truth.
const pkg = readFileSync(PKG, "utf8");
let pkgCount = 0;
const pkgNext = pkg.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
	pkgCount++;
	return `${p1}${version}${p2}`;
});
if (pkgCount !== 1) fail(`expected exactly one "version" in ${PKG}, found ${pkgCount}`);
edits.push({ path: PKG, next: pkgNext });

for (const e of edits) writeFileSync(e.path, e.next);

console.log(`bumped mobile marketing version to ${version}:`);
console.log(`  iOS MARKETING_VERSION (${pbxCount} target configs), Android versionName, ${PKG}`);
console.log("build numbers untouched (iOS fastlane timestamp / Android versionCode).");
console.log("next: commit, then `pnpm run ios:beta` (TestFlight) and build the Android APK.");
