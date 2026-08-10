// Cut a release entirely from your machine: bump the version, build (+ sign), tag,
// push, then publish a GitHub release with the artifacts attached.
//
// Usage:
//   pnpm run release chromium <version|patch|minor|major>   e.g. 1.0.0, or `patch` to bump
//   pnpm run release firefox  <version|patch|minor|major>
//   pnpm run release android  <version|patch|minor|major> [--resume]  (--resume = sign the apk the
//                                                                      container already built)
//   pnpm run release ios      <version|patch|minor|major> [--ipa]   (--ipa = dry-run IPA, no upload/tag)
//   pnpm run release desktop  <version|patch|minor|major> [--universal]
//
// The version arg is an explicit version (1.2.0 / v1.2.0) or a semver bump keyword
// (patch/minor/major) that increments the SELECTED target's current version. Targets version
// independently, so `android patch` and `chromium patch` can land on different numbers.
//
// Tags as <version>-<platform> (e.g. 1.0.0-chromium, 1.0.0-firefox, 1.1.0-android, 1.1.0-ios).
// chromium/firefox/android publish a GitHub release; publishing fires
// .github/workflows/release.yml, which only verifies the artifact made it onto the release (CI
// never builds or signs). chromium packs a locally-signed .crx; firefox uploads to AMO and
// attaches the Mozilla-signed .xpi it returns. ios has no GitHub release: the binary goes to
// TestFlight via fastlane, and you submit for App Store review manually in App Store Connect.
// android is special: it builds in the F-Droid-matching container (docker-compose android-repro,
// needs Docker) so the APK is byte-reproducible, then signs the container's unsigned output on the
// host with the YubiKey. Signing setup lives in docs/release-signing.md.
// desktop publishes a GitHub release AND commits the updater manifest to the website, in that
// order — the manifest is the live update channel, so it must never name artifacts that are not
// there yet.

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
import { basename, join } from "node:path";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const HOME = process.env.HOME ?? "";

/** Desktop version lives in the Tauri config; the updater manifest is served off the website. */
const DESKTOP_CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";
const DESKTOP_MANIFEST = "website/public/desktop/latest.json";
/** Branch deploy-website.yml builds from; the manifest is only live once that runs. */
const WEBSITE_BRANCH = "main";

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};
const run = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const capture = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [platform, rawVersion] = argv.filter((a) => !a.startsWith("--"));
if (!platform)
	fail(
		"usage: pnpm run release <chromium|firefox|android|ios|desktop> <version|patch|minor|major>",
	);
if (!rawVersion)
	fail(`missing version. usage: pnpm run release ${platform} <version|patch|minor|major>`);

// The version arg is either an explicit version (0.1.0 or v0.1.0, stored bare) or a semver bump
// keyword (patch/minor/major) that increments THIS target's current version. Each target versions
// independently, so a bump reads that target's own manifest/gradle/pbxproj.
const bumpKind = ["patch", "minor", "major"].includes(rawVersion)
	? (rawVersion as "patch" | "minor" | "major")
	: null;
const version = bumpKind
	? nextVersion(currentVersion(platform), bumpKind)
	: rawVersion.replace(/^v/, "");

if (platform === "android") releaseAndroid(version, flags.has("--resume"));
else if (platform === "ios") releaseIos(version, flags.has("--ipa"));
else if (platform === "firefox") releaseFirefox(version);
else if (platform === "desktop") releaseDesktop(version, flags.has("--universal"));
else releaseExtension(platform, version);

// ----- extension: Chrome Web Store, signed .crx -----

