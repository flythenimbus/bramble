#!/usr/bin/env node
// Move the release credentials into GitHub Actions environments, once.
//
// Usage:
//   pnpm run ci:secrets --dry-run                 list what would be set, decrypt nothing
//   pnpm run ci:secrets                           every environment
//   pnpm run ci:secrets --only android-release    one environment
//   pnpm run ci:secrets --p12 ~/devid.p12         the Developer ID certificate alone, no touch
//                                                 (APPLE_CERTIFICATE_PASSWORD in the environment)
//
// The last YubiKey session a release ever needs. Each age wrapper is decrypted into memory and
// piped straight into `gh secret set`, so no plaintext touches the disk on the way. Touch policy is
// "always", so that is one touch per wrapper. Run it from a real terminal: the PIN prompt needs one.
//
// It also creates each environment with you as its required reviewer, which is the approval tap
// that replaces the touch: repository write alone must never be enough to sign. See
// docs/ci-releases.md for the whole trade.
//
// Secret names are the environment variables the build and signing code already reads (or will,
// once each phase lands), never paths. That is the seam that keeps a later move to OIDC custody a
// fetch step in the workflow rather than a change to any signing code.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { yubiKeyIdentity } from "./age-yubikey-identity.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const REPO = "flythenimbus/bramble";
const WRAPPERS = join(homedir(), ".config/bramble");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const p12 = argv.includes("--p12") ? argv[argv.indexOf("--p12") + 1] : undefined;

const fail = (message: string): never => {
	console.error(`error: ${message}`);
	process.exit(1);
};

/** Where a value comes from: described for --dry-run, read only when actually setting it. */
type Source = { from: string; read: () => string | undefined };
type Plan = { env: string; secrets: Record<string, Source> };

// ----- sources -----

let idFile: string | undefined;
let scratch: string | undefined;
const decrypted = new Map<string, Buffer>();

// On every exit, including fail(): the scratch dir only ever holds the identity stub, which points
// at a YubiKey slot and is not key material, but nothing from this script should outlive it.
process.on("exit", () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	decrypted.clear();
});

/** One decrypt per wrapper, however many secrets it feeds: a touch is not free. */
function decrypt(name: string): Buffer {
	const cached = decrypted.get(name);
	if (cached) return cached;
	const path = join(WRAPPERS, name);
	if (!existsSync(path)) fail(`${path} does not exist`);
	if (!idFile) {
		scratch = mkdtempSync(join(tmpdir(), "bramble-ci-secrets-"));
		idFile = join(scratch, "id.txt");
		writeFileSync(idFile, yubiKeyIdentity());
	}
	notifyYubiKeyTouch(`decrypt ${name} for CI`);
	const out = execFileSync("age", ["-d", "-i", idFile, path], {
		stdio: ["inherit", "pipe", "inherit"],
	});
	decrypted.set(name, out);
	return out;
}

/** Text as the release scripts read it: exactly one trailing newline stripped, nothing else. */
const text = (name: string): string => decrypt(name).toString("utf8").replace(/\n$/, "");

const wrapper = (name: string): Source => ({
	from: `~/.config/bramble/${name}`,
	read: () => text(name),
});

const envVar = (name: string): Source => ({
	from: `$${name} (.env.local)`,
	// Empty counts as absent: GitHub refuses an empty secret, and every reader defaults it anyway.
	read: () => process.env[name] || undefined,
});

function keychain(service: string): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).replace(/\n$/, "");
	} catch {
		return undefined;
	}
}

// ----- the plan -----

