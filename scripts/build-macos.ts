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
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePacker } from "./appimage-packer.ts";
import { makeAppImagePortable } from "./appimage-portability.ts";
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
	const bundle = join(
		resolve(dirname(fileURLToPath(import.meta.url)), ".."),
		"packages/platform-desktop/src-tauri/target",
		universal ? "universal-apple-darwin/release/bundle" : "release/bundle",
		"macos",
	);
	const app = readdirSync(bundle)
		.filter((f) => f.endsWith(".app"))
		.map((f) => join(bundle, f));
	if (app.length !== 1) fail(`expected one .app in ${bundle}, found ${app.length}`);
	try {
		execFileSync("xcrun", ["stapler", "validate", app[0] as string], { stdio: "pipe" });
	} catch {
		fail(
			`${app[0]} is not notarized, though the credentials to notarize it were present.\n` +
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
		// Before the bundler, not after it fails: on Linux the AppImage step fetches its packer from
		// the network, and a failed fetch is a silent fallback rather than an error.
		if (process.platform === "linux") await ensurePacker();
		tauri("bundle", [], env);
		if (notarization.expected) assertNotarized();

		if (process.platform === "linux") {
			const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
			makeAppImagePortable(
				join(root, "packages/platform-desktop/src-tauri/target/release/bundle"),
				env,
			);
		}
	} finally {
		// Whatever the bundler did, the decrypted key must not outlive it.
		notarization.cleanup?.();
	}
}