function releaseExtension(target: string, version: string) {
	const MANIFESTS: Record<string, string> = {
		chromium: "packages/manifests/chromium/manifest.json",
	};
	const DIST = "packages/platform-extension";
	const manifest = MANIFESTS[target];
	if (!manifest)
		fail(
			`unknown platform "${target}". supported: ${Object.keys(MANIFESTS).join(", ")}, android, ios`,
		);

	// Chrome manifest versions: 1-4 dot-separated integers, 0-65535, no leading zeros.
	const PART = /^(0|[1-9]\d{0,4})$/;
	const parts = version.split(".");
	if (parts.length > 4 || parts.some((p) => !PART.test(p) || Number(p) > 65535))
		fail(`invalid version "${version}". want 1-4 ints, each 0-65535 (e.g. 0.1.0)`);

	const tag = `${version}-${target}`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// Chrome Web Store publish prereq, checked before the slow gate + build so a missing
	// credential fails fast. sign-cws.ts uploads + publishes with the service account.
	const cwsAge =
		process.env.CWS_SERVICE_ACCOUNT_AGE ?? join(HOME, ".config/bramble/cws-service-account.age");
	if (!process.env.CWS_SERVICE_ACCOUNT_JSON && !existsSync(cwsAge))
		fail(
			`no Chrome Web Store credentials: set CWS_SERVICE_ACCOUNT_JSON, or provide ${cwsAge} (override CWS_SERVICE_ACCOUNT_AGE). See docs/release-signing.md.`,
		);
	const cwsKeyAge = process.env.CWS_KEY_AGE ?? join(HOME, ".config/bramble/cws-signing-key.age");
	if (!process.env.CWS_KEY_PEM && !existsSync(cwsKeyAge))
		fail(
			`no Chrome Web Store signing key: set CWS_KEY_PEM, or provide ${cwsKeyAge} (override CWS_KEY_AGE). See docs/release-signing.md.`,
		);

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
		run("pnpm --filter @vault/platform-extension run bundle:chromium");
		// Decrypt BOTH CWS secrets (signing key + service account) in one YubiKey session, then hand
		// the plaintexts to sign/sign:cws via env so neither prompts for its own touch. Back-to-back
		// decrypts share the PIN + cached touch, so it's a single tap; the crx3 pack that used to sit
		// between the separate `sign`/`sign:cws` touches blew past the ~15s cache window.
		const clearCwsSecrets = primeCwsSecrets(cwsKeyAge, cwsAge);
		try {
			run("pnpm run sign");
			// Upload + publish to the Chrome Web Store (goes to CWS review, then live). Runs before
			// commit/tag/push so a store failure aborts the release cleanly. Consumes the version at
			// the store, like the Firefox/AMO path.
			run("pnpm run sign:cws");
		} finally {
			clearCwsSecrets();
		}
	} catch {
		fail(
			`build, signing, or Chrome Web Store publish failed; run \`git checkout ${manifest}\` to undo the bump`,
		);
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
	// SHA256SUMS over the GitHub-hosted .crx/.zip (integrity for direct/unpacked
	// installs; the Chrome Web Store re-signs, so store bytes won't match). Mirrors
	// the android branch.
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(
		sumsAsset,
		[crxAsset, zipAsset]
			.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${basename(f)}\n`)
			.join(""),
	);
	try {
		publish(tag, title, [crxAsset, zipAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag}: published to the Chrome Web Store (in review) + signed bramble_${target}_${version}.crx + SHA256SUMS attached to the GitHub release.`,
	);
}

// ----- firefox: submitted listed to AMO; GitHub release carries the source .zip + SHA256SUMS -----

function releaseFirefox(version: string) {
	const MANIFEST = "packages/manifests/firefox/manifest.json";
	const DIST = "packages/platform-extension";
	const ZIP = `${DIST}/bramble-firefox.zip`;

	// Firefox manifest versions follow the same 1-4 dotted-int rule as Chrome.
	const PART = /^(0|[1-9]\d{0,4})$/;
	const parts = version.split(".");
	if (parts.length > 4 || parts.some((p) => !PART.test(p) || Number(p) > 65535))
		fail(`invalid version "${version}". want 1-4 ints, each 0-65535 (e.g. 1.0.0)`);

	const tag = `${version}-firefox`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// AMO prereqs, checked before the slow gate + build so a missing credential fails fast.
	// Mozilla holds the signing key; we hold AMO API credentials (age+YubiKey encrypted, or
	// AMO_API_KEY/AMO_API_SECRET in the env). sign-firefox.ts submits the listed version.
	// AMO version numbers are unique across channels and a listed one must be higher than any
	// previously signed version, so retrying a consumed version means bumping.
	const haveEnvCreds = !!(process.env.AMO_API_KEY && process.env.AMO_API_SECRET);
	const credsAge =
		process.env.AMO_CREDENTIALS_AGE ?? join(HOME, ".config/bramble/amo-api-credentials.age");
	if (!haveEnvCreds) {
		if (!existsSync(credsAge))
			fail(
				`no AMO credentials: set AMO_API_KEY + AMO_API_SECRET, or provide ${credsAge} (override AMO_CREDENTIALS_AGE). See docs/release-signing.md.`,
			);
		for (const bin of ["age", "age-plugin-yubikey"])
			if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
	}

	gate();

	const before = readFileSync(MANIFEST, "utf8");
	let replaced = 0;
	const after = before.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
		replaced++;
		return `${p1}${version}${p2}`;
	});
	if (replaced !== 1)
		fail(`expected exactly one "version" field in ${MANIFEST}, found ${replaced}`);

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = after !== before;
	if (bumped) writeFileSync(MANIFEST, after);

	try {
		run("pnpm run wasm:build");
		run("pnpm --filter @vault/platform-extension run bundle:firefox");
		// AMO's addons-linter, run BEFORE signing. Signing uploads to AMO and consumes the
		// version (AMO won't re-sign it), so catching a validation error here costs nothing:
		// nothing was uploaded, so you fix it and retry the SAME version.
		run("pnpm --filter @vault/platform-extension run lint:firefox");
	} catch {
		fail(
			`build or addons-linter validation failed (nothing uploaded); run \`git checkout ${MANIFEST}\` to undo the bump`,
		);
	}

	try {
		run("pnpm run sign:firefox");
	} catch {
		fail(`signing failed; run \`git checkout ${MANIFEST}\` to undo the bump`);
	}

	if (!existsSync(ZIP)) fail(`expected ${ZIP} from bundle:firefox`);

	commitTagPush(bumped, MANIFEST, `chore(release): firefox ${version}`, tag, branch);

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const zipAsset = join(stage, `bramble_firefox_${version}.zip`);
	copyFileSync(ZIP, zipAsset);
	// The signed .xpi lives on AMO (listed, after review); the GitHub release carries the source
	// bundle + its checksum for transparency. SHA256SUMS over the .zip, like the other branches.
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(
		sumsAsset,
		[zipAsset]
			.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${basename(f)}\n`)
			.join(""),
	);
	try {
		publish(tag, `Firefox Extension ${version}`, [zipAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag}: submitted ${version} to AMO (listed, in review); source bramble_firefox_${version}.zip + SHA256SUMS on the GitHub release.`,
	);
}

