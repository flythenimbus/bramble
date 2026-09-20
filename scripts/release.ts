// Cut a release entirely from your machine: bump the version, build (+ sign), tag,
// push, then publish a GitHub release with the artifacts attached.
//
// Usage:
//   pnpm run release chromium <version|patch|minor|major>   e.g. 1.0.0, or `patch` to bump
//   pnpm run release firefox  <version|patch|minor|major>
//   pnpm run release android  <version|patch|minor|major>
//        These three release from GitHub (docs/ci-releases.md): dispatch, then watch the run.
//        --dry-run   everything short of publishing: nothing committed, tagged or uploaded
//        --no-watch  return once the run exists
//        --local     the fallback: build, sign and publish on this machine, with the YubiKey
//        --resume    (android, local) sign the apk the last local run already built
//   pnpm run release ios      <version|patch|minor|major> [--ipa]
//                                       (--ipa = dry-run IPA on this machine, no upload or tag)
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
// ios builds and uploads in .github/workflows/ios-testflight.yml, which waits for an approval in
// the `ios-release` environment before it can reach any credential.
// android builds here on macOS (web bundle + Rust FFI + gradle assembleRelease) and signs the
// unsigned APK gradle emits with the YubiKey-held keystore. Signing setup lives in
// docs/release-signing.md.
// desktop publishes a GitHub release AND commits the updater manifest to the website, in that
// order — the manifest is the live update channel, so it must never name artifacts that are not
// there yet.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	appendFileSync,
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AMO_API, amoJwt } from "./amo-auth.ts";
import { ASC_KEY_AGE } from "./asc-api-key.ts";
import { CWS_ITEM_ID } from "./cws-ids.ts";
import { signingKey } from "./desktop-signing-key.ts";
import { commitFiles, createTag } from "./github-commit.ts";
import { composeNotes } from "./release-notes.mjs";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const HOME = process.env.HOME ?? "";
// On a runner GitHub says which repository this is; here it is the one this script ships.
const REPO = process.env.GITHUB_REPOSITORY ?? "flythenimbus/bramble";

// Up here rather than in the android section below, which is where they belong but not where they
// can live: the dispatch near the top of this file calls releaseAndroid while the module is still
// evaluating, and a `const` declared after that line does not exist yet when it runs.
const ANDROID = "packages/platform-mobile/android";
const ANDROID_GRADLE = `${ANDROID}/app/build.gradle`;
// gradle has no release signingConfig, so assembleRelease lands here UNSIGNED; apksigner signs it
// afterwards, once, from a keystore that only exists on disk for those few seconds.
const ANDROID_UNSIGNED = `${ANDROID}/app/build/outputs/apk/release/app-release-unsigned.apk`;
/** What a CI build job hands its publish job: see the *-release.yml workflows. */
const HANDOFF = "release-out";

const FIREFOX_MANIFEST = "packages/manifests/firefox/manifest.json";
/** What web-ext uploads to AMO, which signs it. */
const FIREFOX_DIST = "packages/platform-extension/dist-firefox";
/** The same build zipped, which the GitHub release carries beside its checksum. */
const FIREFOX_ZIP = "packages/platform-extension/bramble-firefox.zip";

const CHROME_MANIFEST = "packages/manifests/chromium/manifest.json";
/** What crx3 packs, with the dev `key` already stripped from its manifest. */
const CHROME_DIST = "packages/platform-extension/dist-chromium";
const CHROME_ZIP = "packages/platform-extension/bramble.zip";
const CHROME_CRX = "packages/platform-extension/bramble.crx";

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

// Desktop only: `--skip=windows` or `--skip=macos,linux` releases without those platforms. See
// docs/ci-releases.md for what skipping a platform that has already shipped costs its users.
const DESKTOP_PLATFORMS = ["macos", "linux", "windows"];
const skipArg = argv.find((a) => a.startsWith("--skip="));
const skip = new Set(
	(skipArg?.slice("--skip=".length) ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean),
);
if (!platform)
	fail(
		"usage: pnpm run release <chromium|firefox|android|ios|desktop> <version|patch|minor|major>",
	);
if (!rawVersion)
	fail(`missing version. usage: pnpm run release ${platform} <version|patch|minor|major>`);
if (skipArg) {
	if (platform !== "desktop") fail("--skip is for desktop releases");
	const unknown = [...skip].filter((p) => !DESKTOP_PLATFORMS.includes(p));
	if (unknown.length)
		fail(`--skip takes ${DESKTOP_PLATFORMS.join(", ")}; not ${unknown.join(", ")}`);
	if (DESKTOP_PLATFORMS.every((p) => skip.has(p))) fail("--skip leaves nothing to release");
	// --resume implies the local route, like --local and --aarch64 do.
	if (flags.has("--local") || flags.has("--aarch64") || flags.has("--resume"))
		fail("--skip is for a release from GitHub; the local route builds every platform");
}

// The version arg is either an explicit version (0.1.0 or v0.1.0, stored bare) or a semver bump
// keyword (patch/minor/major) that increments THIS target's current version. Each target versions
// independently, so a bump reads that target's own manifest/gradle/pbxproj.
// Which route this run takes. GitHub builds, signs and publishes wherever it can
// (docs/ci-releases.md); --local is the fallback that does it all on this machine with the
// YubiKey. --resume re-signs a build this machine made, so it is local by definition, and so is
// --ipa, which builds a signed iOS build here and uploads nothing.
const CI_TARGETS = new Set(["android", "firefox", "chromium", "desktop", "ios"]);
const onRunner = [
	"--runner-build",
	"--runner-publish",
	"--runner-bump",
	"--runner-prepare",
	"--runner-compile",
].some((f) => flags.has(f));
// --aarch64 is an Apple-Silicon-only build for iterating, which a release never is: local. So is
// --ipa, which builds a signed iOS build here and uploads nothing.
const viaCi =
	CI_TARGETS.has(platform) &&
	!onRunner &&
	!flags.has("--local") &&
	!flags.has("--resume") &&
	!flags.has("--aarch64") &&
	!flags.has("--ipa");

if (!onRunner) {
	requireBins(["gh"], "docs/release-signing.md");
	// --active, because a bare `gh auth status` exits non-zero when ANY stored account is broken,
	// including one for a different login that this repo never uses. What a release needs is the
	// account gh will actually act as.
	if (!ok("gh auth status --active"))
		fail("gh's active account cannot log in; run `gh auth login`");
}

const bumpKind = ["patch", "minor", "major"].includes(rawVersion)
	? (rawVersion as "patch" | "minor" | "major")
	: null;
// From GitHub's main when GitHub is doing the release. It commits the bump there, so this clone
// falls a release behind after every one, and `minor` read from it would name a version that
// already shipped.
const version = bumpKind
	? nextVersion(currentVersion(platform, viaCi ? readFromMain : undefined), bumpKind)
	: rawVersion.replace(/^v/, "");

// Every path but ios ends in `gh release create`, and finding gh missing or logged out there
// means the store publish and the tag already happened. An installed gh is not enough. ios needs
// it as much: it commits, tags and dispatches through the API.

// Commit signing, when the repo asks for it. Every path ends in commitTagPush, which commits
// AFTER the store upload, so a key that isn't available surfaced ten minutes in - with the build
// already on TestFlight or the extension already published, and no commit or tag pointing at the
// source that produced it. Nothing recovers from there either: the bump revert guards the BUILD
// failing, not the commit, so the tree is left dirty next to a shipped artifact.
//
// Proven with a throwaway commit object rather than by inspecting config: it runs git's own
// signing path (gpg.format, user.signingkey, the signing program), so it catches an unplugged
// security key, a locked agent and a misconfigured key alike. It moves no ref and writes an
// unreferenced object, which gc collects.
//
// --ipa is exempt: that dry run returns before it commits or tags anything.
if (
	!flags.has("--ipa") &&
	!viaCi &&
	!onRunner &&
	capture("git config --get commit.gpgsign || true") === "true"
) {
	// No touch banner here, unlike the age decrypts: this runs before anything slow, while you
	// are still watching the terminal, and the key may not be hardware-backed at all.
	if (!ok('git commit-tree HEAD^{tree} -p HEAD -S -m "release signing check"'))
		fail(
			"commit signing failed, so the release commit would fail after the upload. Plug in the " +
				"security key and unlock the agent (or unset commit.gpgsign). See docs/release-signing.md.",
		);
}