const PLANS: Plan[] = [
	{
		env: "android-release",
		secrets: {
			// Binary, so base64 of the raw bytes and no newline handling at all.
			ANDROID_KEYSTORE_BASE64: {
				from: "~/.config/bramble/android-release-keystore.age (base64)",
				read: () => decrypt("android-release-keystore.age").toString("base64"),
			},
			// The same order release.ts resolves it in, so CI gets the value releases use today.
			ANDROID_KEYSTORE_PASSWORD: {
				from: "$ANDROID_KEYSTORE_PASSWORD, else Keychain bramble-android-keystore, else .age",
				read: () =>
					process.env.ANDROID_KEYSTORE_PASSWORD ??
					keychain("bramble-android-keystore") ??
					text("android-keystore-password.age"),
			},
			// Only when one exists apart from the store password: release.ts falls back to the store
			// password otherwise, and setting a copy would be a second place for it to go stale.
			ANDROID_KEY_PASSWORD: {
				from: "$ANDROID_KEY_PASSWORD, else Keychain bramble-android-key, else .age, else skipped",
				read: () =>
					process.env.ANDROID_KEY_PASSWORD ??
					keychain("bramble-android-key") ??
					(existsSync(join(WRAPPERS, "android-key-password.age"))
						? text("android-key-password.age")
						: undefined),
			},
		},
	},
	{
		env: "desktop-release",
		secrets: {
			TAURI_SIGNING_PRIVATE_KEY: wrapper("desktop-updater-key.age"),
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: envVar("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
			APPLE_SIGNING_IDENTITY: envVar("APPLE_SIGNING_IDENTITY"),
			// The names Tauri reads to import a signing identity into a throwaway keychain on a runner.
			// Not in any wrapper: it lives in the login keychain, so it arrives as an exported .p12.
			APPLE_CERTIFICATE: {
				from: "--p12 <file> (base64)",
				read: () => (p12 ? readFileSync(resolve(p12)).toString("base64") : undefined),
			},
			APPLE_CERTIFICATE_PASSWORD: {
				from: "$APPLE_CERTIFICATE_PASSWORD, with --p12",
				read: () => (p12 ? process.env.APPLE_CERTIFICATE_PASSWORD || undefined : undefined),
			},
		},
	},
	{
		env: "chrome-release",
		secrets: {
			// Content, not the paths sign.ts and sign-cws.ts take today; the Chrome phase teaches them
			// to read these, so a runner never writes either to disk.
			CWS_KEY_PEM_CONTENT: wrapper("cws-signing-key.age"),
			CWS_SERVICE_ACCOUNT_CONTENT: wrapper("cws-service-account.age"),
		},
	},
	{
		env: "firefox-release",
		secrets: {
			// Both from one wrapper, so one touch.
			AMO_API_KEY: {
				from: "~/.config/bramble/amo-api-credentials.age (.apiKey)",
				read: () => JSON.parse(text("amo-api-credentials.age")).apiKey,
			},
			AMO_API_SECRET: {
				from: "~/.config/bramble/amo-api-credentials.age (.apiSecret)",
				read: () => JSON.parse(text("amo-api-credentials.age")).apiSecret,
			},
		},
	},
];

// ----- run -----

// --p12 sets the certificate and nothing else. It comes from the login keychain rather than a
// wrapper, so it needs no touch, and re-setting the rest of desktop-release alongside it would
// decrypt the updater key again for no reason.
const CERTIFICATE = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"];
if (p12 && only && only !== "desktop-release") fail("--p12 only applies to desktop-release");
const plans = p12
	? PLANS.filter((p) => p.env === "desktop-release").map((p) => ({
			env: p.env,
			secrets: Object.fromEntries(
				Object.entries(p.secrets).filter(([name]) => CERTIFICATE.includes(name)),
			),
		}))
	: only
		? PLANS.filter((p) => p.env === only)
		: PLANS;
if (plans.length === 0)
	fail(`no environment "${only}". Known: ${PLANS.map((p) => p.env).join(", ")}`);
if (p12 && !existsSync(resolve(p12))) fail(`--p12 ${p12} does not exist`);
if (p12 && !process.env.APPLE_CERTIFICATE_PASSWORD)
	fail("--p12 needs APPLE_CERTIFICATE_PASSWORD set to the password you exported it with");

if (dryRun) {
	for (const { env, secrets } of plans) {
		console.log(`${env}  (required reviewer: you)`);
		for (const [name, source] of Object.entries(secrets))
			console.log(`  ${name.padEnd(36)} ${source.from}`);
	}
	console.log("\ndry run: nothing decrypted, no environment touched.");
	process.exit(0);
}

const me = execFileSync("gh", ["api", "user", "--jq", ".id"], { encoding: "utf8" }).trim();

for (const { env, secrets } of plans) {
	// Reviewers first, before any secret lands: an environment that holds a key and nobody has
	// to approve is exactly the state this whole migration exists to avoid, even briefly.
	execFileSync("gh", ["api", "-X", "PUT", `repos/${REPO}/environments/${env}`, "--input", "-"], {
		input: JSON.stringify({
			reviewers: [{ type: "User", id: Number(me) }],
			// A solo maintainer approves their own dispatches; on, nothing could ever ship.
			prevent_self_review: false,
		}),
		stdio: ["pipe", "ignore", "inherit"],
	});
	console.log(`${env}: reviewer set`);

	for (const [name, source] of Object.entries(secrets)) {
		const value = source.read();
		if (value === undefined) {
			console.log(`  ${name}: skipped (${source.from})`);
			continue;
		}
		// stdin rather than --body: argv is world-readable in the process table.
		execFileSync("gh", ["secret", "set", name, "--env", env, "--repo", REPO], {
			input: value,
			stdio: ["pipe", "ignore", "inherit"],
		});
		console.log(`  ${name}: set`);
	}
}

console.log(
	"\nDone. The wrappers and their offline backups stay where they are: they are now the recovery\n" +
		"path, not the release path. If you exported a .p12 for --p12, delete it now.",
);