// ----- android: GitHub-released, signed .apk + SHA256SUMS -----

function releaseAndroid(version: string, resume: boolean) {
	const ANDROID = "packages/platform-mobile/android";
	const BUILD_GRADLE = `${ANDROID}/app/build.gradle`;
	// The reproducible build runs in the F-Droid-matching container (docker-compose android-repro)
	// and drops an UNSIGNED apk here; we sign it on the host below. Building on macOS instead would
	// bake in host toolchain details (NDK clang, wasm-bindgen-cli) that F-Droid's Linux rebuild can't
	// reproduce, so its reproducible-build check would reject the published APK. See docker/.
	const UNSIGNED = "build-fdroid/app-release-unsigned.apk";

	// versionName is the marketing version; 1-3 dot-separated ints (matches bump:mobile).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	const tag = `${version}-android`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// Signing inputs (host-side; the container never sees the key). The keystore is age+YubiKey
	// encrypted; passwords resolve from the env first, then the macOS login Keychain. Store them once:
	//   security add-generic-password -s bramble-android-keystore -a "$USER" -w
	//   security add-generic-password -s bramble-android-key       -a "$USER" -w   (only if it differs)
	const ksAge =
		process.env.ANDROID_KEYSTORE_AGE ?? join(HOME, ".config/bramble/android-release-keystore.age");
	const storePassword =
		process.env.ANDROID_KEYSTORE_PASSWORD ?? secretFromKeychain("bramble-android-keystore");
	if (!existsSync(ksAge))
		fail(
			`encrypted keystore not at ${ksAge} (override ANDROID_KEYSTORE_AGE). See docs/release-signing.md.`,
		);
	if (!storePassword)
		fail(
			'no keystore password. Store it once: `security add-generic-password -s bramble-android-keystore -a "$USER" -w`, or set ANDROID_KEYSTORE_PASSWORD.',
		);
	const keyAlias = process.env.ANDROID_KEY_ALIAS ?? "bramble";
	const keyPassword =
		process.env.ANDROID_KEY_PASSWORD ?? secretFromKeychain("bramble-android-key") ?? storePassword;
	for (const bin of ["age", "age-plugin-yubikey", "docker"])
		if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
	const apksigner =
		findBuildTool("apksigner") ??
		fail("apksigner not found (Android SDK build-tools); see docs/release-signing.md");
	const java21 = resolveJava21();

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const apkName = `bramble_android_${version}.apk`;
	const apkAsset = join(stage, apkName);
	let versionCode: number;
	let commit: string;

	if (resume) {
		// Sign an apk the container already built. Both checks are load-bearing: signing an apk
		// built from any other commit would publish a binary F-Droid cannot reproduce from the tag.
		if (!existsSync(UNSIGNED))
			fail(`no unsigned apk at ${UNSIGNED}; nothing to resume, re-run without --resume`);
		const head = capture("git log -1 --pretty=%s");
		if (head !== `chore(release): android ${version}`)
			fail(`HEAD is "${head}", not the android ${version} release commit`);
		versionCode = Number(readFileSync(BUILD_GRADLE, "utf8").match(/versionCode (\d+)/)?.[1] ?? 0);
		const aapt2 =
			findBuildTool("aapt2") ??
			fail("aapt2 not found (Android SDK build-tools), needed by --resume");
		const badging = execFileSync(aapt2, ["dump", "badging", UNSIGNED], { encoding: "utf8" });
		const built = `${badging.match(/versionCode='(\d+)'/)?.[1]}/${badging.match(/versionName='([^']*)'/)?.[1]}`;
		if (built !== `${versionCode}/${version}`)
			fail(
				`${UNSIGNED} is ${built}, but HEAD is ${versionCode}/${version}; rebuild without --resume`,
			);
		commit = capture("git rev-parse HEAD");
		console.log(`resuming ${tag}: signing the apk built from ${commit.slice(0, 9)}`);
	} else {
		gate();

		// Bump versionName + a deterministic, committed versionCode (seconds-since-2020, kept monotonic),
		// snapshot the changelogs, and COMMIT. This exact commit is what both the container and F-Droid
		// build, so the versionCode and every other input line up.
		const before = readFileSync(BUILD_GRADLE, "utf8");
		const prevCode = Number(before.match(/versionCode (\d+)/)?.[1] ?? 0);
		versionCode = Math.max(prevCode + 1, Math.floor(Date.now() / 1000) - 1_577_836_800);
		let replacedName = 0;
		let replacedCode = 0;
		let after = before.replace(/versionName "[^"]*"/, () => {
			replacedName++;
			return `versionName "${version}"`;
		});
		after = after.replace(/versionCode \d+/, () => {
			replacedCode++;
			return `versionCode ${versionCode}`;
		});
		if (replacedName !== 1)
			fail(`expected exactly one versionName in ${BUILD_GRADLE}, found ${replacedName}`);
		if (replacedCode !== 1)
			fail(`expected exactly one versionCode in ${BUILD_GRADLE}, found ${replacedCode}`);
		writeFileSync(BUILD_GRADLE, after);
		const changelogFiles = snapshotAndroidChangelogs(String(versionCode));
		run(`git add ${[BUILD_GRADLE, ...changelogFiles].join(" ")}`);
		run(`git commit -m ${JSON.stringify(`chore(release): android ${version}`)}`);
		commit = capture("git rev-parse HEAD");

		// Reproducible build in the container. A failure here rewinds the release commit so the tree
		// is clean for a retry (the bump + changelogs regenerate next run); nothing was built yet.
		try {
			rmSync(UNSIGNED, { force: true });
			console.log(
				`\nbuilding ${commit.slice(0, 9)} in the reproducible container (slow; emulated amd64)…`,
			);
			run("docker compose build android-repro");
			run(`docker compose run --rm android-repro ${commit}`);
			if (!existsSync(UNSIGNED)) fail(`container did not produce ${UNSIGNED}`);
		} catch (e) {
			rmSync(stage, { recursive: true, force: true });
			run("git reset --hard HEAD~1");
			fail(`build failed (${(e as Error).message}); rewound the release commit — fix and re-run`);
		}
	}

	// Host-sign. The commit and the unsigned apk are KEPT on failure: the build is the expensive
	// part, and the usual failure here is a missed YubiKey touch. `--resume` picks it up from here.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-android-"));
	try {
		// Sign on the host: decrypt the keystore into a 0700 dir, apksigner-sign the container's
		// unsigned apk, then wipe the key. The two flags are load-bearing for reproducibility:
		//   --v1-signing-enabled false  no JAR/META-INF signature files (minSdk 24 verifies via v2),
		//                               which would otherwise add entries F-Droid's build lacks.
		//   --alignment-preserved       keep the unsigned apk's exact byte layout; the default would
		//                               re-align every entry.
		// Both keep the signed apk = the container's unsigned apk + the APK Signing Block, which is
		// exactly what F-Droid's apksigcopier reconstructs when it grafts our signature onto its build.
		const ksFile = join(tmp, "release.jks");
		const idFile = join(tmp, "id.txt");
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		notifyYubiKeyTouch("decrypt the Android signing keystore");
		execFileSync("age", ["-d", "-i", idFile, "-o", ksFile, ksAge], { stdio: "inherit" });
		execFileSync(
			apksigner,
			[
				"sign",
				"--ks",
				ksFile,
				"--ks-key-alias",
				keyAlias,
				"--ks-pass",
				"env:BR_KS_PASS",
				"--key-pass",
				"env:BR_KEY_PASS",
				"--v1-signing-enabled",
				"false",
				"--alignment-preserved",
				"--out",
				apkAsset,
				UNSIGNED,
			],
			{
				stdio: "inherit",
				env: {
					...process.env,
					JAVA_HOME: java21,
					BR_KS_PASS: storePassword,
					BR_KEY_PASS: keyPassword,
				},
			},
		);
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
		fail(
			`signing failed (${(e as Error).message}); the release commit and ${UNSIGNED} are kept.` +
				`\nre-run to sign that same build, with no rebuild: pnpm run release android ${version} --resume`,
		);
	}
	rmSync(tmp, { recursive: true, force: true });

	// Confirm the signed apk's cert before publishing (versionCode is what we committed).
	const certOut = execFileSync(apksigner, ["verify", "--print-certs", apkAsset], {
		encoding: "utf8",
	});
	const cert = certOut.match(/SHA-256 digest:\s*([0-9a-f]{64})/i)?.[1];
	console.log(`\nAPK signing cert SHA-256: ${cert ?? "(unknown)"}  |  versionCode ${versionCode}`);

	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(
		sumsAsset,
		`${createHash("sha256").update(readFileSync(apkAsset)).digest("hex")}  ${apkName}\n`,
	);

	// Push the release commit + tag, then publish (release.yml verifies the artifact on publish).
	run(`git tag ${tag}`);
	run(`git push origin ${branch}`);
	run(`git push origin ${tag}`);
	try {
		publish(tag, `Android ${version}`, [apkAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag} (commit ${commit.slice(0, 9)}): reproducible build, host-signed as ${apkName}.` +
			`\nNext: retarget docs/fdroid/app.bramble.mobile.yml -> versionCode ${versionCode}, commit ${commit}.`,
	);
}

// Snapshot each present changelogs/current.txt to changelogs/<versionCode>.txt so the F-Droid
// listing shows release notes for this build. current.txt is hand-authored under the Android en-US
// fastlane (the client falls back to en-US for other locales). Returns the written paths (committed
// with the release).
function snapshotAndroidChangelogs(versionCode: string): string[] {
	// Repo root, not the android project: fdroidserver only scans <root>/fastlane/metadata/android.
	const base = "fastlane/metadata/android";
	if (!existsSync(base)) return [];
	const written: string[] = [];
	for (const locale of readdirSync(base)) {
		const cur = join(base, locale, "changelogs", "current.txt");
		if (!existsSync(cur)) continue;
		const out = join(base, locale, "changelogs", `${versionCode}.txt`);
		copyFileSync(cur, out);
		written.push(out);
	}
	return written;
}

// ----- ios: App Store Connect / TestFlight via fastlane (no GitHub release) -----

function releaseIos(version: string, ipaOnly: boolean) {
	const IOS = "packages/platform-mobile/ios/App";
	const PBXPROJ = `${IOS}/App.xcodeproj/project.pbxproj`;

	// CFBundleShortVersionString: 1-3 dot-separated ints (matches Android + App Store rules).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");

	// Prereqs (fail fast): fastlane + the App Store Connect API key the `beta` lane reads from
	// fastlane/.env. The lanes live in the REPO-ROOT fastlane/ (shared with the Android F-Droid
	// metadata, which fdroidserver only reads from there). The actual signing is Xcode-automatic
	// (-allowProvisioningUpdates), so unlike Android there's no keystore to decrypt here.
	if (!has("fastlane"))
		fail("fastlane not found; `brew install fastlane` (see docs/release-signing.md)");
	if (!existsSync("fastlane/.env"))
		fail(
			"missing fastlane/.env (ASC_KEY_ID/ASC_ISSUER_ID + AuthKey.p8); copy fastlane/.env.example",
		);

	if (!ipaOnly) gate(); // a dry run only tests build + signing, so skip the slow CI gate

	// Bump MARKETING_VERSION + CURRENT_PROJECT_VERSION across ALL build configs. The app + the
	// AutoFillProbe extension must share both or App Store validation rejects the upload, so replace
	// every occurrence. Mirrors the Android versionCode: the build number is committed to source
	// (seconds since 2020, `max(prev+1, now)` so a backwards clock can't emit a non-increasing build,
	// which App Store Connect rejects) and passed to the lane below so the two always agree.
	const before = readFileSync(PBXPROJ, "utf8");
	const prevBuild = Number(before.match(/CURRENT_PROJECT_VERSION = (\d+);/)?.[1] ?? 0);
	const build = Math.max(prevBuild + 1, Math.floor(Date.now() / 1000) - 1_577_836_800);
	let replacedVersion = 0;
	let replacedBuild = 0;
	let after = before.replace(/MARKETING_VERSION = [^;]+;/g, () => {
		replacedVersion++;
		return `MARKETING_VERSION = ${version};`;
	});
	after = after.replace(/CURRENT_PROJECT_VERSION = \d+;/g, () => {
		replacedBuild++;
		return `CURRENT_PROJECT_VERSION = ${build};`;
	});
	if (replacedVersion === 0) fail(`no MARKETING_VERSION found in ${PBXPROJ}`);
	if (replacedBuild === 0) fail(`no CURRENT_PROJECT_VERSION found in ${PBXPROJ}`);
	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = after !== before;

	// Tagged by BUILD, not by marketing version. Uploading several builds at one marketing
	// version is normal on TestFlight, and the build number above always advances, so a plain
	// `<version>-ios` would collide on the second upload. Still ends in `-ios` so
	// `git describe --match '*-ios'` (releaseNotes) can walk iOS tags.
	const tag = `${version}-build${build}-ios`;
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);
	if (bumped) writeFileSync(PBXPROJ, after);

	// --ipa: dry run. Build the signed IPA to ~/Desktop (no upload), then revert the bump so the
	// tree stays clean and nothing is tagged. Lets you smoke-test the pipeline first.
	if (ipaOnly) {
		try {
			run("pnpm run ios:ipa");
			console.log(
				`\ndry run: signed IPA at ~/Desktop/Bramble-TestFlight.ipa (v${version}); not uploaded.`,
			);
		} finally {
			if (bumped) run(`git checkout ${PBXPROJ}`);
		}
		return;
	}

	// Build + upload to TestFlight (fastlane `beta`: prepare -> build_app -> upload_to_testflight).
	// BRAMBLE_IOS_BUILD pins the build number to the one computed above; the lane reads
	// MARKETING_VERSION from the bump above.
	process.env.BRAMBLE_IOS_BUILD = String(build);
	try {
		run("pnpm run ios:beta");
	} catch {
		if (bumped) run(`git checkout ${PBXPROJ}`);
		fail("TestFlight build/upload failed; the version bump was reverted");
	}

	// Commit the version bump, then tag and push. The tag is the only durable pointer from an
	// uploaded build back to the source that produced it: iOS is the one platform whose artifact
	// never lands in the repo (no GitHub release, the binary lives on TestFlight), and a commit
	// message is a string to grep for rather than a ref, so it does not survive a history rewrite.
	//
	// Still no GitHub release: there is no artifact to attach, and a release with no binary
	// implies a download that does not exist. Submit for App Store review manually in App Store
	// Connect.
	commitTagPush(bumped, PBXPROJ, `chore(release): ios ${version} (build ${build})`, tag, branch);
	console.log(
		`\nreleased v${version} (build ${build}): uploaded to TestFlight (marketing version ${version}).` +
			`\nTagged ${tag}.` +
			"\nNext: in App Store Connect, attach build " +
			`${build} to an App Store version and submit for review.`,
	);
}

// ----- desktop: GitHub release (.dmg + updater archive), manifest served from the website -----

function releaseDesktop(version: string, universal: boolean) {
	const BUNDLE = "packages/platform-desktop/src-tauri/target/release/bundle";

	// Tauri requires a strict major.minor.patch; it refuses to build otherwise, and finding that
	// out after the gate and a full build wastes ten minutes.
	if (!/^\d+\.\d+\.\d+$/.test(version))
		fail(`invalid version "${version}". want major.minor.patch`);

	const tag = `${version}-desktop`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// The manifest reaches apps only via the website, and deploy-website.yml runs on pushes to
	// main. Released from anywhere else, the GitHub release is real and no installed app ever
	// hears about it — the quietest possible failure.
	const onBranch = capture("git rev-parse --abbrev-ref HEAD");
	if (onBranch !== WEBSITE_BRANCH)
		fail(
			`on branch "${onBranch}", but the website deploys from "${WEBSITE_BRANCH}" — the update ` +
				`manifest would never go live.\nMerge to ${WEBSITE_BRANCH} and release from there.`,
		);

	// Signing + notarization prereqs, before the slow gate + build. Notarization is required rather
	// than optional here, unlike a local build: Gatekeeper blocks an un-notarized app on every
	// machine that did not build it, so publishing one ships something nobody can open.
	const keyAge =
		process.env.DESKTOP_UPDATER_KEY_AGE ?? join(HOME, ".config/bramble/desktop-updater-key.age");
	if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(keyAge))
		fail(
			`no updater signing key: set TAURI_SIGNING_PRIVATE_KEY, or provide ${keyAge} (override DESKTOP_UPDATER_KEY_AGE). See docs/release-signing.md.`,
		);
	if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
		for (const bin of ["age", "age-plugin-yubikey"])
			if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
	if (!existsSync("fastlane/AuthKey.p8") && !process.env.APPLE_API_KEY && !process.env.APPLE_ID)
		fail(
			"no notarization credentials; a released build must be notarized or Gatekeeper blocks it. See docs/release-signing.md.",
		);

	gate();

	const before = readFileSync(DESKTOP_CONF, "utf8");
	let replaced = 0;
	const after = before.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
		replaced++;
		return `${p1}${version}${p2}`;
	});
	if (replaced !== 1)
		fail(`expected exactly one "version" field in ${DESKTOP_CONF}, found ${replaced}`);

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = after !== before;
	if (bumped) writeFileSync(DESKTOP_CONF, after);

	try {
		// Prompts for the YubiKey PIN and a touch, then notarizes (an upload to Apple and a wait).
		run(`pnpm run ${universal ? "build:desktop:universal" : "build:desktop"}`);
	} catch {
		fail(`build failed; run \`git checkout ${DESKTOP_CONF}\` to undo the bump`);
	}

	const macos = join(BUNDLE, "macos");
	const archives = existsSync(macos)
		? readdirSync(macos).filter((f) => f.endsWith(".app.tar.gz"))
		: [];
	if (archives.length === 0)
		fail(`no .app.tar.gz in ${macos}; the build produced no updater archive`);
	const dmgs = existsSync(join(BUNDLE, "dmg"))
		? readdirSync(join(BUNDLE, "dmg")).filter((f) => f.endsWith(".dmg"))
		: [];
	if (dmgs.length === 0) fail(`no .dmg in ${join(BUNDLE, "dmg")}`);

	const assets: string[] = [];
	for (const f of dmgs) assets.push(join(BUNDLE, "dmg", f));
	for (const a of archives) {
		if (!existsSync(join(macos, `${a}.sig`)))
			// Every installed app rejects an unsigned archive, so publishing one leaves a release
			// that looks complete while updating silently fails for everyone.
			fail(`${a} has no .sig; was the signing key set for this build?`);
		assets.push(join(macos, a), join(macos, `${a}.sig`));
	}

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(
		sumsAsset,
		assets
			.filter((f) => !f.endsWith(".sig"))
			.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${basename(f)}\n`)
			.join(""),
	);

	commitTagPush(bumped, DESKTOP_CONF, `chore(release): desktop ${version}`, tag, branch);

	try {
		publish(tag, `Desktop ${version}`, [...assets, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}

	// Only now. The manifest IS the update channel, so it goes live after the artifacts it names
	// exist — the other way round, every app checking in between reads a manifest whose download
	// 404s, and a failed update is indistinguishable from a broken updater.
	run("node scripts/release-desktop.mjs --resume --quiet");
	run(`git add ${DESKTOP_MANIFEST}`);
	run(`git commit -m ${JSON.stringify(`chore(release): desktop ${version} update manifest`)}`);
	run(`git push origin ${branch}`);

	console.log(
		`\nreleased ${tag}: ${dmgs.join(", ")} + updater archive attached to the GitHub release.` +
			`\nThe manifest is committed; installed apps see ${version} once the website deploy lands.`,
	);
}

// ----- shared helpers -----

// A target's current version, read from its own source of truth (each versions independently):
// the manifest `version` for chromium/firefox, `versionName` for android, MARKETING_VERSION for ios.
function currentVersion(platform: string): string {
	if (platform === "android")
		return matchVersion(
			readFileSync("packages/platform-mobile/android/app/build.gradle", "utf8"),
			/versionName "([^"]+)"/,
			"versionName in build.gradle",
		);
	if (platform === "ios")
		return matchVersion(
			readFileSync("packages/platform-mobile/ios/App/App.xcodeproj/project.pbxproj", "utf8"),
			/MARKETING_VERSION = ([^;]+);/,
			"MARKETING_VERSION in project.pbxproj",
		);
	if (platform === "desktop")
		return matchVersion(
			readFileSync(DESKTOP_CONF, "utf8"),
			/"version"\s*:\s*"([^"]+)"/,
			`version in ${DESKTOP_CONF}`,
		);
	const manifest =
		platform === "firefox"
			? "packages/manifests/firefox/manifest.json"
			: "packages/manifests/chromium/manifest.json";
	return matchVersion(
		readFileSync(manifest, "utf8"),
		/"version"\s*:\s*"([^"]+)"/,
		`version in ${manifest}`,
	);
}

function matchVersion(content: string, re: RegExp, what: string): string {
	const v = content.match(re)?.[1];
	if (!v) fail(`couldn't read current ${what}`);
	return v.trim();
}