if (platform === "android") await releaseAndroid(version, flags.has("--resume"));
else if (platform === "ios") await releaseIos(version, flags.has("--ipa"), viaCi);
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

	// The CI route: dispatched from here, built and submitted on runners. docs/ci-releases.md.
	if (viaCi) return dispatchRelease("chrome-release.yml", version, tag);
	if (flags.has("--runner-build")) return runnerBuildChrome(version, tag);
	if (flags.has("--runner-publish")) return runnerPublishChrome(version, tag);

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

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = bumpManifestVersion(manifest, version).length > 0;

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
	// Firefox manifest versions follow the same 1-4 dotted-int rule as Chrome.
	const PART = /^(0|[1-9]\d{0,4})$/;
	const parts = version.split(".");
	if (parts.length > 4 || parts.some((p) => !PART.test(p) || Number(p) > 65535))
		fail(`invalid version "${version}". want 1-4 ints, each 0-65535 (e.g. 1.0.0)`);

	const tag = `${version}-firefox`;

	// The CI route: dispatched from here, built and submitted on runners. docs/ci-releases.md.
	if (viaCi) return dispatchRelease("firefox-release.yml", version, tag);
	if (flags.has("--runner-build")) return runnerBuildFirefox(version, tag);
	if (flags.has("--runner-publish")) return runnerPublishFirefox(version, tag);
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

	const branch = capture("git rev-parse --abbrev-ref HEAD");
	const bumped = bumpManifestVersion(FIREFOX_MANIFEST, version).length > 0;

	try {
		buildFirefox();
	} catch {
		fail(
			`build or addons-linter validation failed (nothing uploaded); run \`git checkout ${FIREFOX_MANIFEST}\` to undo the bump`,
		);
	}

	try {
		run("pnpm run sign:firefox");
	} catch {
		fail(`signing failed; run \`git checkout ${FIREFOX_MANIFEST}\` to undo the bump`);
	}

	if (!existsSync(FIREFOX_ZIP)) fail(`expected ${FIREFOX_ZIP} from bundle:firefox`);

	commitTagPush(bumped, FIREFOX_MANIFEST, `chore(release): firefox ${version}`, tag, branch);

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const zipAsset = join(stage, `bramble_firefox_${version}.zip`);
	copyFileSync(FIREFOX_ZIP, zipAsset);
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
	// versionName is the marketing version; 1-3 dot-separated ints (matches bump:mobile).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	const tag = `${version}-android`;

	// The CI route: dispatched from here, built and published on runners. docs/ci-releases.md.
	if (viaCi) return dispatchRelease("android-release.yml", version, tag);
	if (flags.has("--runner-build")) return runnerBuildAndroid(version, tag);
	if (flags.has("--runner-publish")) return runnerPublishAndroid(version, tag);
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
		if (!existsSync(ANDROID_UNSIGNED))
			fail(`no unsigned apk at ${ANDROID_UNSIGNED}; nothing to resume, re-run without --resume`);
		const head = capture("git log -1 --pretty=%s");
		if (head !== `chore(release): android ${version}`)
			fail(`HEAD is "${head}", not the android ${version} release commit`);
		versionCode = Number(readFileSync(ANDROID_GRADLE, "utf8").match(/versionCode (\d+)/)?.[1] ?? 0);
		const aapt2 =
			findBuildTool("aapt2") ??
			fail("aapt2 not found (Android SDK build-tools), needed by --resume");
		const badging = execFileSync(aapt2, ["dump", "badging", ANDROID_UNSIGNED], {
			encoding: "utf8",
		});
		const built = `${badging.match(/versionCode='(\d+)'/)?.[1]}/${badging.match(/versionName='([^']*)'/)?.[1]}`;
		if (built !== `${versionCode}/${version}`)
			fail(
				`${ANDROID_UNSIGNED} is ${built}, but HEAD is ${versionCode}/${version}; rebuild without --resume`,
			);
		commit = capture("git rev-parse HEAD");
		console.log(`resuming ${tag}: signing the apk built from ${commit.slice(0, 9)}`);
	} else {
		gate();

		// Bump versionName + a deterministic, committed versionCode (seconds-since-2020, kept monotonic),
		// snapshot the changelogs, and COMMIT before building, so the tag names the exact tree the
		// published APK was built from.
		const bumped = bumpAndroid(version);
		versionCode = bumped.versionCode;
		run(`git add ${bumped.files.join(" ")}`);
		run(`git commit -m ${JSON.stringify(`chore(release): android ${version}`)}`);
		commit = capture("git rev-parse HEAD");

		// Build on this machine: web bundle -> native crypto libs (4 ABIs) -> cap sync -> gradle.
		// A failure here rewinds the release commit so the tree is clean for a retry (the bump +
		// changelogs regenerate next run); nothing was published yet.
		try {
			console.log(`\nbuilding ${commit.slice(0, 9)}…`);
			buildAndroidUnsigned(versionCode, java21);
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
		signApk({ apksigner, java21, ksFile, keyAlias, storePassword, keyPassword, out: apkAsset });
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
		fail(
			`signing failed (${(e as Error).message}); the release commit and ${ANDROID_UNSIGNED} are kept.` +
				`\nre-run to sign that same build, with no rebuild: pnpm run release android ${version} --resume`,
		);
	}
	rmSync(tmp, { recursive: true, force: true });

	// Confirm the signed apk's cert before publishing (versionCode is what we committed).
	const cert = assertReleaseCert(apksigner, java21, apkAsset);
	console.log(`\nAPK signing cert SHA-256: ${cert}  |  versionCode ${versionCode}`);

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

/**
 * Bump versionName and a deterministic, monotonic versionCode (seconds since 2020), then snapshot
 * the changelogs under that code. Returns every file it wrote, for whichever path commits them.
 */
function bumpAndroid(version: string): { versionCode: number; files: string[] } {
	const before = readFileSync(ANDROID_GRADLE, "utf8");
	const prevCode = Number(before.match(/versionCode (\d+)/)?.[1] ?? 0);
	const versionCode = Math.max(prevCode + 1, Math.floor(Date.now() / 1000) - 1_577_836_800);
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
		fail(`expected exactly one versionName in ${ANDROID_GRADLE}, found ${replacedName}`);
	if (replacedCode !== 1)
		fail(`expected exactly one versionCode in ${ANDROID_GRADLE}, found ${replacedCode}`);
	writeFileSync(ANDROID_GRADLE, after);
	return {
		versionCode,
		files: [ANDROID_GRADLE, ...snapshotAndroidChangelogs(String(versionCode))],
	};
}

/**
 * Web bundle -> native crypto libs (4 ABIs) -> cap sync -> gradle, ending in an unsigned apk that
 * carries `versionCode`. Throws rather than failing, so each caller decides what to rewind.
 */
function buildAndroidUnsigned(versionCode: number, java21: string): void {
	// Stale-output guard: assembleRelease writing nothing (skipped task, wrong variant) would
	// otherwise leave the previous run's apk in place and sign that instead.
	rmSync(ANDROID_UNSIGNED, { force: true });
	run("pnpm run core:build");
	run("pnpm run ffi:build:android");
	run("pnpm --filter @vault/platform-mobile exec cap sync android");
	execFileSync(
		join(ANDROID, "gradlew"),
		["-p", ANDROID, "assembleRelease", `-Porg.gradle.java.installations.paths=${java21}`],
		{ stdio: "inherit", env: { ...process.env, JAVA_HOME: java21 } },
	);
	if (!existsSync(ANDROID_UNSIGNED)) throw new Error(`gradle did not produce ${ANDROID_UNSIGNED}`);
	// The apk has to carry the versionCode the release commit will; anything else means gradle read
	// a different build.gradle than the one the tag will point at.
	const outMeta = `${ANDROID}/app/build/outputs/apk/release/output-metadata.json`;
	const builtCode = JSON.parse(readFileSync(outMeta, "utf8"))?.elements?.[0]?.versionCode;
	if (builtCode !== versionCode)
		throw new Error(`built versionCode ${builtCode} != expected ${versionCode} (${outMeta})`);
}

/** Sign gradle's unsigned apk into `out`. Passwords go by environment, never argv. */
function signApk(o: {
	apksigner: string;
	java21: string;
	ksFile: string;
	keyAlias: string;
	storePassword: string;
	keyPassword: string;
	out: string;
}): void {
	execFileSync(
		o.apksigner,
		[
			"sign",
			"--ks",
			o.ksFile,
			"--ks-key-alias",
			o.keyAlias,
			"--ks-pass",
			"env:BR_KS_PASS",
			"--key-pass",
			"env:BR_KEY_PASS",
			"--v1-signing-enabled",
			"false",
			"--out",
			o.out,
			ANDROID_UNSIGNED,
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				JAVA_HOME: o.java21,
				BR_KS_PASS: o.storePassword,
				BR_KEY_PASS: o.keyPassword,
			},
		},
	);
}

/**
 * The signing cert's SHA-256, asserted equal to the fingerprint users are told to check. That lives
 * in packages/platform-mobile/README.md as the single published source of truth, so it is read from
 * there rather than copied: a wrong keystore can never publish, whether or not anyone is watching.
 */
function assertReleaseCert(apksigner: string, java21: string, apk: string): string {
	const out = execFileSync(apksigner, ["verify", "--print-certs", apk], {
		encoding: "utf8",
		env: { ...process.env, JAVA_HOME: java21 },
	});
	const cert = out.match(/SHA-256 digest:\s*([0-9a-f]{64})/i)?.[1]?.toLowerCase();
	const readme = readFileSync("packages/platform-mobile/README.md", "utf8");
	const published = readme
		.match(/\b([0-9A-F]{2}(?::[0-9A-F]{2}){31})\b/i)?.[1]
		?.replace(/:/g, "")
		.toLowerCase();
	if (!published) fail("no certificate fingerprint in packages/platform-mobile/README.md");
	if (cert !== published)
		fail(
			`${basename(apk)} is signed by ${cert ?? "an unreadable certificate"}, not the published ` +
				`${published}. Wrong keystore: nothing has been published.`,
		);
	return cert as string;
}

