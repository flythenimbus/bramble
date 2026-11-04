#!/usr/bin/env node
// Build the desktop app, decrypting the updater signing key only for as long as the bundler needs
// it.
//
// Named for macOS because that is where a release is cut, but it builds for the host target: on
// Linux the same script produces the .deb, .rpm and AppImage, which is why build-linux.ts calls it
// inside the container and CI calls it on an Ubuntu runner. Only the Apple-specific parts
// (notarization, the universal lipo) are guarded by `process.platform`.
//
// Same age + YubiKey scheme as every other release key here (see docs/release-signing.md): the key
// lives encrypted at rest and is unlocked with a PIN and a touch. Tauri's CLI cannot talk to a
// hardware token — it wants a minisign key as a path or a string — so the key itself cannot live
// ON the YubiKey. What the YubiKey does is gate access to it, which is the same protection the
// Chrome Web Store and Android keys get.
//
// The plaintext is passed through the environment and never written to disk. That matters more
// here than elsewhere: this key is the root of trust for every update the app will ever accept, so
// a copy left in a temp file is a copy someone could ship a malicious update with.
//
// Two phases, compile then bundle, and both unless told otherwise. Compiling runs every crate's
// build script and proc macro, so it gets an environment with no signing material in it; only
// bundling, which is where macOS codesigns and notarizes and where the updater artifacts are
// signed, runs beside the keys. desktop-release.yml runs them on different runners, `--compile-only`
// in a job that holds nothing and `--bundle-only` in the approved one, from the binaries the first
// handed over. Locally they run back to back, so a local build exercises the same two steps.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAppImagePortable } from "./appimage-portability.ts";
import { ensureTools } from "./appimage-tools.ts";
import { type AscApiKey, ascApiKey } from "./asc-api-key.ts";
import { KEY_AGE, signingKey } from "./desktop-signing-key.ts";

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

/**
 * Notarization credentials, reusing the App Store Connect API key the iOS release already has.
 *
 * Apple takes either an API key or an Apple ID with an app-specific password, and the key is the
 * better one: it is scoped, revocable on its own, and not a credential that also opens the account.
 * It comes from the same age + YubiKey wrapper fastlane reads (scripts/asc-api-key.ts), so there
 * is one iOS credential on this machine rather than one per tool; an explicit APPLE_* in the
 * environment still wins, for CI.
 *
 * Returns a cleanup for the decrypted key, because unlike the updater key this one cannot stay in
 * the environment: notarytool takes a path, so it has to reach a file. 0600 inside a 0700 scratch
 * dir, removed the moment the build is done with it.
 *
 * Absent, the build still succeeds and produces something Gatekeeper blocks on every machine that
 * did not build it, so it says so rather than leaving that to be discovered by a user.
 */
