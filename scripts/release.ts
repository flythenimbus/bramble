// Cut a release entirely from your machine: bump the version, build (+ sign), tag,
// push, then publish a GitHub release with the artifacts attached.
//
// Usage:
//   pnpm run release chromium <version>   e.g. pnpm run release chromium 1.0.0
//   pnpm run release android  <version>   e.g. pnpm run release android  1.1.0
//
// Tags as <version>-<platform> (e.g. 1.0.0-chromium, 1.1.0-android). Publishing the
// release fires .github/workflows/release.yml, which only verifies the artifact made it
// onto the release; CI never builds or signs. Signing setup lives in docs/release-signing.md.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};
const run = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const capture = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

const [platform, rawVersion] = process.argv.slice(2);
// Accept either 0.1.0 or v0.1.0; the stored version is the bare numeric form.
const version = (rawVersion ?? "").replace(/^v/, "");
if (!platform) fail("usage: pnpm run release <chromium|android> <version>");
if (!version) fail(`missing version. usage: pnpm run release ${platform} <version>`);

if (platform === "android") releaseAndroid(version);
else releaseExtension(platform, version);

// ----- extension: Chrome Web Store, signed .crx -----

function releaseExtension(target: string, version: string) {
	const MANIFESTS: Record<string, string> = {
		chromium: "packages/manifests/chromium/manifest.json",
	};
	const DIST = "packages/platform-extension";
	const manifest = MANIFESTS[target];
	if (!manifest)
		fail(`unknown platform "${target}". supported: ${Object.keys(MANIFESTS).join(", ")}, android`);

	// Chrome manifest versions: 1-4 dot-separated integers, 0-65535, no leading zeros.
	const PART = /^(0|[1-9]\d{0,4})$/;
	const parts = version.split(".");
	if (parts.length > 4 || parts.some((p) => !PART.test(p) || Number(p) > 65535))
		fail(`invalid version "${version}". want 1-4 ints, each 0-65535 (e.g. 0.1.0)`);

	const tag = `${version}-${target}`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	gate();

	const before = readFileSync(manifest, "utf8");
	let replaced = 0;
	const after = before.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
		replaced++;
		return `${p1}${version}${p2}`;
	});
	if (replaced !== 1)
		fail(`expected exactly one "version" field in ${manifest}, found ${replaced}`);

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = after !== before;
	if (bumped) writeFileSync(manifest, after);

	try {
		run("pnpm run wasm:build");
		run("pnpm --filter @vault/platform-extension run bundle");
		run("pnpm run sign");
	} catch {
		fail(`build or signing failed; run \`git checkout ${manifest}\` to undo the bump`);
	}

	const zip = `${DIST}/bramble.zip`;
	const crx = `${DIST}/bramble.crx`;
	if (!existsSync(zip) || !existsSync(crx)) fail("expected bramble.zip and a signed bramble.crx");

	commitTagPush(bumped, manifest, `chore(release): ${target} ${version}`, tag, branch);

	const title = `${target.charAt(0).toUpperCase()}${target.slice(1)} Extension ${version}`;
	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const crxAsset = join(stage, `bramble_${target}_${version}.crx`);
	const zipAsset = join(stage, `bramble_${target}_${version}.zip`);
	copyFileSync(crx, crxAsset);
	copyFileSync(zip, zipAsset);
	try {
		publish(tag, title, [crxAsset, zipAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag}: signed bramble_${target}_${version}.crx attached to the release.`,
	);
}

// ----- android: GitHub-released, signed .apk + SHA256SUMS -----

function releaseAndroid(version: string) {
	const ANDROID = "packages/platform-mobile/android";
	const BUILD_GRADLE = `${ANDROID}/app/build.gradle`;
	const APK = `${ANDROID}/app/build/outputs/apk/release/app-release.apk`;

	// versionName is the marketing version; 1-3 dot-separated ints (matches bump:mobile).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	const tag = `${version}-android`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// Signing inputs. The keystore is age+YubiKey encrypted (docs/release-signing.md);
	// passwords come from the env so no plaintext secret is written to the repo.
	const ksAge =
		process.env.ANDROID_KEYSTORE_AGE ?? join(HOME, ".config/bramble/android-release-keystore.age");
	const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
	if (!existsSync(ksAge))
		fail(
			`encrypted keystore not at ${ksAge} (override ANDROID_KEYSTORE_AGE). See docs/release-signing.md.`,
		);
	if (!storePassword)
		fail("set ANDROID_KEYSTORE_PASSWORD (and ANDROID_KEY_PASSWORD if it differs)");
	const keyAlias = process.env.ANDROID_KEY_ALIAS ?? "bramble";
	const keyPassword = process.env.ANDROID_KEY_PASSWORD ?? storePassword;
	for (const bin of ["age", "age-plugin-yubikey"])
		if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
	const java21 = resolveJava21();

	gate();

	// Bump versionName (the build-time versionCode timestamp is untouched).
	const before = readFileSync(BUILD_GRADLE, "utf8");
	let replaced = 0;
	const after = before.replace(/versionName "[^"]*"/, () => {
		replaced++;
		return `versionName "${version}"`;
	});
	if (replaced !== 1)
		fail(`expected exactly one versionName in ${BUILD_GRADLE}, found ${replaced}`);
	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = after !== before;
	if (bumped) writeFileSync(BUILD_GRADLE, after);

	// Build native inputs, then a signed release APK. The keystore is decrypted into a 0700
	// temp dir and wiped in finally; the plaintext keystore never touches the repo.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-android-"));
	const ksFile = join(tmp, "release.jks");
	const idFile = join(tmp, "id.txt");
	try {
		run("pnpm run core:build");
		run("pnpm run ffi:build:android");
		run("pnpm --filter @vault/platform-mobile exec cap sync android");

		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		execFileSync("age", ["-d", "-i", idFile, "-o", ksFile, ksAge], { stdio: "inherit" });
		execFileSync(
			join(ANDROID, "gradlew"),
			["-p", ANDROID, "assembleRelease", `-Porg.gradle.java.installations.paths=${java21}`],
			{
				stdio: "inherit",
				env: {
					...process.env,
					JAVA_HOME: java21,
					ANDROID_KEYSTORE_FILE: ksFile,
					ANDROID_KEYSTORE_PASSWORD: storePassword,
					ANDROID_KEY_ALIAS: keyAlias,
					ANDROID_KEY_PASSWORD: keyPassword,
				},
			},
		);
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		fail(
			`build/signing failed (${(e as Error).message}); \`git checkout ${BUILD_GRADLE}\` to undo`,
		);
	}
	rmSync(tmp, { recursive: true, force: true });
	if (!existsSync(APK)) fail(`expected a signed APK at ${APK} (did signing apply?)`);

	// Print the signing cert SHA-256 so you can confirm it matches the published pin.
	const apksigner = findApksigner();
	if (apksigner) {
		const out = execFileSync(apksigner, ["verify", "--print-certs", APK], { encoding: "utf8" });
		const m = out.match(/SHA-256 digest:\s*([0-9a-f]{64})/i);
		console.log(`\nAPK signing cert SHA-256: ${m?.[1] ?? "(run apksigner verify --print-certs)"}`);
	}

	// Stage the asset under its release name + a SHA256SUMS for integrity checks.
	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const apkName = `bramble_android_${version}.apk`;
	const apkAsset = join(stage, apkName);
	const sumsAsset = join(stage, "SHA256SUMS");
	copyFileSync(APK, apkAsset);
	writeFileSync(
		sumsAsset,
		`${createHash("sha256").update(readFileSync(APK)).digest("hex")}  ${apkName}\n`,
	);

	commitTagPush(bumped, BUILD_GRADLE, `chore(release): android ${version}`, tag, branch);
	try {
		publish(tag, `Bramble Android ${version}`, [apkAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(`\nreleased ${tag}: signed ${apkName} + SHA256SUMS attached to the release.`);
}

// ----- shared helpers -----

// Gate on the same lint + typecheck + tests CI enforces on main, before touching
// anything, so a tag never ships from a red tree. typecheck matters because the
// bundlers strip types without checking them.
function gate() {
	try {
		run("pnpm run ci:check");
		run("pnpm run typecheck");
		run("pnpm run test");
	} catch {
		fail("lint, typecheck, or tests failed; fix them before releasing");
	}
}

function commitTagPush(
	bumped: boolean,
	file: string,
	message: string,
	tag: string,
	branch: string,
) {
	if (bumped) {
		run(`git add ${file}`);
		run(`git commit -m ${JSON.stringify(message)}`);
	} else {
		console.log(`${file} already at this version; tagging current commit without a release commit`);
	}
	run(`git tag ${tag}`);
	run(`git push origin ${branch}`);
	run(`git push origin ${tag}`);
}

// Draft -> upload -> publish, so the `release: published` event fires only once the
// signed artifacts are attached (CI verifies them on that event).
function publish(tag: string, title: string, assets: string[]) {
	run(`gh release create ${tag} --draft --generate-notes --title ${JSON.stringify(title)}`);
	run(`gh release upload ${tag} ${assets.join(" ")}`);
	run(`gh release edit ${tag} --draft=false`);
}

const has = (bin: string) => {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

// The Capacitor Android plugins need a JDK 21 toolchain; the system default is often 17.
// Resolution order: an already-21 JAVA_HOME, `java_home -v 21` (verified), then the JBR.
function resolveJava21(): string {
	const isJdk21 = (home: string) => {
		try {
			return /JAVA_VERSION="?21/.test(readFileSync(join(home, "release"), "utf8"));
		} catch {
			return false;
		}
	};
	if (process.env.JAVA_HOME && isJdk21(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
	try {
		const p = capture("/usr/libexec/java_home -v 21");
		if (p && isJdk21(p)) return p;
	} catch {
		// fall through to the bundled JBR
	}
	const candidates = [
		"/Applications/Android Studio.app/Contents/jbr/Contents/Home",
		"/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
		join(HOME, "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
	];
	return (
		candidates.find((c) => existsSync(join(c, "bin", "java"))) ??
		fail("no JDK 21 found (Android Studio bundles one); set JAVA_HOME to a JDK 21")
	);
}

function findApksigner(): string | null {
	const sdk =
		process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(HOME, "Library/Android/sdk");
	const buildTools = join(sdk, "build-tools");
	try {
		const dirs = readdirSync(buildTools).sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true }),
		);
		for (const d of dirs.reverse()) {
			const p = join(buildTools, d, "apksigner");
			if (existsSync(p)) return p;
		}
	} catch {
		// no SDK / build-tools on PATH
	}
	return null;
}