// Bump a semver-ish version for patch/minor/major; missing parts count as 0 and the result is
// always major.minor.patch (each platform's own validator still checks the final form).
function nextVersion(current: string, kind: "patch" | "minor" | "major"): string {
	const nums = current.split(".").map((n) => Number.parseInt(n, 10));
	if (nums.some((n) => Number.isNaN(n)))
		fail(`can't ${kind}-bump: current version "${current}" isn't numeric`);
	let [maj = 0, min = 0, pat = 0] = nums;
	if (kind === "major") {
		maj += 1;
		min = 0;
		pat = 0;
	} else if (kind === "minor") {
		min += 1;
		pat = 0;
	} else {
		pat += 1;
	}
	return `${maj}.${min}.${pat}`;
}

// Decrypt the two Chrome Web Store secrets (signing key + service-account JSON) in one YubiKey
// session and expose them to sign/sign:cws via env (CWS_KEY_PEM / CWS_SERVICE_ACCOUNT_JSON), so
// neither step prompts for its own touch. The decrypts run back-to-back, sharing the YubiKey PIN
// and (cached-policy) touch — one tap instead of two. Skips a secret already provided via env (CI).
// Returns a cleanup that wipes the plaintext temp dir and restores the env.
function primeCwsSecrets(keyAge: string, saAge: string): () => void {
	const haveKey = Boolean(process.env.CWS_KEY_PEM);
	const haveSa = Boolean(process.env.CWS_SERVICE_ACCOUNT_JSON);
	if (haveKey && haveSa) return () => {}; // both already plaintext (CI); nothing to decrypt

	for (const bin of ["age", "age-plugin-yubikey"])
		if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);

	// 0700 scratch dir; the plaintext secrets never leave it and are wiped by the cleanup.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-cws-secrets-"));
	try {
		const idFile = join(tmp, "id.txt"); // identity stub -> YubiKey slot; not key material
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		notifyYubiKeyTouch("decrypt the Chrome Web Store signing key + service account");
		if (!haveKey) {
			const keyPem = join(tmp, "key.pem");
			execFileSync("age", ["-d", "-i", idFile, "-o", keyPem, keyAge], { stdio: "inherit" });
			process.env.CWS_KEY_PEM = keyPem;
		}
		if (!haveSa) {
			const saJson = join(tmp, "sa.json");
			execFileSync("age", ["-d", "-i", idFile, "-o", saJson, saAge], { stdio: "inherit" });
			process.env.CWS_SERVICE_ACCOUNT_JSON = saJson;
		}
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		throw e;
	}
	return () => {
		rmSync(tmp, { recursive: true, force: true });
		if (!haveKey) delete process.env.CWS_KEY_PEM;
		if (!haveSa) delete process.env.CWS_SERVICE_ACCOUNT_JSON;
	};
}