/**
 * Download what users will download, from the draft, and check it against its SHA256SUMS before it
 * goes public, plus whatever else `check` asks of each file. Runs inside publish(), so a failure
 * leaves a draft rather than a release.
 */
function verifyDraft(tag: string, pattern: string, check?: (file: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "bramble-verify-"));
	try {
		run(`gh release download ${tag} --pattern '${pattern}' --pattern SHA256SUMS --dir ${dir}`);
		const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
		for (const line of sums) {
			const [hash, name] = line.split(/\s+/);
			const file = join(dir, name as string);
			const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
			if (actual !== hash) fail(`${name} on the draft does not match SHA256SUMS; left as a draft`);
			check?.(file);
		}
		console.log(`draft verified: ${pattern} matches SHA256SUMS`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The GitHub route: nothing is built or signed here. Dispatches the target's workflow, then watches
 * the run to the end so this command still reports how the release went. `--dry-run` dispatches a
 * dry run instead; `--no-watch` returns as soon as the run exists.
 */
function dispatchRelease(
	workflow: string,
	version: string,
	tag: string,
	inputs: Record<string, string> = {},
): void {
	const dryRun = flags.has("--dry-run");
	// Checked on GitHub rather than locally: runners tag through the API, so a clone can lag.
	if (ok(`gh api repos/${REPO}/git/ref/tags/${tag}`)) fail(`tag ${tag} already exists on GitHub`);

	// A run created before this instant is somebody else's. gh returns before the run exists.
	const since = new Date(Date.now() - 5_000).toISOString();
	try {
		run(
			`gh workflow run ${workflow} --repo ${REPO} --ref main -f version=${version} -f dry_run=${dryRun}` +
				Object.entries(inputs)
					.map(([k, v]) => ` -f ${k}=${JSON.stringify(v)}`)
					.join(""),
		);
	} catch {
		fail(`could not dispatch ${workflow} (above). It has to exist on main to be dispatched.`);
	}
	const id = findRun(workflow, since);
	const url = `https://github.com/${REPO}/actions/runs/${id}`;
	const environment = workflow.replace(/\.yml$/, "");
	console.log(
		`\ndispatched ${dryRun ? "a dry run of " : ""}${tag}: ${url}` +
			`\nThe build runs now; the rest waits for your approval in ${environment} once it is done.`,
	);
	if (flags.has("--no-watch")) return;

	console.log("watching it (Ctrl-C stops watching, not the release)…");
	try {
		run(`gh run watch ${id} --repo ${REPO} --exit-status`);
	} catch {
		fail(`the run failed: ${url}`);
	}
	console.log(
		dryRun
			? `\ndry run of ${tag} passed. Nothing was committed or published.`
			: `\nreleased ${tag}.`,
	);
}

/** The run a dispatch just created: the newest one of that workflow created after `since`. */
function findRun(workflow: string, since: string): string {
	for (let i = 0; i < 30; i++) {
		const runs = JSON.parse(
			capture(
				`gh run list --repo ${REPO} --workflow ${workflow} --event workflow_dispatch --limit 5 --json databaseId,createdAt`,
			),
		) as { databaseId: number; createdAt: string }[];
		const mine = runs
			.filter((r) => r.createdAt >= since)
			.sort((a, b) => b.databaseId - a.databaseId);
		if (mine[0]) return String(mine[0].databaseId);
		// Synchronous on purpose, like build-windows.ts: everything here is sequential.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
	}
	return fail(`dispatched ${workflow}, but no run appeared in a minute; check the Actions tab`);
}

/**
 * `--runner-build`, the first job of android-release.yml. No secret reaches this job, which is what
 * allows it third-party actions: it builds an UNSIGNED apk and hands it over, with the files the
 * release commit will carry and the commit they were built from, to the job holding the keystore.
 */
function runnerBuildAndroid(version: string, tag: string): void {
	if (!process.env.GITHUB_ACTIONS) fail("--runner-build runs in android-release.yml");
	// Releases come from main: the publish job commits onto it, and only onto what this built.
	if (process.env.GITHUB_REF_NAME !== "main")
		fail(`releases are cut from main, not ${process.env.GITHUB_REF_NAME}`);
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);
	const base = capture("git rev-parse HEAD");

	gate();
	const { versionCode, files } = bumpAndroid(version);
	console.log(`\nbuilding ${version} (versionCode ${versionCode}) from ${base.slice(0, 9)}…`);
	try {
		buildAndroidUnsigned(versionCode, resolveJava21());
	} catch (e) {
		fail(`build failed: ${(e as Error).message}`);
	}

	rmSync(HANDOFF, { recursive: true, force: true });
	mkdirSync(HANDOFF, { recursive: true });
	copyFileSync(ANDROID_UNSIGNED, join(HANDOFF, "app-release-unsigned.apk"));
	for (const f of files) {
		mkdirSync(dirname(join(HANDOFF, "files", f)), { recursive: true });
		copyFileSync(f, join(HANDOFF, "files", f));
	}
	writeFileSync(
		join(HANDOFF, "meta.json"),
		JSON.stringify({ version, versionCode, base, files }, null, 2),
	);
	console.log(`handed off ${HANDOFF}/: the unsigned apk and ${files.length} file(s)`);
}

/**
 * `--runner-publish`, the second job, and the only place the keystore exists. Signs the build job's
 * apk, holds the cert to the published fingerprint, commits the bump through GitHub's API (verified,
 * and only onto the commit the build started from), tags it, and publishes.
 *
 * It verifies the release itself instead of leaving that to release.yml, because a release created
 * with a workflow's own token does not fire other workflows: release.yml never sees this one.
 */
async function runnerPublishAndroid(version: string, tag: string): Promise<void> {
	if (!process.env.GITHUB_ACTIONS) fail("--runner-publish runs in android-release.yml");
	const meta = JSON.parse(readFileSync(join(HANDOFF, "meta.json"), "utf8"));
	if (meta.version !== version) fail(`the handoff is for ${meta.version}, not ${version}`);
	const head = capture("git rev-parse HEAD");
	if (head !== meta.base)
		fail(`checked out ${head.slice(0, 9)}, but the apk was built from ${meta.base.slice(0, 9)}`);

	// `||`, not `??`: a secret the environment does not have arrives as an empty string.
	const keystore =
		process.env.ANDROID_KEYSTORE_BASE64 || fail("no ANDROID_KEYSTORE_BASE64 in android-release");
	const storePassword =
		process.env.ANDROID_KEYSTORE_PASSWORD ||
		fail("no ANDROID_KEYSTORE_PASSWORD in android-release");
	const keyPassword = process.env.ANDROID_KEY_PASSWORD || storePassword;
	const keyAlias = process.env.ANDROID_KEY_ALIAS || "bramble";
	const apksigner = findBuildTool("apksigner") ?? fail("apksigner not found in the Android SDK");
	const java21 = resolveJava21();

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const apkName = `bramble_android_${version}.apk`;
	const apkAsset = join(stage, apkName);
	const tmp = mkdtempSync(join(tmpdir(), "bramble-android-"));
	try {
		const ksFile = join(tmp, "release.jks");
		writeFileSync(ksFile, Buffer.from(keystore, "base64"), { mode: 0o600 });
		mkdirSync(dirname(ANDROID_UNSIGNED), { recursive: true });
		copyFileSync(join(HANDOFF, "app-release-unsigned.apk"), ANDROID_UNSIGNED);
		signApk({ apksigner, java21, ksFile, keyAlias, storePassword, keyPassword, out: apkAsset });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	const cert = assertReleaseCert(apksigner, java21, apkAsset);
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(
		sumsAsset,
		`${createHash("sha256").update(readFileSync(apkAsset)).digest("hex")}  ${apkName}\n`,
	);

	// --dry-run stops at the last point where nothing is public: everything a release proves about
	// the keystore, the password and the cert has been proven, and nothing has been committed.
	if (flags.has("--dry-run")) {
		rmSync(stage, { recursive: true, force: true });
		console.log(
			`\ndry run: ${apkName} built, signed and matched to the published cert ${cert}.` +
				`\nNothing was committed, tagged or published; ${tag} is still free.`,
		);
		return;
	}

	// Nothing has left this runner until here. From the commit on, it is public.
	const files = meta.files as string[];
	for (const f of files) copyFileSync(join(HANDOFF, "files", f), f);
	const commit = commitFiles({
		repo: REPO,
		branch: "main",
		expectedHeadOid: meta.base,
		headline: `chore(release): android ${version}`,
		files,
	});
	createTag(REPO, tag, commit);
	// releaseNotes walks the range locally, so the new commit and tag have to be here too.
	run(`git fetch --quiet origin refs/tags/${tag}:refs/tags/${tag}`);
	try {
		await publish(tag, `Android ${version}`, [apkAsset, sumsAsset], () =>
			verifyDraft(tag, "*.apk", (file) => assertReleaseCert(apksigner, java21, file)),
		);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag} (commit ${commit.slice(0, 9)}): ${apkName}, versionCode ${meta.versionCode}, cert ${cert}.`,
	);
}

// ----- browser extensions: the CI route -----
//
// Firefox and Chrome share a shape. A build job with no secrets gates, bumps the manifest and
// builds; a publish job holding the store credentials runs a preflight against the store, commits
// the bump through GitHub's API, submits, tags and publishes.
//
// The release commit comes BEFORE the store submission, the reverse of Android. A submission cannot
// be taken back and the commit can fail (main moved since the build), so the other order risks a
// version live in a store that the repository never recorded. Committing first makes the failure
// case a bump commit with nothing submitted, which a re-dispatch of the same version finishes: the
// manifest already matches, so the build changes nothing and the publish job tags what is there.

type Handoff = { version: string; base: string; files: string[] };

/** Set a manifest's version. Returns the files it changed, which is none when it already matches. */
function bumpManifestVersion(manifest: string, version: string): string[] {
	const before = readFileSync(manifest, "utf8");
	let replaced = 0;
	const after = before.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
		replaced++;
		return `${p1}${version}${p2}`;
	});
	if (replaced !== 1)
		fail(`expected exactly one "version" field in ${manifest}, found ${replaced}`);
	if (after === before) return [];
	writeFileSync(manifest, after);
	return [manifest];
}

/** Dotted versions compared numerically, part by part: 1.10 is above 1.9. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** What every build job checks before building. Returns the commit it builds from. */
function runnerBuildStart(workflow: string, tag: string, mode = "--runner-build"): string {
	if (!process.env.GITHUB_ACTIONS) fail(`${mode} runs in ${workflow}`);
	// Releases come from main: the publish job commits onto it, and only onto what this built.
	if (process.env.GITHUB_REF_NAME !== "main")
		fail(`releases are cut from main, not ${process.env.GITHUB_REF_NAME}`);
	if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);
	return capture("git rev-parse HEAD");
}

/**
 * Hand a build to its publish job. `outputs` maps a name in the handoff to where the build left it,
 * file or directory; `meta.files` are the ones the release commit will carry.
 */
function handOff(meta: Handoff, outputs: Record<string, string>): void {
	rmSync(HANDOFF, { recursive: true, force: true });
	mkdirSync(HANDOFF, { recursive: true });
	for (const [name, path] of Object.entries(outputs))
		cpSync(path, join(HANDOFF, name), { recursive: true });
	for (const f of meta.files) {
		mkdirSync(dirname(join(HANDOFF, "files", f)), { recursive: true });
		copyFileSync(f, join(HANDOFF, "files", f));
	}
	writeFileSync(join(HANDOFF, "meta.json"), JSON.stringify(meta, null, 2));
	console.log(
		`handed off ${HANDOFF}/: ${Object.keys(outputs).join(", ")} and ${meta.files.length} file(s)`,
	);
}

/** The publish side: prove the handoff is this run's, and put every output back where it was. */
function receiveHandoff(
	workflow: string,
	version: string,
	outputs: Record<string, string>,
): Handoff {
	if (!process.env.GITHUB_ACTIONS) fail(`--runner-publish runs in ${workflow}`);
	const meta = JSON.parse(readFileSync(join(HANDOFF, "meta.json"), "utf8")) as Handoff;
	if (meta.version !== version) fail(`the handoff is for ${meta.version}, not ${version}`);
	const head = capture("git rev-parse HEAD");
	if (head !== meta.base)
		fail(`checked out ${head.slice(0, 9)}, but this was built from ${meta.base.slice(0, 9)}`);
	for (const [name, path] of Object.entries(outputs)) {
		rmSync(path, { recursive: true, force: true });
		cpSync(join(HANDOFF, name), path, { recursive: true });
	}
	for (const f of meta.files) copyFileSync(join(HANDOFF, "files", f), f);
	return meta;
}

/** The release commit, through GitHub's API; the base itself when the manifest already matched. */
function commitRelease(meta: Handoff, headline: string): string {
	return meta.files.length
		? commitFiles({
				repo: REPO,
				branch: "main",
				expectedHeadOid: meta.base,
				headline,
				files: meta.files,
			})
		: meta.base;
}

/** SHA256SUMS over the given release assets, written beside them. */
function writeSums(assets: string[]): string {
	const sums = join(dirname(assets[0] as string), "SHA256SUMS");
	writeFileSync(
		sums,
		assets
			.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${basename(f)}\n`)
			.join(""),
	);
	return sums;
}

