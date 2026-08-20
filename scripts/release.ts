// Cut a release entirely from your machine: bump the version, build (+ sign), tag,
// push, then publish a GitHub release with the artifacts attached.
//
// Usage:
//   pnpm run release chromium <version|patch|minor|major>   e.g. 1.0.0, or `patch` to bump
//   pnpm run release firefox  <version|patch|minor|major>
//   pnpm run release android  <version|patch|minor|major> [--resume]  (--resume = sign the apk the
//                                                                      last run already built)
//   pnpm run release ios      <version|patch|minor|major> [--ipa]   (--ipa = dry-run IPA, no upload/tag)
//   pnpm run release desktop  <version|patch|minor|major> [--aarch64] [--resume]
//                                       (--aarch64 = skip the Intel slice; --resume = publish the
//                                        build the last run already made and signed)
//
// Release notes are drafted from the commit range by the same model the i18n scripts use, then
// opened in $EDITOR before publishing: the commit log is written for us, the release page is not.
// --no-edit publishes the draft unedited, and no model or no terminal falls back to the grouped
// commit list, because a release must never block on a summary.
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
// android builds here on macOS (web bundle + Rust FFI + gradle assembleRelease) and signs the
// unsigned APK gradle emits with the YubiKey-held keystore. Signing setup lives in
// docs/release-signing.md.
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
import { signingKey } from "./desktop-signing-key.ts";
import { composeNotes } from "./release-notes.mjs";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const HOME = process.env.HOME ?? "";

/** Desktop version lives in the Tauri config; the updater manifest is served off the website. */
const DESKTOP_CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";
const DESKTOP_MANIFEST = "website/public/desktop/latest.json";
/** Canonical copy of the Homebrew cask; the published one lives in homebrew/homebrew-cask. */
const DESKTOP_CASK = "packages/platform-desktop/homebrew/bramble.rb";
/** Branch deploy-website.yml builds from; the manifest is only live once that runs. */
const WEBSITE_BRANCH = "main";

// What each target actually ships, as git pathspecs. A commit belongs to a release only if it
// touched one of these, so the notes describe THAT target rather than everything that happened in
// the range. Shared paths are deliberately in every list: a core fix ships in all five, and it
// should be listed in all five rather than attributed to whichever one released first.
//
// Paths decide what a release INCLUDES, and never the commit scope: a `feat(desktop):` that only
// touches scripts/ or website/ is real work but not shipped code, and guessing from a scope that
// nothing enforces would put commits in the wrong release. Silently dropping a few is the cheaper
// mistake. Scope only ever subtracts, in PLATFORM_SCOPES below.
const SHARED_PATHS = ["packages/core", "packages/core-rust", "packages/theme"];
const PLATFORM_PATHS: Record<string, string[]> = {
	chromium: ["packages/platform-extension", "packages/manifests/chromium"],
	firefox: ["packages/platform-extension", "packages/manifests/firefox"],
	desktop: ["packages/platform-desktop"],
	// One mobile package builds both, so each excludes the other's native half and keeps the
	// shared src/. Order matters to git: the exclude has to follow what it subtracts from.
	ios: ["packages/platform-mobile", ":(exclude)packages/platform-mobile/android"],
	android: ["packages/platform-mobile", ":(exclude)packages/platform-mobile/ios"],
};

// A commit whose scope names a DIFFERENT platform is not this release's news, even when its paths
// say otherwise. `feat(desktop): pick the credential store, never ask` touches packages/core, so
// paths alone put it in the mobile notes describing a feature mobile does not have. The author
// already said who it was for, so believe them.
//
// Only unambiguous platform words are listed. A scope this does not know (backup, sync, ui) stays
// neutral and its paths decide, because subtracting on a guess loses real entries.
const PLATFORM_SCOPES: Record<string, string[]> = {
	desktop: ["desktop"],
	apt: ["desktop"],
	mobile: ["ios", "android"],
	ios: ["ios"],
	android: ["android"],
	fdroid: ["android"],
	extension: ["chromium", "firefox"],
	ext: ["chromium", "firefox"],
	chromium: ["chromium"],
	firefox: ["firefox"],
	"firefox-port": ["firefox"],
};