// Gate on the same lint + typecheck + tests CI enforces on main, before touching
// anything, so a tag never ships from a red tree. typecheck matters because the
// bundlers strip types without checking them.
function gate() {
	try {
		run("pnpm run ci:check");
		run("pnpm run typecheck");
		run("pnpm run test");
		// Never ship with missing translations (po / android / xcstrings / fastlane).
		// Validates committed catalogs; no --extract so the release tree stays clean.
		run("pnpm run i18n:check");
	} catch {
		fail("lint, typecheck, tests, or i18n check failed; fix them before releasing");
	}
}

function commitTagPush(
	bumped: boolean,
	files: string | string[],
	message: string,
	tag: string,
	branch: string,
) {
	const list = Array.isArray(files) ? files : [files];
	if (bumped) {
		for (const f of list) run(`git add ${f}`);
		run(`git commit -m ${JSON.stringify(message)}`);
	} else {
		console.log(
			`${list[0]} already at this version; tagging current commit without a release commit`,
		);
	}
	run(`git tag ${tag}`);
	run(`git push origin ${branch}`);
	run(`git push origin ${tag}`);
}

// Build release notes from the conventional-commit log between the previous tag of
// the SAME platform and this one. GitHub's --generate-notes is useless here: it
// lists merged PRs (we commit straight to main, so it finds none) and picks the
// previous tag from the shared namespace (diffing android against a chromium tag).
function releaseNotes(tag: string, platform: string): string {
	const prev = capture(
		`git describe --tags --abbrev=0 --match '*-${platform}' ${tag}^ 2>/dev/null || true`,
	);
	const range = prev ? `${prev}..${tag}` : tag;
	const subjects = capture(`git log --no-merges --pretty=%s ${range}`)
		.split("\n")
		.filter((s) => s && !/^chore\(release\)/.test(s));

	const sections: [string, string][] = [
		["feat", "### Features"],
		["fix", "### Bug Fixes"],
		["perf", "### Performance"],
		["refactor", "### Refactors"],
		["docs", "### Documentation"],
	];
	const groups = new Map<string, string[]>();
	const other: string[] = [];
	for (const s of subjects) {
		const m = s.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)/);
		const heading = sections.find(([t]) => t === m?.[1])?.[1];
		if (heading) groups.set(heading, [...(groups.get(heading) ?? []), m?.[2] ?? s]);
		else other.push(s);
	}

	let body = "";
	for (const [, heading] of sections) {
		const items = groups.get(heading);
		if (items) body += `${heading}\n\n${items.map((d) => `- ${d}`).join("\n")}\n\n`;
	}
	if (other.length) body += `### Other\n\n${other.map((d) => `- ${d}`).join("\n")}\n\n`;
	if (prev) {
		const repo = capture("gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true");
		if (repo) body += `**Full Changelog**: https://github.com/${repo}/compare/${prev}...${tag}\n`;
	}
	return body.trim() || "_No notable changes._";
}