// firefox

/** Bundle and lint. Throws, so each caller decides what to undo. */
function buildFirefox(): void {
	run("pnpm --filter @vault/platform-extension run bundle:firefox");
	// AMO's addons-linter, run BEFORE signing. Signing uploads to AMO and consumes the version (AMO
	// won't re-sign it), so catching a validation error here costs nothing: nothing was uploaded,
	// so it is fixed and the SAME version retried.
	run("pnpm --filter @vault/platform-extension run lint:firefox");
}
/**
 * Before anything is committed or uploaded: prove the credentials, prove they belong to an author of
 * this add-on (the listing is only visible with unlisted versions to one), and prove `version` is
 * above every version AMO already holds. An upload consumes its version whatever happens next, and
 * a release commit made for a version AMO will then refuse is exactly the stranded state this
 * exists to rule out. Returns the latest version AMO has.
 */
async function amoPreflight(version: string, apiKey: string, apiSecret: string): Promise<string> {
	const manifest = JSON.parse(readFileSync(FIREFOX_MANIFEST, "utf8"));
	const guid =
		manifest.browser_specific_settings?.gecko?.id ?? fail(`no gecko id in ${FIREFOX_MANIFEST}`);
	const url = `${AMO_API}/addons/addon/${encodeURIComponent(guid)}/versions/?filter=all_with_unlisted&page_size=50`;
	const res = await fetch(url, { headers: { authorization: `JWT ${amoJwt(apiKey, apiSecret)}` } });
	if (!res.ok)
		fail(
			`AMO refused the credentials for ${guid} (${res.status}): ${(await res.text()).slice(0, 200)}`,
		);
	const versions: string[] = ((await res.json()).results ?? []).map(
		(v: { version: string }) => v.version,
	);
	const latest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), "0");
	if (compareVersions(version, latest) <= 0)
		fail(
			`${version} is not above ${latest}, the latest version AMO holds, and AMO would refuse it.` +
				(versions.includes(version)
					? `\n${version} is already on AMO: if a previous run submitted it, tag ${version}-firefox by hand.`
					: ""),
		);
	return latest;
}

/** `--runner-build` for firefox-release.yml: gate, bump, bundle and lint, then hand off. */
function runnerBuildFirefox(version: string, tag: string): void {
	const base = runnerBuildStart("firefox-release.yml", tag);
	gate();
	const files = bumpManifestVersion(FIREFOX_MANIFEST, version);
	try {
		buildFirefox();
	} catch (e) {
		fail(`build or addons-linter validation failed: ${(e as Error).message}`);
	}
	handOff(
		{ version, base, files },
		{ "dist-firefox": FIREFOX_DIST, "bramble-firefox.zip": FIREFOX_ZIP },
	);
}

/**
 * `--runner-publish` for firefox-release.yml, and the only job holding the AMO credentials. Mozilla
 * does the signing, so what is guarded here is the version, which an upload consumes for good.
 */