/**
 * The platforms a subject's scope claims, or null when it names none and the paths should decide.
 *
 * Compound scopes intersect, so `ext/firefox` is firefox alone rather than both extensions, and
 * `i18n/android` is android rather than neutral. An empty intersection means the scope contradicts
 * itself, which is not a reason to drop the commit everywhere, so it falls back to neutral.
 */
function scopedPlatforms(subject: string): string[] | null {
	const scope = subject.match(/^\w+\(([^)]*)\)!?:/)?.[1];
	if (!scope) return null;
	let claimed: string[] | null = null;
	for (const part of scope.split("/")) {
		const named = PLATFORM_SCOPES[part.trim().toLowerCase()];
		if (!named) continue;
		claimed = claimed ? claimed.filter((p) => named.includes(p)) : named;
	}
	return claimed?.length ? claimed : null;
}

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

// Every path but ios ends in `gh release create`, and finding gh missing or logged out there
// means the store publish and the tag already happened. An installed gh is not enough.
if (platform !== "ios") {
	requireBins(["gh"], "docs/release-signing.md");
	// --active, because a bare `gh auth status` exits non-zero when ANY stored account is broken,
	// including one for a different login that this repo never uses. What a release needs is the
	// account gh will actually act as.
	if (!ok("gh auth status --active"))
		fail("gh's active account cannot log in; run `gh auth login`");
}

if (platform === "android") await releaseAndroid(version, flags.has("--resume"));
else if (platform === "ios") await releaseIos(version, flags.has("--ipa"));
else if (platform === "firefox") await releaseFirefox(version);
// Universal by default. Forgetting the flag would ship an Apple-Silicon-only release, and the
// failure is silent from here: the dmg simply does not open on an Intel Mac.
else if (platform === "desktop")
	await releaseDesktop(version, !flags.has("--aarch64"), flags.has("--resume"));
else await releaseExtension(platform, version);

// ----- extension: Chrome Web Store, signed .crx -----

async function releaseExtension(target: string, version: string) {
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
	// primeCwsSecrets needs these, but it does not run until after the gate and the build.
	if (!process.env.CWS_KEY_PEM || !process.env.CWS_SERVICE_ACCOUNT_JSON)
		requireBins(["age", "age-plugin-yubikey"], "docs/release-signing.md");

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
		await publish(tag, title, [crxAsset, zipAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag}: published to the Chrome Web Store (in review) + signed bramble_${target}_${version}.crx + SHA256SUMS attached to the GitHub release.`,
	);
}

// ----- firefox: submitted listed to AMO; GitHub release carries the source .zip + SHA256SUMS -----

async function releaseFirefox(version: string) {
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
		requireBins(["age", "age-plugin-yubikey"], "docs/release-signing.md");
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
		await publish(tag, `Firefox Extension ${version}`, [zipAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag}: submitted ${version} to AMO (listed, in review); source bramble_firefox_${version}.zip + SHA256SUMS on the GitHub release.`,
	);
}

// ----- android: GitHub-released, signed .apk + SHA256SUMS -----

