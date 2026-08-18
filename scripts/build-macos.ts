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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Read from fastlane/.env rather than copied into .env.local so there is one issuer ID in the
 * repo; an explicit APPLE_* in the environment still wins, for CI.
 *
 * Absent, the build still succeeds and produces something Gatekeeper blocks on every machine that
 * did not build it, so it says so rather than leaving that to be discovered by a user.
 */
function loadNotarization(): void {
	// The local-update test build never leaves this machine, so notarizing it buys nothing and
	// costs an upload to Apple, a wait, and a submission record for a build nobody will run.
	if (process.argv.slice(2).some((a) => a.includes("local-update"))) {
		console.error("note: local-update build, skipping notarization.");
		return;
	}
	if (process.env.BRAMBLE_SKIP_NOTARIZE) {
		console.error("note: BRAMBLE_SKIP_NOTARIZE set, skipping notarization.");
		return;
	}

	const already =
		(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY_PATH) ||
		(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
	if (already) return;

	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const vars = readEnvFile(join(root, "fastlane/.env"));
	const keyId = vars.ASC_KEY_ID;
	const issuer = vars.ASC_ISSUER_ID;
	const keyPath = resolve(root, vars.ASC_KEY_PATH ?? "./fastlane/AuthKey.p8");

	if (!keyId || !issuer || !existsSync(keyPath)) {
		console.error(
			"warning: no notarization credentials; the build will be signed but NOT notarized,\n" +
				"         and Gatekeeper will block it on every machine that did not build it.\n" +
				"         See docs/release-signing.md.",
		);
		return;
	}
	process.env.APPLE_API_KEY = keyId;
	process.env.APPLE_API_ISSUER = issuer;
	process.env.APPLE_API_KEY_PATH = keyPath;
}

/** Enough dotenv for fastlane's file: KEY=VALUE, # comments, optional surrounding quotes. */
function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match || line.trimStart().startsWith("#")) continue;
		out[match[1] as string] = (match[2] as string).trim().replace(/^["']|["']$/g, "");
	}
	return out;
}

loadNotarization();

const key = signingKey(fail);
if (!key) {
	// Refused rather than built unsigned: an unsigned archive is rejected by every installed app,
	// so a release built without the key looks complete and silently breaks updating.
	fail(
		`no updater signing key: expected ${KEY_AGE} (override DESKTOP_UPDATER_KEY_AGE) or\n` +
			"TAURI_SIGNING_PRIVATE_KEY in the environment. See docs/release-signing.md",
	);
}

// Universal unless asked otherwise, and only on macOS: `universal-apple-darwin` is a lipo of two
// Apple slices, which is meaningless anywhere else and would fail the build outright. Elsewhere
// the host target is the right and only answer, so Linux produces a .deb and an AppImage for the
// architecture it is running on. A host-arch build IS wrong to hand anyone on macOS, though: it
// looks identical and simply does not open on an Intel Mac, so `--aarch64` (iterating only) is
// what opts out there.
const passed = process.argv.slice(2);
const hostOnly = passed.includes("--aarch64");
const forwarded = passed.filter((a) => a !== "--aarch64");
const universal =
	process.platform === "darwin" && !hostOnly && !forwarded.some((a) => a.startsWith("--target"));

const args = [
	"--filter",
	"@vault/platform-desktop",
	"exec",
	"tauri",
	"build",
	...forwarded,
	...(universal ? ["--target", "universal-apple-darwin"] : []),
];
execFileSync("pnpm", args, {
	stdio: "inherit",
	env: {
		...process.env,
		// stage-proxy builds and lipos both slices when this is set. A sidecar is copied rather
		// than built by the bundler, so without it a universal app ships an Apple-Silicon-only
		// proxy and the browser link is dead on Intel.
		...(universal || forwarded.some((a) => a.includes("universal-apple-darwin"))
			? { BRAMBLE_UNIVERSAL: "1" }
			: {}),
		TAURI_SIGNING_PRIVATE_KEY: key,
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
	},
});