async function runnerPublishFirefox(version: string, tag: string): Promise<void> {
	const meta = receiveHandoff("firefox-release.yml", version, {
		"dist-firefox": FIREFOX_DIST,
		"bramble-firefox.zip": FIREFOX_ZIP,
	});
	// `||`, not `??`: a secret the environment does not have arrives as an empty string.
	const apiKey = process.env.AMO_API_KEY || fail("no AMO_API_KEY in firefox-release");
	const apiSecret = process.env.AMO_API_SECRET || fail("no AMO_API_SECRET in firefox-release");

	const latest = await amoPreflight(version, apiKey, apiSecret);
	console.log(`AMO: the credentials work, and ${version} is above the latest it holds, ${latest}`);

	// --dry-run proves the one other thing this runner must manage: the source archive reviewers
	// rebuild from. It is a stash of the working tree, which needs a git identity to make.
	if (flags.has("--dry-run")) {
		const tmp = mkdtempSync(join(tmpdir(), "bramble-source-"));
		try {
			const tree = capture("git stash create") || "HEAD";
			run(`git archive --format=zip -o ${join(tmp, "source.zip")} ${tree}`);
			const kb = Math.round(readFileSync(join(tmp, "source.zip")).length / 1024);
			console.log(
				`\ndry run: ${version} built, linted and cleared by AMO's preflight; source archive ${kb} KB.` +
					`\nNothing was committed, uploaded, tagged or published; ${tag} is still free.`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		return;
	}

	const commit = commitRelease(meta, `chore(release): firefox ${version}`);
	try {
		// Env credentials, so sign-firefox.ts never reaches for the YubiKey.
		run("pnpm run sign:firefox");
	} catch {
		fail(
			`AMO submission failed after the release commit ${commit.slice(0, 9)}. Re-dispatch ${version}` +
				" once fixed: the manifest already matches, so it tags this commit and submits again.",
		);
	}
	createTag(REPO, tag, commit);
	run(`git fetch --quiet origin refs/tags/${tag}:refs/tags/${tag}`);

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const zipAsset = join(stage, `bramble_firefox_${version}.zip`);
	copyFileSync(FIREFOX_ZIP, zipAsset);
	const sumsAsset = writeSums([zipAsset]);
	try {
		await publish(tag, `Firefox Extension ${version}`, [zipAsset, sumsAsset], () =>
			verifyDraft(tag, "*.zip"),
		);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag} (commit ${commit.slice(0, 9)}): submitted to AMO for listed review; source zip + SHA256SUMS on the GitHub release.`,
	);
}

// chrome

/** The version live on the Chrome Web Store, from the same update service Chrome itself polls. */
async function chromeLiveVersion(): Promise<string> {
	// A far-future prodversion, so a rising minimum_chrome_version can never hide the answer.
	const url =
		"https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3" +
		`&prodversion=999.0&x=${encodeURIComponent(`id=${CWS_ITEM_ID}&uc`)}`;
	const res = await fetch(url);
	if (!res.ok) fail(`the Chrome update service answered ${res.status}`);
	// Inside <updatecheck>: the response's first version="" is the XML declaration's own.
	const version = (await res.text()).match(/<updatecheck\b[^>]*\bversion="([^"]+)"/)?.[1];
	return version ?? fail(`the Chrome update service reported no version for ${CWS_ITEM_ID}`);
}

/** A CRX3 package starts with "Cr24"; anything else is not one, and the store would refuse it. */
function assertCrx(file: string): void {
	const magic = readFileSync(file).subarray(0, 4).toString("latin1");
	if (magic !== "Cr24")
		fail(`${basename(file)} is not a CRX3 package (it starts with ${JSON.stringify(magic)})`);
}

/** `--runner-build` for chrome-release.yml: gate, bump and bundle, then hand off. */
function runnerBuildChrome(version: string, tag: string): void {
	const base = runnerBuildStart("chrome-release.yml", tag);
	gate();
	const files = bumpManifestVersion(CHROME_MANIFEST, version);
	try {
		run("pnpm --filter @vault/platform-extension run bundle:chromium");
	} catch (e) {
		fail(`build failed: ${(e as Error).message}`);
	}
	handOff({ version, base, files }, { "dist-chromium": CHROME_DIST, "bramble.zip": CHROME_ZIP });
}

/**
 * `--runner-publish` for chrome-release.yml. Packs the .crx with the CWS signing key, submits it
 * with the service account, and publishes.
 *
 * crx3 takes the key as a file, so both secrets are written to 0600 files in a 0700 directory for
 * the seconds packing and submission take, then removed: what the local route already does in
 * primeCwsSecrets, and the one place a runner here holds a credential on disk rather than in memory.
 */
async function runnerPublishChrome(version: string, tag: string): Promise<void> {
	const meta = receiveHandoff("chrome-release.yml", version, {
		"dist-chromium": CHROME_DIST,
		"bramble.zip": CHROME_ZIP,
	});
	const keyPem =
		process.env.CWS_KEY_PEM_CONTENT || fail("no CWS_KEY_PEM_CONTENT in chrome-release");
	const account =
		process.env.CWS_SERVICE_ACCOUNT_CONTENT ||
		fail("no CWS_SERVICE_ACCOUNT_CONTENT in chrome-release");

	// Before anything is packed or committed: the store would refuse a version that is not above
	// the live one, and after a release commit that is a stranded bump.
	const live = await chromeLiveVersion();
	if (compareVersions(version, live) <= 0)
		fail(`${version} is not above ${live}, the version live on the Chrome Web Store`);

	const secrets = mkdtempSync(join(tmpdir(), "bramble-cws-"));
	// On any exit, fail() included: finally does not run past process.exit.
	const clear = () => rmSync(secrets, { recursive: true, force: true });
	process.once("exit", clear);
	let commit = meta.base;
	try {
		writeFileSync(join(secrets, "key.pem"), keyPem, { mode: 0o600 });
		writeFileSync(join(secrets, "sa.json"), account, { mode: 0o600 });
		process.env.CWS_KEY_PEM = join(secrets, "key.pem");
		process.env.CWS_SERVICE_ACCOUNT_JSON = join(secrets, "sa.json");

		try {
			run("node scripts/sign-cws.ts --check");
		} catch {
			fail(
				"the Chrome Web Store refused the service account (above); nothing was packed or committed",
			);
		}
		console.log(
			`preflight: ${version} is above the live ${live}, and the store accepts the account`,
		);

		run("pnpm run sign");
		assertCrx(CHROME_CRX);

		if (flags.has("--dry-run")) {
			console.log(
				`\ndry run: ${version} built and packed as a CRX3 with the CWS key, and cleared the store's preflight.` +
					`\nNothing was committed, submitted, tagged or published; ${tag} is still free.`,
			);
			return;
		}

		commit = commitRelease(meta, `chore(release): chromium ${version}`);
		try {
			run("pnpm run sign:cws");
		} catch {
			fail(
				`Chrome Web Store submission failed after the release commit ${commit.slice(0, 9)}. Re-dispatch` +
					` ${version} once fixed: the manifest already matches, so it tags this commit and submits again.`,
			);
		}
	} finally {
		clear();
		delete process.env.CWS_KEY_PEM;
		delete process.env.CWS_SERVICE_ACCOUNT_JSON;
	}
	createTag(REPO, tag, commit);
	run(`git fetch --quiet origin refs/tags/${tag}:refs/tags/${tag}`);

	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const crxAsset = join(stage, `bramble_chromium_${version}.crx`);
	const zipAsset = join(stage, `bramble_chromium_${version}.zip`);
	copyFileSync(CHROME_CRX, crxAsset);
	copyFileSync(CHROME_ZIP, zipAsset);
	const sumsAsset = writeSums([crxAsset, zipAsset]);
	try {
		await publish(tag, `Chromium Extension ${version}`, [crxAsset, zipAsset, sumsAsset], () =>
			verifyDraft(tag, "bramble_chromium_*", (file) => {
				if (file.endsWith(".crx")) assertCrx(file);
			}),
		);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log(
		`\nreleased ${tag} (commit ${commit.slice(0, 9)}): submitted to the Chrome Web Store for review; .crx + .zip + SHA256SUMS on the GitHub release.`,
	);
}

// ----- desktop: the CI route -----
//
// One release across three operating systems, so desktop-release.yml has more moving parts than the
// other workflows. The version bump is committed first, as on the local route: the Windows installer
// is built by sign-windows.yml on a runner of its own, and a runner can only build a commit it can
// fetch. Linux builds on native runners and Windows goes through SignPath, both holding no secret
// of ours; then one approved job on macOS builds and notarizes macOS and signs every updater
// artifact with the real key, the only job that ever holds it, and publishes.

/** Where build-windows.ts hands the dispatched run to the step that collects it. */
function windowsRunFile(): string {
	return "packages/platform-desktop/src-tauri/target/.windows-signing-run";
}

/**
 * The GitHub route for desktop. Two checks before anything is dispatched, both in seconds rather
 * than an hour into a run: that Windows can actually be signed, and what skipping a platform that
 * has already shipped will do to the people using it.
 */
function dispatchDesktop(version: string, tag: string): void {
	if (!skip.has("windows")) {
		// What sign-windows.yml reads. Names only: their values are not ours to read, just to check.
		// Inside the function, not beside it: the dispatch at the top of this file calls in here
		// while the module is still evaluating, and a module-level const below it would not exist.
		const SIGNPATH_SECRETS = ["SIGNPATH_API_TOKEN"];
		const SIGNPATH_VARIABLES = [
			"SIGNPATH_ORGANIZATION_ID",
			"SIGNPATH_PROJECT_SLUG",
			"SIGNPATH_SIGNING_POLICY_SLUG",
		];
		const names = (cmd: string) =>
			new Set(capture(`${cmd} --repo ${REPO} --json name --jq '.[].name'`).split("\n"));
		const secrets = names("gh secret list");
		const variables = names("gh variable list");
		const missing = [
			...SIGNPATH_SECRETS.filter((n) => !secrets.has(n)),
			...SIGNPATH_VARIABLES.filter((n) => !variables.has(n)),
		];
		if (missing.length)
			fail(
				`Windows cannot be signed: SignPath is not set up (missing ${missing.join(", ")}).\n` +
					"Release without it, or finish SignPath first:\n" +
					`  pnpm run release desktop ${rawVersion} --skip=${[...skip, "windows"].join(",")}`,
			);
	}

	// The update manifest carries ONE version for every platform, so a platform left out of this
	// release is left out of the manifest too, not left at its old version.
	const live = Object.keys(JSON.parse(readFromMain(DESKTOP_MANIFEST)).platforms ?? {});
	const consequences: Record<string, string> = {
		macos:
			"macOS users who check for updates by hand get an error until a release includes macOS " +
			"again, the website's macOS download falls back to the releases page, and Homebrew stays " +
			"on the current version",
		linux:
			"AppImage users who check for updates by hand get an error until a release includes Linux " +
			"again, the website's AppImage link falls back to the releases page, and APT gets nothing",
		windows:
			"Windows users who check for updates by hand get an error until a release includes Windows " +
			"again, and the website stops offering the installer",
	};
	const prefix: Record<string, string> = { macos: "darwin-", linux: "linux-", windows: "windows-" };
	for (const p of skip)
		if (live.some((k) => k.startsWith(prefix[p] as string)))
			console.warn(`\nwarning: ${p} is live and this release skips it: ${consequences[p]}.`);

	dispatchRelease("desktop-release.yml", version, tag, { skip: [...skip].join(",") });
}