async function releaseAndroid(version: string, resume: boolean) {
	const ANDROID = "packages/platform-mobile/android";
	const BUILD_GRADLE = `${ANDROID}/app/build.gradle`;
	// gradle has no release signingConfig, so assembleRelease lands here UNSIGNED; apksigner signs it
	// below, once, from a keystore that only exists on disk for those few seconds.
	const UNSIGNED = `${ANDROID}/app/build/outputs/apk/release/app-release-unsigned.apk`;

	// versionName is the marketing version; 1-3 dot-separated ints (matches bump:mobile).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	const tag = `${version}-android`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

	// Signing inputs (post-build; gradle never sees the key). The keystore is age+YubiKey
	// encrypted; passwords resolve from the env, then the macOS login Keychain, then an
	// age+YubiKey file, which is the only one of the three that works off macOS. Store one once:
	//   security add-generic-password -s bramble-android-keystore -a "$USER" -w
	//   printf %s 'PASSWORD' | age -r age1yubikey1... -o ~/.config/bramble/android-keystore-password.age
	const ksAge =
		process.env.ANDROID_KEYSTORE_AGE ?? join(HOME, ".config/bramble/android-release-keystore.age");
	const ksPassAge =
		process.env.ANDROID_KEYSTORE_PASSWORD_AGE ??
		join(HOME, ".config/bramble/android-keystore-password.age");
	const keyPassAge =
		process.env.ANDROID_KEY_PASSWORD_AGE ?? join(HOME, ".config/bramble/android-key-password.age");
	const envStorePassword =
		process.env.ANDROID_KEYSTORE_PASSWORD ?? secretFromKeychain("bramble-android-keystore");
	const envKeyPassword =
		process.env.ANDROID_KEY_PASSWORD ?? secretFromKeychain("bramble-android-key");
	if (!existsSync(ksAge))
		fail(
			`encrypted keystore not at ${ksAge} (override ANDROID_KEYSTORE_AGE). See docs/release-signing.md.`,
		);
	// Only the source is checked here. The decrypt happens beside the keystore's, on one touch.
	if (!envStorePassword && !existsSync(ksPassAge))
		fail(
			`no keystore password: set ANDROID_KEYSTORE_PASSWORD, store it in the macOS Keychain as bramble-android-keystore, or age-encrypt it to ${ksPassAge}. See docs/release-signing.md.`,
		);
	const keyAlias = process.env.ANDROID_KEY_ALIAS ?? "bramble";
	requireBins(["age", "age-plugin-yubikey"], "docs/release-signing.md");
	// Native build toolchain, checked before the gate: core:build shells out to wasm-pack and
	// ffi:build:android to cargo-ndk, and finding either missing after the release commit means a
	// rewind for something `cargo install` fixes in a minute.
	if (!resume)
		requireBins(["wasm-pack", "cargo-ndk"], "packages/platform-mobile/docs/development.md");
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
		// Sign the apk a previous run already built. Both checks are load-bearing: signing an apk
		// built from any other commit would publish a binary the tag does not describe.
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
		// snapshot the changelogs, and COMMIT before building, so the tag names the exact tree the
		// published APK was built from.
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

		// Build on this machine: web bundle -> native crypto libs (4 ABIs) -> cap sync -> gradle.
		// A failure here rewinds the release commit so the tree is clean for a retry (the bump +
		// changelogs regenerate next run); nothing was published yet.
		try {
			// Stale-output guard: assembleRelease writing nothing (skipped task, wrong variant) would
			// otherwise leave the previous run's apk in place and sign that instead.
			rmSync(UNSIGNED, { force: true });
			console.log(`\nbuilding ${commit.slice(0, 9)}…`);
			run("pnpm run core:build");
			run("pnpm run ffi:build:android");
			run("pnpm --filter @vault/platform-mobile exec cap sync android");
			execFileSync(
				join(ANDROID, "gradlew"),
				["-p", ANDROID, "assembleRelease", `-Porg.gradle.java.installations.paths=${java21}`],
				{ stdio: "inherit", env: { ...process.env, JAVA_HOME: java21 } },
			);
			// `throw`, not fail(): these are build failures like any other, so they belong in the
			// rewind path below rather than exiting on top of a release commit.
			if (!existsSync(UNSIGNED)) throw new Error(`gradle did not produce ${UNSIGNED}`);
			// The apk has to carry the versionCode we just committed; anything else means gradle read
			// a different build.gradle than the one the tag will point at.
			const outMeta = `${ANDROID}/app/build/outputs/apk/release/output-metadata.json`;
			const builtCode = JSON.parse(readFileSync(outMeta, "utf8"))?.elements?.[0]?.versionCode;
			if (builtCode !== versionCode)
				throw new Error(`built versionCode ${builtCode} != expected ${versionCode} (${outMeta})`);
		} catch (e) {
			rmSync(stage, { recursive: true, force: true });
			run("git reset --hard HEAD~1");
			fail(`build failed (${(e as Error).message}); rewound the release commit — fix and re-run`);
		}
	}

	// Sign. The commit and the unsigned apk are KEPT on failure: the build is the expensive
	// part, and the usual failure here is a missed YubiKey touch. `--resume` picks it up from here.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-android-"));
	try {
		// Decrypt the keystore into a 0700 dir, apksigner-sign gradle's unsigned apk, then wipe the
		// key. `--v1-signing-enabled false` drops the JAR/META-INF signature files: minSdk is 24, so
		// every supported device verifies v2/v3, and v1 only adds bytes and a stripping attack
		// surface. Alignment is left to apksigner's default (native libs on 16 KB pages, the rest on
		// 4 bytes), which is what Android 15+ requires of an installed apk.
		const ksFile = join(tmp, "release.jks");
		const idFile = join(tmp, "id.txt");
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		notifyYubiKeyTouch("decrypt the Android signing keystore");
		execFileSync("age", ["-d", "-i", idFile, "-o", ksFile, ksAge], { stdio: "inherit" });
		// Back-to-back with the keystore so both ride one touch (the PIV touch cache is ~15s).
		const storePassword = envStorePassword ?? ageDecrypt(ksPassAge, idFile);
		const keyPassword =
			envKeyPassword ?? (existsSync(keyPassAge) ? ageDecrypt(keyPassAge, idFile) : storePassword);
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
		await publish(tag, `Android ${version}`, [apkAsset, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag} (commit ${commit.slice(0, 9)}): signed as ${apkName}, versionCode ${versionCode}.`,
	);
}

// Snapshot each present changelogs/current.txt to changelogs/<versionCode>.txt, the per-build
// release notes an Android store listing reads. current.txt is hand-authored under the Android
// en-US fastlane (clients fall back to en-US for other locales). Returns the written paths
// (committed with the release).
function snapshotAndroidChangelogs(versionCode: string): string[] {
	// Repo root, not the android project: fastlane's supply layout is <root>/fastlane/metadata/android.
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

async function releaseIos(version: string, ipaOnly: boolean) {
	const IOS = "packages/platform-mobile/ios/App";
	const PBXPROJ = `${IOS}/App.xcodeproj/project.pbxproj`;

	// CFBundleShortVersionString: 1-3 dot-separated ints (matches Android + App Store rules).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");

	// Prereqs (fail fast): fastlane + the App Store Connect API key the `beta` lane reads from
	// fastlane/.env. The lanes live in the REPO-ROOT fastlane/ (shared with the Android store
	// metadata, which fastlane's supply layout puts there). The actual signing is Xcode-automatic
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

async function releaseDesktop(version: string, universal: boolean, resume = false) {
	// cargo puts a --target build under target/<triple>/, so a universal build does not land in
	// target/release. Reading the wrong one would publish the previous aarch64 build instead.
	const BUNDLE = universal
		? "packages/platform-desktop/src-tauri/target/universal-apple-darwin/release/bundle"
		: "packages/platform-desktop/src-tauri/target/release/bundle";

	// Tauri requires a strict major.minor.patch; it refuses to build otherwise, and finding that
	// out after the gate and a full build wastes ten minutes.
	if (!/^\d+\.\d+\.\d+$/.test(version))
		fail(`invalid version "${version}". want major.minor.patch`);

	const tag = `${version}-desktop`;
	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
	// A resume finishes the run that made this tag, so the tag existing is the precondition rather
	// than the error. Publishing is all that is left, and it is keyed off the tag.
	if (resume) {
		if (!capture(`git tag -l ${tag}`))
			fail(`no tag ${tag}; nothing to resume, re-run without --resume`);
		// The version in the config is what the bundles on disk were built from. If it moved, the
		// artifacts belong to some other release and publishing them would mislabel them.
		const conf = JSON.parse(readFileSync(DESKTOP_CONF, "utf8")).version;
		if (conf !== version)
			fail(`${DESKTOP_CONF} is ${conf}, not ${version}; rebuild without --resume`);
		console.log(`resuming ${tag}: publishing the build already on disk, no rebuild`);
	} else if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

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
	// Build-only prerequisites. A resume signs nothing and notarizes nothing: it reads the .sig
	// files the original run wrote, so demanding a YubiKey and an Apple key to upload finished
	// artifacts would just make the recovery path harder than the thing it recovers from.
	if (!resume && !process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(keyAge))
		fail(
			`no updater signing key: set TAURI_SIGNING_PRIVATE_KEY, or provide ${keyAge} (override DESKTOP_UPDATER_KEY_AGE). See docs/release-signing.md.`,
		);
	if (!resume && !process.env.TAURI_SIGNING_PRIVATE_KEY)
		requireBins(["age", "age-plugin-yubikey"], "docs/release-signing.md");
	// Linux needs two tools a minimal install does not have, and neither failure is legible when
	// it happens: the deb bundler copies xdg-open INTO the package for tauri-plugin-opener and
	// stops with "xdg-open binary not found" several minutes in, and the containerised build
	// (scripts/build-linux.ts) rsyncs the tree into its workspace volume.
	if (!resume && process.platform === "linux")
		requireBins(["rsync", "xdg-open"], "docs/desktop-port.md");
	// A desktop release ships Linux too, built in a container so one machine can cut the whole
	// thing. Checked here rather than an hour later, after the gate and a notarized macOS build.
	if (!resume && process.platform === "darwin") requireBins(["docker"], "docs/desktop-port.md");
	if (
		!resume &&
		!existsSync("fastlane/AuthKey.p8") &&
		!process.env.APPLE_API_KEY &&
		!process.env.APPLE_ID
	)
		fail(
			"no notarization credentials; a released build must be notarized or Gatekeeper blocks it. See docs/release-signing.md.",
		);
	// Checked before the gate, because the alternative is finding out several minutes into a build
	// that ran lint, typecheck and the whole test suite first.
	if (
		!resume &&
		universal &&
		!capture("rustup target list --installed").includes("x86_64-apple-darwin")
	)
		fail(
			"the Intel slice needs a toolchain that is not installed:\n" +
				"  rustup target add x86_64-apple-darwin\n" +
				"or release Apple Silicon only with --aarch64.",
		);

	if (!resume) gate();

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
	if (bumped && !resume) writeFileSync(DESKTOP_CONF, after);

	// Unlocked once, here, rather than separately by each build. Both children read it from the
	// environment before reaching for the age file, so this is the difference between one YubiKey
	// touch for a release and two. The plaintext never touches disk; build-linux passes it into
	// the container by name so it stays out of argv. See scripts/desktop-signing-key.ts.
	if (!resume && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
		const key = signingKey(fail);
		if (!key) fail("no updater signing key; see docs/release-signing.md");
		process.env.TAURI_SIGNING_PRIVATE_KEY = key;
	}

	if (!resume)
		try {
			// Prompts for the YubiKey PIN and a touch, then notarizes (an upload to Apple and a wait).
			run(`pnpm run build:macos${universal ? "" : " -- --aarch64"}`);
		} catch {
			fail(`build failed; run \`git checkout ${DESKTOP_CONF}\` to undo the bump`);
		}

	// The Linux half, in a container, from the same machine. A release that ships only the .dmg
	// leaves Debian users on an APT repository with nothing new in it and AppImage users with an
	// updater that never sees a release.
	if (!resume && process.platform === "darwin") {
		try {
			run("pnpm run build:linux");
		} catch {
			fail(
				`Linux build failed; the macOS build is fine.\nFix it and re-run, or ` +
					`\`git checkout ${DESKTOP_CONF}\` to undo the bump.`,
			);
		}
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
	// The website's download box builds this URL from the version rather than reading it from
	// anywhere, because the updater manifest names the .app.tar.gz and never the disk image. A
	// rename here would leave the front page's main macOS download pointing at a 404.
	const expectedDmg = `Bramble_${version}_universal.dmg`;
	if (universal && !dmgs.includes(expectedDmg))
		fail(
			`expected ${expectedDmg}, built ${dmgs.join(", ")}.\n` +
				"website/src/downloads.ts links to that exact name; update both together.",
		);

	// dist-linux and the dmg directory are not cleaned between releases, and the bundlers put the
	// version in every filename, so a plain extension glob picks up the PREVIOUS release too:
	// cutting 0.4.0 over a 0.3.0 tree attaches 0.3.0 debs, rpms and AppImages to the new release
	// and hashes them into its SHA256SUMS.
	//
	// Compared as text, not as a pattern. `version` comes from argv, so building a RegExp from it
	// raises an escaping question with no upside: matching the delimited string is what was meant
	// all along, and it cannot be malformed by its input.
	// The bundlers bracket the version in one delimiter or the other, never a mix, so requiring a
	// matched pair rejects 10.4.0 and 0.4.0-rc1 alike, where either loose end would take both.
	/** `Bramble_0.4.0_amd64.deb` and `Bramble-0.4.0-1.x86_64.rpm`. */
	const ofThisVersion = (f: string) => ["_", "-"].some((d) => f.includes(`${d}${version}${d}`));

	const assets: string[] = [];
	for (const f of dmgs.filter(ofThisVersion)) assets.push(join(BUNDLE, "dmg", f));
	// One release carries every platform. The AppImage must be signed, for the same reason the
	// macOS archive must: it is what the updater fetches, and an unsigned one is rejected by every
	// installed app, so publishing it looks complete and updates nobody. The .deb and .rpm carry
	// .sig files too, which are meaningless (the updater cannot apply either) and not uploaded.
	for (const [dir, ext] of [
		["dist-linux/deb", ".deb"],
		["dist-linux/rpm", ".rpm"],
		["dist-linux/appimage", ".AppImage"],
	] as const) {
		if (!existsSync(dir)) continue;
		const built = readdirSync(dir).filter((f) => f.endsWith(ext) && ofThisVersion(f));
		// Nothing for this version means the Linux build did not run or wrote elsewhere. Silence
		// here would publish a macOS-only release that claims to carry Linux.
		if (built.length === 0) fail(`no ${version} ${ext} in ${dir}; re-run the Linux build`);
		for (const f of built) {
			assets.push(join(dir, f));
			if (ext === ".AppImage") {
				if (!existsSync(join(dir, `${f}.sig`)))
					fail(`${f} has no .sig; the Linux build must not be --unsigned for a release`);
				assets.push(join(dir, `${f}.sig`));
			}
		}
	}
	for (const a of archives) {
		if (!existsSync(join(macos, `${a}.sig`)))
			// Every installed app rejects an unsigned archive, so publishing one leaves a release
			// that looks complete while updating silently fails for everyone.
			fail(`${a} has no .sig; was the signing key set for this build?`);
		assets.push(join(macos, a), join(macos, `${a}.sig`));
	}

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const sumsAsset = join(stage, "SHA256SUMS");
	// Keyed by basename because the cask below needs the .dmg's checksum, and `test:brew`
	// asserts the two agree: hashing the same file twice is how they would come to disagree.
	const sums = new Map(
		assets
			.filter((f) => !f.endsWith(".sig"))
			.map(
				(f) => [basename(f), createHash("sha256").update(readFileSync(f)).digest("hex")] as const,
			),
	);
	writeFileSync(sumsAsset, [...sums].map(([name, hash]) => `${hash}  ${name}\n`).join(""));

	// Already committed, tagged and pushed by the run being resumed; doing it again would only
	// fail on the tag that the resume exists to reuse.
	if (!resume)
		commitTagPush(bumped, DESKTOP_CONF, `chore(release): desktop ${version}`, tag, branch);

	try {
		await publish(tag, `Desktop ${version}`, [...assets, sumsAsset]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}

	// Only now. The manifest IS the update channel, so it goes live after the artifacts it names
	// exist — the other way round, every app checking in between reads a manifest whose download
	// 404s, and a failed update is indistinguishable from a broken updater.
	run(`node scripts/release-desktop.mjs --resume --quiet${universal ? "" : " --aarch64"}`);
	// The cask rides in that same commit, for the same reason: it names a .dmg by version, so it
	// points at a release that exists rather than one that is about to. Skipped on --aarch64,
	// which builds no universal disk image for it to point at, and the cask says universal.
	const channels = [DESKTOP_MANIFEST];
	if (universal) {
		updateCask(version, sums.get(expectedDmg) ?? fail(`${expectedDmg} is not in SHA256SUMS`));
		channels.push(DESKTOP_CASK);
	} else {
		console.error(
			`\nnote: ${DESKTOP_CASK} still points at the previous release, because --aarch64 builds ` +
				"no universal .dmg. `pnpm run test:brew` fails until a universal release is cut.",
		);
	}
	run(`git add ${channels.join(" ")}`);
	const commitMsg = `chore(release): desktop ${version} update manifest${universal ? " and cask" : ""}`;
	run(`git commit -m ${JSON.stringify(commitMsg)}`);
	run(`git push origin ${branch}`);

	// Last, and deliberately after the tag exists: the APT index names a .deb by version, and
	// publishing one for a release that was never cut is worse than publishing late. A failure
	// here does not invalidate anything above it — the GitHub release and the manifest are already
	// live — so it says how to finish rather than trying to unwind.
	if (process.platform === "darwin" || process.platform === "linux") {
		try {
			run("pnpm run publish:apt");
		} catch {
			console.error(
				`\n${tag} is released, but the APT repository was not updated.` +
					"\nDebian and Ubuntu users will not see it until you run:  pnpm run publish:apt" +
					"\n(Plug the YubiKey in first: signing the index wants two touches.)",
			);
		}
	}

	console.log(
		`\nreleased ${tag}: ${dmgs.join(", ")} + the Linux packages + updater archives, on the ` +
			`GitHub release.\nThe manifest is committed; installed apps see ${version} once the ` +
			"website deploy lands." +
			(universal
				? "\nThe cask is bumped too; check it against the release: pnpm run test:brew"
				: ""),
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

	requireBins(["age", "age-plugin-yubikey"], "docs/release-signing.md");

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
	// public/wasm is gitignored, and the tests below load it: a fresh clone has none.
	run("pnpm run wasm:build");
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

// The cask's two release-specific lines, rewritten in place. Everything else in that file is a
// decision with a comment attached to it, so this touches nothing else. It is the canonical copy
// only: the published one in homebrew/homebrew-cask is bumped by `brew bump-cask-pr`, usually by
// their livecheck bot before anyone gets to it. See docs/desktop-port.md.
function updateCask(version: string, sha256: string) {
	let after = readFileSync(DESKTOP_CASK, "utf8");
	let replaced = 0;
	for (const [field, value] of [
		["version", version],
		["sha256", sha256],
	] as const) {
		after = after.replace(new RegExp(`^([ \\t]*${field} ")[^"]*(")`, "m"), (_m, p1, p2) => {
			replaced++;
			return `${p1}${value}${p2}`;
		});
	}
	if (replaced !== 2)
		fail(`expected a version and a sha256 line in ${DESKTOP_CASK}, rewrote ${replaced}`);
	writeFileSync(DESKTOP_CASK, after);
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
// the SAME platform and this one, narrowed to the paths that target ships. GitHub's
// --generate-notes is useless here: it lists merged PRs (we commit straight to main, so it finds
// none) and picks the previous tag from the shared namespace (diffing android against a chromium
// tag).
async function releaseNotes(tag: string, platform: string): Promise<string> {
	const prev = capture(
		`git describe --tags --abbrev=0 --match '*-${platform}' ${tag}^ 2>/dev/null || true`,
	);
	// First release for a platform: there is no previous tag to diff against, and falling back to
	// the whole history lists every commit in the repo, most of them about other platforms. The
	// desktop 0.2.0 notes came out 871 lines long that way. Nobody wants to read that, and it
	// makes a milestone look like a changelog dump, so leave the body to be written by hand.
	if (!prev)
		return `First ${platform} release.\n\n_Release notes to follow; edit this release to add them._`;

	// An unknown platform would silently mean "no pathspec", i.e. every commit in the range, which
	// is the bug this filtering exists to fix. Better to notice it here than on the release page.
	const paths = PLATFORM_PATHS[platform];
	if (!paths) fail(`no release-note paths defined for platform "${platform}"`);
	const pathspec = [...paths, ...SHARED_PATHS].map((p) => JSON.stringify(p)).join(" ");

	const subjects = capture(`git log --no-merges --pretty=%s ${prev}..${tag} -- ${pathspec}`)
		.split("\n")
		.filter((s) => s && !/^chore\(release\)/.test(s))
		// `!== false` so only a scope naming OTHER platforms drops the commit; a neutral scope
		// returns null and stays.
		.filter((s) => scopedPlatforms(s)?.includes(platform) !== false);

	const repo = capture("gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true");
	const footer = repo
		? `**Full Changelog**: https://github.com/${repo}/compare/${prev}...${tag}`
		: "";

	return composeNotes({ subjects, footer, edit: !flags.has("--no-edit") });
}

// Draft -> upload -> publish, so the `release: published` event fires only once the
// signed artifacts are attached (CI verifies them on that event).
async function publish(tag: string, title: string, assets: string[]) {
	const notesDir = mkdtempSync(join(tmpdir(), "bramble-notes-"));
	const notesFile = join(notesDir, "NOTES.md");
	writeFileSync(notesFile, await releaseNotes(tag, platform));
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

function ok(cmd: string) {
	try {
		execSync(cmd, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Report every missing tool at once: finding them one per run means a rebuild between each.
// Declared inside the function: the callers run at module scope, before a top-level const
// would initialize. age-plugin-yubikey has no apt package and its pcsc-sys build needs the
// pcsclite headers; wasm-pack is pinned to ci.yml so the shipped wasm stays reproducible.
function requireBins(bins: string[], doc: string) {
	const install: Record<string, { darwin: string; linux: string }> = {
		age: { darwin: "brew install age", linux: "sudo apt install age" },
		"age-plugin-yubikey": {
			darwin: "brew install age-plugin-yubikey",
			linux:
				"sudo apt install libpcsclite-dev pkg-config && cargo install age-plugin-yubikey --locked",
		},
		gh: { darwin: "brew install gh", linux: "sudo apt install gh" },
		"wasm-pack": {
			darwin: "cargo install wasm-pack --locked --version 0.13.1",
			linux: "cargo install wasm-pack --locked --version 0.13.1",
		},
		"cargo-ndk": {
			darwin: "cargo install cargo-ndk --locked",
			linux: "cargo install cargo-ndk --locked",
		},
		rsync: { darwin: "preinstalled", linux: "sudo apt install rsync" },
		// The binary the deb bundler looks for; the package that carries it is xdg-utils.
		"xdg-open": { darwin: "not needed on macOS", linux: "sudo apt install xdg-utils" },
		// The APT repository (scripts/publish-apt.ts). aptly builds and signs the index, rclone
		// pushes it to R2, and docker runs the Linux build from a Mac.
		aptly: { darwin: "brew install aptly", linux: "sudo apt install aptly" },
		rclone: { darwin: "brew install rclone", linux: "sudo apt install rclone" },
		docker: {
			darwin: "brew install --cask docker",
			linux: "see docs/release-signing.md",
		},
	};
	const missing = bins.filter((b) => !has(b));
	if (!missing.length) return;
	const how = missing.map((b) => {
		const hint = install[b]?.[process.platform === "darwin" ? "darwin" : "linux"];
		return hint ? `  ${b}\n    ${hint}` : `  ${b}`;
	});
	fail(`missing required tools:\n${how.join("\n")}\nsee ${doc}`);
}

// Captures stdout so the plaintext never lands on disk; stdin/stderr stay on the terminal so
// the YubiKey PIN prompt still reaches you.
function ageDecrypt(file: string, idFile: string): string {
	return execFileSync("age", ["-d", "-i", idFile, file], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "inherit"],
	}).replace(/\n$/, "");
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