function loadNotarization(): { expected: boolean; cleanup?: () => void } {
	// Notarization is an Apple step; the same script bundles the Linux three on a Debian container
	// where there is no YubiKey to prompt and nothing to notarize.
	if (process.platform !== "darwin") return { expected: false };
	// The local-update test build never leaves this machine, so notarizing it buys nothing and
	// costs an upload to Apple, a wait, and a submission record for a build nobody will run.
	if (process.argv.slice(2).some((a) => a.includes("local-update"))) {
		console.error("note: local-update build, skipping notarization.");
		return { expected: false };
	}
	if (process.env.BRAMBLE_SKIP_NOTARIZE) {
		console.error("note: BRAMBLE_SKIP_NOTARIZE set, skipping notarization.");
		return { expected: false };
	}

	const already =
		(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY_PATH) ||
		(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
	if (already) return { expected: true };

	// Warn rather than fail, as an absent key always has: an unplugged YubiKey should not end a
	// build that is otherwise fine, it should say what the build will be missing.
	let key: AscApiKey | undefined;
	try {
		key = ascApiKey((message) => {
			throw new Error(message);
		});
	} catch (e) {
		console.error(`warning: could not read the App Store Connect key: ${(e as Error).message}`);
	}
	if (!key) {
		console.error(
			"warning: no notarization credentials; the build will be signed but NOT notarized,\n" +
				"         and Gatekeeper will block it on every machine that did not build it.\n" +
				"         See docs/release-signing.md.",
		);
		return { expected: false };
	}

	const tmp = mkdtempSync(join(tmpdir(), "bramble-notarize-"));
	const keyPath = join(tmp, `AuthKey_${key.keyId}.p8`);
	writeFileSync(keyPath, key.key, { mode: 0o600 });
	process.env.APPLE_API_KEY = key.keyId;
	process.env.APPLE_API_ISSUER = key.issuerId;
	process.env.APPLE_API_KEY_PATH = keyPath;
	return { expected: true, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTITLEMENTS = join(ROOT, "clients/desktop/src-tauri/entitlements.plist");
/** Where a Mac that signs releases keeps the profile; CI passes it in APPLE_PROVISIONING_PROFILE. */
const PROFILE = join(ROOT, "clients/desktop/macos/profiles/Bramble.provisionprofile");

/**
 * The Touch ID gate's entitlement, the profile that grants it, and a pre-signed browser-link
 * helper, as a bundle-step `--config`, or nothing for a build that is not Developer ID signed.
 *
 * Touch ID unlock keeps each vault's key in the data protection keychain
 * (src-tauri/src/biometric_macos.rs), which takes the keychain-access-groups entitlement. That one
 * is restricted: macOS refuses to launch an app that carries it without the provisioning profile
 * granting it, embedded as Contents/embedded.provisionprofile. So the two go in together or not at
 * all. An ad-hoc build gets neither, still launches, and reports Touch ID unavailable.
 *
 * The helper is the catch. Tauri signs every binary it bundles beside the app with the app's
 * entitlements, and macOS kills (SIGKILL, on launch) a helper carrying a restricted entitlement
 * with no profile of its own, which would leave the browser link dead. So this build drops the
 * sidecar and ships the staged proxy pre-signed without entitlements in Contents/Helpers, a file
 * Tauri copies but does not sign; manifest.rs finds it there. The proxy's [[bin]] copy is already
 * out of every bundle (Cargo.toml, `proxy-bin`).
 *
 * The profile is signing material kept out of git (.gitignore). A signed build with no profile is
 * refused rather than shipped without Touch ID, which nothing else would point out.
 */
function keychainEntitlement(): { config?: string; cleanup?: () => void } {
	if (process.platform !== "darwin") return {};
	const identity = process.env.APPLE_SIGNING_IDENTITY;
	if (!identity) {
		if (process.env.APPLE_CERTIFICATE)
			fail(
				"APPLE_CERTIFICATE is set without APPLE_SIGNING_IDENTITY, which the helper is signed as.",
			);
		console.error("note: not Developer ID signed, so no keychain entitlement and no Touch ID.");
		return {};
	}
	const tmp = mkdtempSync(join(tmpdir(), "bramble-sign-"));
	const undo: (() => void)[] = [() => rmSync(tmp, { recursive: true, force: true })];
	const cleanup = () => {
		for (const step of undo.reverse()) step();
	};

	let profile = PROFILE;
	const encoded = process.env.APPLE_PROVISIONING_PROFILE;
	if (encoded) {
		profile = join(tmp, "Bramble.provisionprofile");
		writeFileSync(profile, Buffer.from(encoded, "base64"), { mode: 0o600 });
	} else if (!existsSync(PROFILE)) {
		cleanup();
		fail(
			`no provisioning profile: expected APPLE_PROVISIONING_PROFILE (base64) or ${PROFILE}.\n` +
				"Without it the app ships with Touch ID unlock unavailable. See docs/release-signing.md.",
		);
	}

	const staged = join(ROOT, "clients/desktop/src-tauri/binaries", `bramble-proxy-${proxyTriple()}`);
	if (!existsSync(staged)) {
		cleanup();
		fail(`no staged proxy at ${staged}; stage-proxy.mjs runs before the compile step.`);
	}
	const helper = join(tmp, "bramble-proxy");
	copyFileSync(staged, helper);
	presign(helper, identity, tmp, undo);

	const config = JSON.stringify({
		bundle: {
			externalBin: null,
			macOS: {
				entitlements: ENTITLEMENTS,
				files: { "embedded.provisionprofile": profile, "Helpers/bramble-proxy": helper },
			},
		},
	});
	return { config, cleanup };
}

/** Which staged proxy this build ships: the same target the app is built for. */
function proxyTriple(): string {
	const at = forwarded.indexOf("--target");
	if (at >= 0 && forwarded[at + 1]) return forwarded[at + 1] as string;
	if (universal) return "universal-apple-darwin";
	const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
	return host ?? fail("could not read the host target from rustc -vV");
}

/**
 * Sign the helper as the bundle needs it and Tauri would not: Developer ID, hardened runtime and a
 * secure timestamp (notarization requires all three on nested code), and no entitlements.
 *
 * Locally the identity is in the login keychain. In CI it arrives as APPLE_CERTIFICATE, which Tauri
 * imports into a keychain of its own only once bundling starts, so it is imported here the same way
 * into a throwaway keychain, searched first and removed with the build.
 */
function presign(path: string, identity: string, tmp: string, undo: (() => void)[]): void {
	const cert = process.env.APPLE_CERTIFICATE;
	if (cert) {
		const security = (...args: string[]) =>
			execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const keychain = join(tmp, "presign.keychain-db");
		const password = randomBytes(24).toString("hex");
		const p12 = join(tmp, "certificate.p12");
		writeFileSync(p12, Buffer.from(cert, "base64"), { mode: 0o600 });
		const searched = security("list-keychains", "-d", "user")
			.split("\n")
			.map((line) => line.trim().replace(/^"|"$/g, ""))
			.filter(Boolean);
		security("create-keychain", "-p", password, keychain);
		undo.push(() => {
			security("list-keychains", "-d", "user", "-s", ...searched);
			security("delete-keychain", keychain);
		});
		security("set-keychain-settings", "-lut", "3600", keychain);
		security("unlock-keychain", "-p", password, keychain);
		security(
			"import",
			p12,
			"-k",
			keychain,
			"-P",
			process.env.APPLE_CERTIFICATE_PASSWORD ?? "",
			"-T",
			"/usr/bin/codesign",
		);
		security(
			"set-key-partition-list",
			"-S",
			"apple-tool:,apple:,codesign:",
			"-s",
			"-k",
			password,
			keychain,
		);
		security("list-keychains", "-d", "user", "-s", keychain, ...searched);
	}
	execFileSync(
		"codesign",
		["--force", "--options", "runtime", "--timestamp", "--sign", identity, path],
		{ stdio: "inherit" },
	);
}

/** The .app the bundler just made. */
function builtApp(): string {
	const bundle = join(
		ROOT,
		"clients/desktop/src-tauri/target",
		universal ? "universal-apple-darwin/release/bundle" : "release/bundle",
		"macos",
	);
	const apps = readdirSync(bundle).filter((f) => f.endsWith(".app"));
	if (apps.length !== 1) fail(`expected one .app in ${bundle}, found ${apps.length}`);
	return join(bundle, apps[0] as string);
}

/**
 * That the entitlement, its profile and the helper all landed as they must. Each mistake here is
 * one macOS reports only at launch: an entitled app without the profile does not open, and an
 * entitled helper (which has no profile of its own) is killed when a browser starts it.
 */
function assertKeychainEntitled(): void {
	const app = builtApp();
	const entitlements = (path: string) =>
		execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", path], {
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();
	if (!existsSync(join(app, "Contents/embedded.provisionprofile")))
		fail(
			`${app} has no embedded.provisionprofile; with the keychain entitlement it would not open.`,
		);
	if (!entitlements(app).includes("keychain-access-groups"))
		fail(`${app} was signed without the keychain entitlement; Touch ID would be unavailable.`);
	const beside = join(app, "Contents/MacOS/bramble-proxy");
	if (existsSync(beside))
		fail(`${beside} is bundled beside the app, where Tauri signs it with the app's entitlements.`);
	const helper = join(app, "Contents/Helpers/bramble-proxy");
	if (!existsSync(helper))
		fail(`${app} has no Contents/Helpers/bramble-proxy; the browser link is dead.`);
	if (entitlements(helper).includes("keychain-access-groups"))
		fail(
			`${helper} carries the keychain entitlement with no profile of its own; macOS would kill it.`,
		);
	try {
		execFileSync("codesign", ["--verify", "--strict", "--deep", app], { stdio: "pipe" });
	} catch (e) {
		fail(`${app} does not verify: ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
	}
}

// Universal unless asked otherwise, and only on macOS: `universal-apple-darwin` is a lipo of two
// Apple slices, which is meaningless anywhere else and would fail the build outright. Elsewhere
// the host target is the right and only answer, so Linux produces a .deb and an AppImage for the
// architecture it is running on. A host-arch build IS wrong to hand anyone on macOS, though: it
// looks identical and simply does not open on an Intel Mac, so `--aarch64` (iterating only) is
// what opts out there.
/**
 * That the app Apple was asked to notarize came back notarized and stapled.
 *
 * Tauri warns and carries on when it cannot notarize, so the difference between a release and one
 * Gatekeeper blocks on every machine but the builder is a line in a log nobody reads. It went
 * unnoticed exactly once, when a refactor handed the bundler an environment copied before the
 * credentials were in it: the build was signed, every updater signature verified, and the job was
 * green. `stapler validate` reads the ticket out of the bundle, so it answers for the artifact
 * rather than for the intent.
 */
function assertNotarized(): void {
	const app = builtApp();
	try {
		execFileSync("xcrun", ["stapler", "validate", app], { stdio: "pipe" });
	} catch {
		fail(
			`${app} is not notarized, though the credentials to notarize it were present.\n` +
				"Gatekeeper blocks it on every machine that did not build it, so this is not shippable.",
		);
	}
	console.log(`notarized and stapled: ${app[0]}`);
}

const PHASES = ["--compile-only", "--bundle-only"];
const passed = process.argv.slice(2);
const compileOnly = passed.includes("--compile-only");
const bundleOnly = passed.includes("--bundle-only");
if (compileOnly && bundleOnly)
	fail("--compile-only and --bundle-only are the two halves; pass neither for both");
const hostOnly = passed.includes("--aarch64");
const forwarded = passed.filter((a) => a !== "--aarch64" && !PHASES.includes(a));
const universal =
	process.platform === "darwin" && !hostOnly && !forwarded.some((a) => a.startsWith("--target"));

/** Same target and --config for both halves: `tauri bundle` reads the build `tauri build` left. */
const tauri = (command: "build" | "bundle", extra: string[], env: NodeJS.ProcessEnv) =>
	execFileSync(
		"pnpm",
		[
			"--filter",
			"@vault/platform-desktop",
			"exec",
			"tauri",
			command,
			...extra,
			...forwarded,
			...(universal ? ["--target", "universal-apple-darwin"] : []),
		],
		{ stdio: "inherit", env },
	);

// stage-proxy builds and lipos both slices when this is set. A sidecar is copied rather than
// built by the bundler, so without it a universal app ships an Apple-Silicon-only proxy and the
// browser link is dead on Intel.
const universalEnv =
	universal || forwarded.some((a) => a.includes("universal-apple-darwin"))
		? { BRAMBLE_UNIVERSAL: "1" }
		: {};

/**
 * Read at the moment a phase runs, never captured earlier: loadNotarization puts the App Store
 * Connect credentials on `process.env`, and a copy taken before that produced a build that was
 * signed, passed every check, and was silently not notarized.
 */
const envNow = () => ({ ...process.env, ...universalEnv });

/** Signing material the compile step never sees, wherever it came from (.env.local, CI). */
const SIGNING_ENV = [
	"TAURI_SIGNING_PRIVATE_KEY",
	"TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
	"APPLE_CERTIFICATE",
	"APPLE_CERTIFICATE_PASSWORD",
	"APPLE_PASSWORD",
	"APPLE_API_KEY_PATH",
	"ASC_KEY_CONTENT",
];

if (!bundleOnly) {
	const env = envNow();
	for (const name of SIGNING_ENV) delete env[name];
	tauri("build", ["--no-bundle"], env);
}

if (!compileOnly) {
	const notarization = loadNotarization();
	const entitlement = keychainEntitlement();
	try {
		const key = signingKey(fail);
		if (!key) {
			// Refused rather than built unsigned: an unsigned archive is rejected by every installed
			// app, so a release built without the key looks complete and silently breaks updating.
			fail(
				`no updater signing key: expected ${KEY_AGE} (override DESKTOP_UPDATER_KEY_AGE) or\n` +
					"TAURI_SIGNING_PRIVATE_KEY in the environment. See docs/release-signing.md",
			);
		}
		const env = {
			...envNow(),
			TAURI_SIGNING_PRIVATE_KEY: key,
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
		};
		// Before the bundler, not after one of them fails: on Linux the AppImage step fetches five
		// tools from the network mid-build, and the packer's failure is a silent fallback rather
		// than an error. See appimage-tools.ts.
		if (process.platform === "linux") await ensureTools();
		tauri("bundle", entitlement.config ? ["--config", entitlement.config] : [], env);
		if (entitlement.config) assertKeychainEntitled();
		if (notarization.expected) assertNotarized();

		if (process.platform === "linux") {
			makeAppImagePortable(join(ROOT, "clients/desktop/src-tauri/target/release/bundle"), env);
		}
	} finally {
		// Whatever the bundler did, the decrypted key must not outlive it.
		notarization.cleanup?.();
		entitlement.cleanup?.();
	}
}