/** Outputs for the jobs after this one: `key=value` lines appended to the step's output file. */
function stepOutputs(values: Record<string, string>): void {
	const file = process.env.GITHUB_OUTPUT || fail("no GITHUB_OUTPUT: this runs in a workflow step");
	appendFileSync(
		file,
		Object.entries(values)
			.map(([k, v]) => `${k}=${v}\n`)
			.join(""),
	);
}

/**
 * `--runner-bump`, the first job. Gates, commits the bump through GitHub's API, and dispatches the
 * Windows build, which needs that commit to exist. A dry run commits nothing and builds no Windows:
 * sign-windows.yml asserts it is building a committed version, and SignPath signs what it is sent.
 */
function runnerBumpDesktop(version: string, tag: string): void {
	const base = runnerBuildStart("desktop-release.yml", tag, "--runner-bump");
	const dryRun = flags.has("--dry-run");
	// The workflow computes this from the secret and variables without handing the job the token.
	// Checked before the gate and the commit, so a run that could never finish does not start.
	if (!skip.has("windows") && process.env.SIGNPATH_READY !== "true")
		fail("SignPath is not set up, so Windows cannot be signed; dispatch with skip=windows");
	gate();
	const files = bumpManifestVersion(DESKTOP_CONF, version);
	let sha = base;
	if (!dryRun && files.length) {
		sha = commitFiles({
			repo: REPO,
			branch: WEBSITE_BRANCH,
			expectedHeadOid: base,
			headline: `chore(release): desktop ${version}`,
			files,
		});
		// build-windows.ts --ci-start insists HEAD is pushed and the tree clean: stand on the commit.
		run(`git fetch --quiet origin ${WEBSITE_BRANCH}`);
		run(`git reset --quiet --hard ${sha}`);
	}
	let windowsRun = "";
	if (!dryRun && !skip.has("windows")) {
		run("node scripts/build-windows.ts --ci-start");
		windowsRun = readFileSync(windowsRunFile(), "utf8").trim();
	}
	stepOutputs({ sha, windows_run: windowsRun });
	console.log(
		`\n${version} at ${sha.slice(0, 9)}` +
			(dryRun
				? " (dry run: nothing committed, no Windows)"
				: windowsRun
					? `; Windows is run ${windowsRun}`
					: "; Windows skipped"),
	);
}

/**
 * `--runner-prepare`: the tree at `version` before a build. On a real run it already is, being the
 * bump commit, and anything else is a tree the release commit does not describe. On a dry run
 * nothing was committed, so the bump happens here, in this checkout only.
 */
function runnerPrepareDesktop(version: string): void {
	if (!process.env.GITHUB_ACTIONS) fail("--runner-prepare runs in desktop-release.yml");
	if (currentVersion("desktop") === version) return;
	if (!flags.has("--dry-run"))
		fail(`${DESKTOP_CONF} is not ${version}: this is not the release commit`);
	bumpManifestVersion(DESKTOP_CONF, version);
	console.log(`dry run: ${DESKTOP_CONF} set to ${version} in this checkout only`);
}

/**
 * What the macOS job hands the publish job: the lipo'd app binary, and the proxy in both places a
 * universal build needs it (stage-proxy.mjs explains why there are two). Relative to src-tauri.
 * A function rather than a module constant, because the dispatch at the top of this file runs
 * before anything declared down here exists.
 */
function macosHandoff(): { root: string; tarball: string; files: string[] } {
	return {
		root: "packages/platform-desktop/src-tauri",
		tarball: join(HANDOFF, "macos-universal.tar"),
		files: [
			"target/universal-apple-darwin/release/bramble-desktop",
			"target/universal-apple-darwin/release/bramble-proxy",
			"binaries/bramble-proxy-universal-apple-darwin",
		],
	};
}

/**
 * `--runner-compile`, the macOS job. Compiles both slices with no secret in the job at all, which
 * is the point: every crate's build script and proc macro runs here, and only packaging and
 * signing run beside the keys. Packed as a tarball because artifacts drop the executable bit.
 */
function runnerCompileMacos(version: string): void {
	if (!process.env.GITHUB_ACTIONS) fail("--runner-compile runs in desktop-release.yml");
	runnerPrepareDesktop(version);
	run("node scripts/build-macos.ts --compile-only");
	const { root, tarball, files } = macosHandoff();
	mkdirSync(dirname(tarball), { recursive: true });
	execFileSync("tar", ["-cf", tarball, "-C", root, ...files], { stdio: "inherit" });
	console.log(`\n${version} compiled for both Apple slices; handed over as ${tarball}`);
}

/**
 * Unpacks the macOS job's build and refuses it unless every file is executable and carries both
 * slices. Either failure is invisible until someone opens the app: one missing slice is an app
 * that does not start on half of all Macs, and a missing x bit is one that starts on none.
 */
function receiveMacosBuild(): void {
	const { root, tarball, files } = macosHandoff();
	if (!existsSync(tarball)) fail(`no ${tarball}; the macOS job did not hand one over`);
	execFileSync("tar", ["-xf", tarball, "-C", root], { stdio: "inherit" });
	for (const file of files) {
		const path = join(root, file);
		try {
			accessSync(path, constants.X_OK);
		} catch {
			fail(`${file} arrived without its executable bit`);
		}
		const archs = capture(`lipo -archs ${path}`).split(/\s+/).sort().join(" ");
		if (archs !== "arm64 x86_64") fail(`${file} is ${archs || "not a Mach-O"}, not universal`);
	}
	console.log(`received the macOS build: ${files.length} universal binaries`);
}

/**
 * `--runner-publish`, the approved job on macOS and the only place the updater key exists. Builds
 * macOS (Developer ID signed, notarized, its updater archive signed as it is made), re-signs the
 * Linux AppImages over the throwaway signatures their builds carry, collects and re-signs the
 * Windows installer, and verifies every updater signature against the public key compiled into the
 * app before anything is public. Then it publishes, and only after the release exists commits the
 * update manifest that points at it.
 */