// Draft -> upload -> publish, so the `release: published` event fires only once the
// signed artifacts are attached (CI verifies them on that event).
function publish(tag: string, title: string, assets: string[]) {
	const notesDir = mkdtempSync(join(tmpdir(), "bramble-notes-"));
	const notesFile = join(notesDir, "NOTES.md");
	writeFileSync(notesFile, releaseNotes(tag, platform));
	try {
		run(
			`gh release create ${tag} --draft --notes-file ${notesFile} --title ${JSON.stringify(title)}`,
		);
		run(`gh release upload ${tag} ${assets.join(" ")}`);
		run(`gh release edit ${tag} --draft=false`);
	} finally {
		rmSync(notesDir, { recursive: true, force: true });
	}
}

function has(bin: string) {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Read a secret from the macOS login Keychain (encrypted at rest, unlocked at login). Returns
// undefined off macOS or when the service isn't stored, so callers can fall back to the env var
// via `??` (and undefined, unlike null, is a valid absent value for a process-env field).
function secretFromKeychain(service: string): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
			encoding: "utf8",
		}).replace(/\n$/, ""); // strip only the trailing newline `security -w` adds
	} catch {
		return undefined;
	}
}

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

/** Newest Android SDK build-tools binary of this name (apksigner, aapt2, ...), else null. */
function findBuildTool(name: string): string | null {
	const sdk =
		process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(HOME, "Library/Android/sdk");
	const buildTools = join(sdk, "build-tools");
	try {
		const dirs = readdirSync(buildTools).sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true }),
		);
		for (const d of dirs.reverse()) {
			const p = join(buildTools, d, name);
			if (existsSync(p)) return p;
		}
	} catch {
		// no SDK / build-tools on PATH
	}
	return null;
}