async function runnerPublishDesktop(version: string, tag: string): Promise<void> {
	if (!process.env.GITHUB_ACTIONS) fail("--runner-publish runs in desktop-release.yml");
	const dryRun = flags.has("--dry-run");
	const bundle = "packages/platform-desktop/src-tauri/target/universal-apple-darwin/release/bundle";
	runnerPrepareDesktop(version);
	const sha = capture("git rev-parse HEAD");
	// The updater key signs whatever this release carries; the Apple ones are only wanted when
	// there is a macOS build to sign and notarize.
	const apple = [
		"APPLE_CERTIFICATE",
		"APPLE_CERTIFICATE_PASSWORD",
		"APPLE_SIGNING_IDENTITY",
		"ASC_KEY_ID",
		"ASC_ISSUER_ID",
		"ASC_KEY_CONTENT",
	];
	for (const name of ["TAURI_SIGNING_PRIVATE_KEY", ...(skip.has("macos") ? [] : apple)])
		if (!process.env[name]) fail(`no ${name} in desktop-release`);

	// Compiled by the macOS job, which holds nothing; bundled here, which is where Tauri imports
	// APPLE_CERTIFICATE into a throwaway keychain, codesigns, notarizes with the ASC key from the
	// environment, and signs the updater archive.
	if (!skip.has("macos")) {
		receiveMacosBuild();
		run("node scripts/build-macos.ts --bundle-only");
	}

	const signUpdater = (file: string) =>
		execFileSync(
			"pnpm",
			["--filter", "@vault/platform-desktop", "exec", "tauri", "signer", "sign", resolve(file)],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);

	// The Linux jobs signed their AppImages with a throwaway key, because the bundler will not emit
	// updater artifacts unsigned. Same bytes, real signature.
	const linux = "dist-linux/appimage";
	const images =
		!skip.has("linux") && existsSync(linux)
			? readdirSync(linux)
					.filter((f) => f.endsWith(".AppImage") && f.includes(`_${version}_`))
					.map((f) => join(linux, f))
			: [];
	if (!skip.has("linux") && images.length === 0)
		fail(`no ${version} AppImage in ${linux}; the Linux builds did not hand one over`);
	for (const image of images) {
		rmSync(`${image}.sig`, { force: true });
		signUpdater(image);
	}

	// Waits on SignPath's approval, downloads the Authenticode-signed installer, and signs it for the
	// updater with the key in this job's environment.
	const windows: string[] = [];
	if (!dryRun && !skip.has("windows")) {
		const runId = process.env.WINDOWS_RUN || fail("no Windows run id handed over by the bump job");
		mkdirSync(dirname(windowsRunFile()), { recursive: true });
		writeFileSync(windowsRunFile(), `${runId}\n`);
		run("node scripts/build-windows.ts --ci-collect");
		const nsis =
			"packages/platform-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis";
		for (const f of readdirSync(nsis))
			if (f.endsWith("-setup.exe") && f.includes(`_${version}_`)) windows.push(join(nsis, f));
	}

	// Every updater artifact, against the public key compiled into the app, before anything is
	// public. An artifact that fails this is one every installed app would refuse.
	const macos = join(bundle, "macos");
	const archives = skip.has("macos")
		? []
		: readdirSync(macos)
				.filter((f) => f.endsWith(".app.tar.gz"))
				.map((f) => join(macos, f));
	for (const artifact of [...archives, ...images, ...windows]) {
		try {
			run(`node scripts/verify-updater-signature.mjs ${artifact} ${artifact}.sig`);
		} catch {
			fail(
				`${basename(artifact)} does not verify against the updater key in the app; nothing was published`,
			);
		}
	}

	if (dryRun) {
		console.log(
			`\ndry run: ${version} built for ${["macos", "linux"].filter((p) => !skip.has(p)).join(" and ")},` +
				" every updater signature verified against the key in the app. Windows is not part of a dry run." +
				`\nNothing was committed, tagged or published; ${tag} is still free.`,
		);
		return;
	}

	const { assets, sums, expectedDmg } = collectDesktopAssets(version, true, bundle, skip);
	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(sumsAsset, [...sums].map(([name, hash]) => `${hash}  ${name}\n`).join(""));

	createTag(REPO, tag, sha);
	run(`git fetch --quiet origin refs/tags/${tag}:refs/tags/${tag}`);
	try {
		await publish(tag, `Desktop ${version}`, [...assets, sumsAsset], () => verifyDraft(tag, "*"));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}

	// Only now: the manifest IS the update channel, so it goes live after the artifacts it names
	// exist. Committed onto main as it is NOW, an hour after the build started: these two files
	// are the release's alone, and nothing else on main has to have stood still for them.
	run(`node scripts/release-desktop.mjs --resume --quiet${skipArg ? ` ${skipArg}` : ""}`);
	// The cask names the .dmg, so it moves only with a release that has one.
	const channels = [DESKTOP_MANIFEST];
	if (!skip.has("macos")) {
		updateCask(version, sums.get(expectedDmg) ?? fail(`${expectedDmg} is not in SHA256SUMS`));
		channels.push(DESKTOP_CASK);
	}
	const head = capture(`gh api repos/${REPO}/git/ref/heads/${WEBSITE_BRANCH} --jq .object.sha`);
	commitFiles({
		repo: REPO,
		branch: WEBSITE_BRANCH,
		expectedHeadOid: head,
		headline: `chore(release): desktop ${version} update manifest${channels.length > 1 ? " and cask" : ""}`,
		files: channels,
	});
	// No dispatch here: the commit above is made with the release app's token, not this workflow's,
	// and an app's commit fires push workflows like any other, so deploy-website.yml is already
	// running. Dispatching as well produced two runs a second apart, one of them cancelled by the
	// concurrency group, which reads as a release that half worked.

	console.log(
		`\nreleased ${tag}${skip.size ? ` without ${[...skip].join(", ")}` : ""}; the update manifest` +
			" is committed and the website is deploying." +
			(skip.has("linux")
				? ""
				: "\nThe APT repository is still signed from a Mac, until its key moves off the YubiKey:" +
					`\n  pnpm run publish:apt --release ${tag}`),
	);
}

/**
 * Every artifact a desktop release publishes, checked for completeness: the universal .dmg, the
 * Linux packages, the Windows installer, and each updater artifact with its signature. Returns them
 * with their checksums, keyed by basename because the cask needs the .dmg's and `test:brew` asserts
 * the two agree.
 */
function collectDesktopAssets(
	version: string,
	universal: boolean,
	bundle: string,
	skipped: Set<string> = new Set(),
): { assets: string[]; sums: Map<string, string>; dmgs: string[]; expectedDmg: string } {
	const macos = join(bundle, "macos");
	// A skipped platform is neither required nor collected, so nothing from an older build lying
	// around can ride along into this release. Only the GitHub route skips; locally nothing is.
	const withMacos = !skipped.has("macos");
	const archives =
		withMacos && existsSync(macos)
			? readdirSync(macos).filter((f) => f.endsWith(".app.tar.gz"))
			: [];
	if (withMacos && archives.length === 0)
		fail(`no .app.tar.gz in ${macos}; the build produced no updater archive`);
	const dmgs =
		withMacos && existsSync(join(bundle, "dmg"))
			? readdirSync(join(bundle, "dmg")).filter((f) => f.endsWith(".dmg"))
			: [];
	if (withMacos && dmgs.length === 0) fail(`no .dmg in ${join(bundle, "dmg")}`);
	// The website's download box builds this URL from the version rather than reading it from
	// anywhere, because the updater manifest names the .app.tar.gz and never the disk image. A
	// rename here would leave the front page's main macOS download pointing at a 404.
	const expectedDmg = `Bramble_${version}_universal.dmg`;
	if (withMacos && universal && !dmgs.includes(expectedDmg))
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
	for (const f of dmgs.filter(ofThisVersion)) assets.push(join(bundle, "dmg", f));
	// One release carries every platform. The AppImage must be signed, for the same reason the
	// macOS archive must: it is what the updater fetches, and an unsigned one is rejected by every
	// installed app, so publishing it looks complete and updates nobody. The .deb and .rpm carry
	// .sig files too, which are meaningless (the updater cannot apply either) and not uploaded.
	for (const [dir, ext] of [
		["dist-linux/deb", ".deb"],
		["dist-linux/rpm", ".rpm"],
		["dist-linux/appimage", ".AppImage"],
	] as const) {
		if (skipped.has("linux") || !existsSync(dir)) continue;
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
	// Windows, where the installer is both the download and the updater artifact, so unlike the
	// other two platforms there is one file and its signature rather than a pair to keep in step.
	// Same rule about the .sig: unsigned means every installed app refuses the update.
	for (const triple of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] as const) {
		const dir = `packages/platform-desktop/src-tauri/target/${triple}/release/bundle/nsis`;
		if (skipped.has("windows") || !existsSync(dir)) continue;
		const built = readdirSync(dir).filter((f) => f.endsWith("-setup.exe") && ofThisVersion(f));
		for (const f of built) {
			if (!existsSync(join(dir, `${f}.sig`)))
				fail(`${f} has no .sig; the Windows build must not be --unsigned for a release`);
			assets.push(join(dir, f), join(dir, `${f}.sig`));
		}
	}
	// Checked after the loop rather than inside it, because the arm64 directory legitimately does
	// not exist: only x64 is built for a release. Nothing at all means the Windows build did not
	// run, and silence there would publish a release that claims to carry Windows and does not.
	if (!skipped.has("windows") && !assets.some((a) => a.endsWith("-setup.exe")))
		fail(
			`no ${version} -setup.exe; the GitHub build did not produce one.\n` +
				"Re-run to wait on it again, or check the run linked by --ci-start.",
		);

	for (const a of archives) {
		if (!existsSync(join(macos, `${a}.sig`)))
			// Every installed app rejects an unsigned archive, so publishing one leaves a release
			// that looks complete while updating silently fails for everyone.
			fail(`${a} has no .sig; was the signing key set for this build?`);
		assets.push(join(macos, a), join(macos, `${a}.sig`));
	}

	// Keyed by basename because the cask below needs the .dmg's checksum, and `test:brew`
	// asserts the two agree: hashing the same file twice is how they would come to disagree.
	const sums = new Map(
		assets
			.filter((f) => !f.endsWith(".sig"))
			.map(
				(f) => [basename(f), createHash("sha256").update(readFileSync(f)).digest("hex")] as const,
			),
	);
	return { assets, sums, dmgs, expectedDmg };
}

// ----- ios: App Store Connect / TestFlight via fastlane (no GitHub release) -----

async function releaseIos(version: string, ipaOnly: boolean, ci = false) {
	const IOS = "packages/platform-mobile/ios/App";
	const PBXPROJ = `${IOS}/App.xcodeproj/project.pbxproj`;

	// CFBundleShortVersionString: 1-3 dot-separated ints (matches Android + App Store rules).
	if (!/^\d+(\.\d+){0,2}$/.test(version))
		fail(`invalid version "${version}". want 1-3 ints (e.g. 1.1 or 1.1.0)`);

	if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");

	// Prereqs (fail fast): fastlane + the App Store Connect API key the `beta` lane uploads with.
	// The lanes live in the REPO-ROOT fastlane/ (shared with the Android store metadata, which
	// fastlane's supply layout puts there). The actual signing is Xcode-automatic
	// (-allowProvisioningUpdates), so unlike Android there's no keystore to decrypt here.
	//
	// Presence only, not a decrypt: this runs before the gate, and asking for a touch here would
	// ask for a second one later when fastlane actually unwraps it.
	if (!ci) {
		if (!has("fastlane"))
			fail("fastlane not found; `brew install fastlane` (see docs/release-signing.md)");
		if (!existsSync(ASC_KEY_AGE) && !process.env.ASC_KEY_CONTENT)
			fail(
				`no App Store Connect key at ${ASC_KEY_AGE}. First time? node scripts/asc-api-key.ts --wrap\n` +
					"See docs/release-signing.md (iOS).",
			);
	}

	if (!ipaOnly) gate(); // a dry run only tests build + signing, so skip the slow CI gate

	// Bump MARKETING_VERSION + CURRENT_PROJECT_VERSION across ALL build configs. The app + the
	// AutoFillProbe extension must share both or App Store validation rejects the upload, so replace
	// every occurrence. Mirrors the Android versionCode: the build number is committed to source
	// (seconds since 2020, `max(prev+1, now)` so a backwards clock can't emit a non-increasing build,
	// which App Store Connect rejects) and passed to the lane below so the two always agree.
	// From main when a runner will build the tag, from this clone when this machine will build it.
	// A stale checkout would otherwise bump from the wrong version and, worse, compute a build
	// number below one App Store Connect has already seen, which it rejects.
	const before = ci ? readFromMain(PBXPROJ) : readFileSync(PBXPROJ, "utf8");
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
	// On GitHub rather than in this clone for a CI release: the clone lags behind what runners tag.
	if (ci ? ok(`gh api repos/${REPO}/git/ref/tags/${tag}`) : capture(`git tag -l ${tag}`))
		fail(`tag ${tag} already exists`);
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

	// The GitHub route: the runner builds and uploads, so the bump has to be committed first,
	// and the order flips. Locally the upload comes first and the tag records a build that already
	// exists; here the tag IS the request, and a build that then fails leaves a tag naming a build
	// TestFlight never received. That is the trade for not needing this machine: re-dispatch
	// against the same tag once it is fixed rather than cutting a second version.
	if (ci) {
		// Through GitHub's API, not `git push`: this was the last route that pushed from the clone,
		// and the clone's remote is SSH, so a release needed the YubiKey for the push alone. The API
		// signs the commit itself, and the working tree goes back to what it was either way.
		try {
			const head = capture(`gh api repos/${REPO}/git/ref/heads/main --jq .object.sha`);
			const sha = bumped
				? commitFiles({
						repo: REPO,
						branch: "main",
						expectedHeadOid: head,
						headline: `chore(release): ios ${version} (build ${build})`,
						files: [PBXPROJ],
					})
				: head;
			// The tag IS the build request here, so it has to exist before the dispatch and point at
			// the commit the runner will check out.
			createTag(REPO, tag, sha);
		} finally {
			if (bumped) run(`git checkout ${PBXPROJ}`);
		}
		try {
			run(`gh workflow run ios-testflight.yml --repo ${REPO} --ref ${tag} -f build=${build}`);
		} catch {
			// The tag exists, so this is recoverable by hand and worth saying how.
			fail(
				`dispatch failed. The tag ${tag} exists, so run the workflow from the Actions tab\n` +
					`against ${tag} with build=${build}, or retry:\n` +
					`  gh workflow run ios-testflight.yml --ref ${tag} -f build=${build}`,
			);
		}
		console.log(
			`\ndispatched iOS ${version} (build ${build}) from ${tag}.` +
				"\nIt waits for your approval before it can read any credential:" +
				"\n  gh run watch  (or the Actions tab, iOS TestFlight)" +
				"\nThis clone is now a commit behind main; `git pull` when convenient.",
		);
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

	// The CI route: dispatched from here, built, signed and published on runners. docs/ci-releases.md.
	if (viaCi) return dispatchDesktop(version, tag);
	if (flags.has("--runner-bump")) return runnerBumpDesktop(version, tag);
	if (flags.has("--runner-prepare")) return runnerPrepareDesktop(version);
	if (flags.has("--runner-compile")) return runnerCompileMacos(version);
	if (flags.has("--runner-publish")) return runnerPublishDesktop(version, tag);

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
	if (!resume && !existsSync(ASC_KEY_AGE) && !process.env.APPLE_API_KEY && !process.env.APPLE_ID)
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

	// The release commit goes out BEFORE the builds, which is the one place this platform differs
	// from the other four, and it is the Windows installer that forces it: that one is built on a
	// GitHub runner (see scripts/build-windows.ts for why it has to be), and a runner can only
	// build a commit it can fetch. A bump still sitting in the working tree would have CI produce,
	// and SignPath happily sign, an installer for the PREVIOUS version.
	//
	// The cost is that a build failure now leaves a `chore(release)` commit on main with no
	// release behind it. That is recoverable and already handled: re-running finds the version
	// already bumped, skips the commit, and carries on. The tag is what is still withheld until
	// every artifact exists, so nothing ever points at a release that was not built.
	if (!resume) commitAndPush(bumped, DESKTOP_CONF, `chore(release): desktop ${version}`, branch);

	// Kicked off first and collected last, because it is the only step that waits on a person:
	// SignPath requires a maintainer to approve each signing request. Started here, the approval
	// and the notarization upload happen at the same time instead of one after the other.
	if (!resume && process.platform === "darwin") {
		try {
			run("pnpm run build:windows -- --ci-start");
		} catch {
			fail(
				"could not start the Windows build on GitHub.\n" +
					`The release commit is pushed; fix and re-run, or \`git checkout ${DESKTOP_CONF}\`.`,
			);
		}
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

	// Now wait for GitHub and SignPath, and sign what comes back with the updater key, which never
	// went anywhere near CI. Windows is where most people who install the extension are, so a
	// desktop release that skips it skips the majority.
	if (!resume && process.platform === "darwin") {
		try {
			run("pnpm run build:windows -- --ci-collect");
		} catch {
			fail(
				`Windows signing did not complete; the macOS and Linux builds are fine.\n` +
					`Re-run to wait on it again. See docs/desktop-port.md, "Windows".`,
			);
		}
	}

	const { assets, sums, dmgs, expectedDmg } = collectDesktopAssets(version, universal, BUNDLE);
	const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
	const sumsAsset = join(stage, "SHA256SUMS");
	writeFileSync(sumsAsset, [...sums].map(([name, hash]) => `${hash}  ${name}\n`).join(""));

	// Already tagged and pushed by the run being resumed; doing it again would only fail on the
	// tag that the resume exists to reuse. The release COMMIT went out before the builds; this is
	// the tag alone, withheld until every artifact exists so it can never name a release that was
	// not fully built.
	if (!resume) tagAndPush(tag, branch);

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
function currentVersion(
	platform: string,
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
	if (platform === "android")
		return matchVersion(
			read("packages/platform-mobile/android/app/build.gradle"),
			/versionName "([^"]+)"/,
			"versionName in build.gradle",
		);
	if (platform === "ios")
		return matchVersion(
			read("packages/platform-mobile/ios/App/App.xcodeproj/project.pbxproj"),
			/MARKETING_VERSION = ([^;]+);/,
			"MARKETING_VERSION in project.pbxproj",
		);
	if (platform === "desktop")
		return matchVersion(
			read(DESKTOP_CONF),
			/"version"\s*:\s*"([^"]+)"/,
			`version in ${DESKTOP_CONF}`,
		);
	const manifest =
		platform === "firefox"
			? "packages/manifests/firefox/manifest.json"
			: "packages/manifests/chromium/manifest.json";
	return matchVersion(read(manifest), /"version"\s*:\s*"([^"]+)"/, `version in ${manifest}`);
}

/** A file as it is on GitHub's main: what a release from GitHub builds from and bumps. */
function readFromMain(path: string): string {
	const b64 = capture(`gh api repos/${REPO}/contents/${path}?ref=main --jq .content`);
	return Buffer.from(b64, "base64").toString("utf8");
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

/**
 * Commit the version bump and push the branch, without tagging.
 *
 * Split out of `commitTagPush` for the desktop release, where the Windows installer is built on
 * a GitHub runner and therefore has to be able to SEE the bumped version: CI builds a pushed
 * commit, so a bump that is still sitting in the working tree produces an installer for the
 * previous release. Every other platform builds locally and keeps the two together.
 *
 * Re-running after a failure is already handled: the bump is then a no-op, `bumped` is false,
 * and this says so rather than trying to commit nothing.
 */
function commitAndPush(bumped: boolean, files: string | string[], message: string, branch: string) {
	const list = Array.isArray(files) ? files : [files];
	if (bumped) {
		for (const f of list) run(`git add ${f}`);
		run(`git commit -m ${JSON.stringify(message)}`);
	} else {
		console.log(`${list[0]} already at this version; no release commit needed`);
	}
	run(`git push origin ${branch}`);
}

/** The other half. Separate so the desktop release can tag only once the build has succeeded. */
function tagAndPush(tag: string, branch: string) {
	run(`git tag ${tag}`);
	run(`git push origin ${branch}`);
	run(`git push origin ${tag}`);
}

function commitTagPush(
	bumped: boolean,
	files: string | string[],
	message: string,
	tag: string,
	branch: string,
) {
	commitAndPush(bumped, files, message, branch);
	tagAndPush(tag, branch);
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
async function publish(
	tag: string,
	title: string,
	assets: string[],
	// Runs against the draft, after upload and before it goes public. Failing it leaves a draft.
	beforePublish?: () => void,
) {
	const notesDir = mkdtempSync(join(tmpdir(), "bramble-notes-"));
	const notesFile = join(notesDir, "NOTES.md");
	writeFileSync(notesFile, await releaseNotes(tag, platform));
	try {
		run(
			`gh release create ${tag} --draft --notes-file ${notesFile} --title ${JSON.stringify(title)}`,
		);
		run(`gh release upload ${tag} ${assets.join(" ")}`);
		beforePublish?.();
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
