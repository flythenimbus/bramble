// The App Store Connect API key, unlocked from its age + YubiKey wrapper.
//
// Shared by the fastlane lanes (TestFlight upload, App Store metadata) and by macOS notarization
// in build-macos.ts, which reuses the same key. One copy of the unlock, so the two cannot drift.
//
// The wrapper holds all three parts, because the key id and issuer id are useless apart and
// keeping them together means nothing about iOS releases lives loose in the repo:
//
//   { "keyId": "...", "issuerId": "...", "key": "-----BEGIN PRIVATE KEY-----\n..." }
//
// Run directly, it prints that JSON on stdout, which is how the Fastfile reads it:
//
//   node scripts/asc-api-key.ts           # decrypt (YubiKey PIN + touch), print JSON
//   node scripts/asc-api-key.ts --wrap    # one-time: encrypt the plaintext key to the YubiKey
//
// See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { yubiKeyIdentity, yubiKeyRecipient } from "./age-yubikey-identity.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

export const ASC_KEY_AGE =
	process.env.ASC_API_KEY_AGE ?? join(homedir(), ".config/bramble/asc-api-key.age");

export type AscApiKey = { keyId: string; issuerId: string; key: string };

const has = (bin: string): boolean => {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/**
 * The key's three parts, from the environment if already set, else off the YubiKey.
 * Undefined when there is no key to be had; the caller decides whether that is fatal.
 *
 * The environment form is what CI uses: `ASC_KEY_CONTENT` is the .p8's text, not a path, so a
 * runner never writes it to disk on our account.
 */
export function ascApiKey(onError: (message: string) => never): AscApiKey | undefined {
	const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT } = process.env;
	if (ASC_KEY_ID && ASC_ISSUER_ID && ASC_KEY_CONTENT)
		return { keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, key: ASC_KEY_CONTENT };
	if (!existsSync(ASC_KEY_AGE)) return undefined;

	for (const bin of ["age", "age-plugin-yubikey"])
		if (!has(bin)) onError(`${bin} not found; see docs/release-signing.md`);

	// 0700 scratch dir for the identity stub, which points at the YubiKey slot and is not key
	// material. The key itself is read from stdout and never lands in it.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-asc-"));
	try {
		const idFile = join(tmp, "id.txt");
		try {
			writeFileSync(idFile, yubiKeyIdentity());
		} catch (e) {
			onError(`error: ${(e as Error).message}`);
		}
		notifyYubiKeyTouch("decrypt the App Store Connect API key");
		const json = execFileSync("age", ["-d", "-i", idFile, ASC_KEY_AGE], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		});
		return parse(json, ASC_KEY_AGE, onError);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Fails loudly on a wrapper that decrypted but holds the wrong thing, which is otherwise a
 * confusing 401 from Apple halfway through a release. */
function parse(json: string, where: string, onError: (message: string) => never): AscApiKey {
	let parsed: Partial<AscApiKey>;
	try {
		parsed = JSON.parse(json);
	} catch {
		return onError(`${where} did not decrypt to JSON`);
	}
	for (const field of ["keyId", "issuerId", "key"] as const)
		if (!parsed[field]) return onError(`${where} has no "${field}"`);
	if (!parsed.key?.includes("BEGIN PRIVATE KEY"))
		return onError(`${where}'s "key" is not a PEM private key`);
	return parsed as AscApiKey;
}

/**
 * One-time migration: read the plaintext key fastlane used to use and encrypt it to the YubiKey.
 *
 * Encrypting needs the YubiKey plugged in but neither PIN nor touch, because the recipient is a
 * public key. The plaintext is left where it was: deleting someone's only copy of a credential is
 * not this script's call to make, and the instructions say to check the wrapper first.
 */
function wrap(onError: (message: string) => never): void {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const env = readEnvFile(join(root, "fastlane/.env"));
	const keyId = process.env.ASC_KEY_ID ?? env.ASC_KEY_ID;
	const issuerId = process.env.ASC_ISSUER_ID ?? env.ASC_ISSUER_ID;
	const keyPath = resolve(
		root,
		process.env.ASC_KEY_PATH ?? env.ASC_KEY_PATH ?? "fastlane/AuthKey.p8",
	);
	if (!keyId || !issuerId)
		onError("no ASC_KEY_ID / ASC_ISSUER_ID in fastlane/.env or the environment");
	if (!existsSync(keyPath)) onError(`no key at ${keyPath}`);
	if (existsSync(ASC_KEY_AGE)) onError(`${ASC_KEY_AGE} already exists; move it aside first`);

	const blob = JSON.stringify({ keyId, issuerId, key: readFileSync(keyPath, "utf8") }, null, 2);
	mkdirSync(dirname(ASC_KEY_AGE), { recursive: true });
	execFileSync("age", ["-r", yubiKeyRecipient(), "-o", ASC_KEY_AGE], { input: blob });
	chmodSync(ASC_KEY_AGE, 0o600);

	console.log(`wrapped ${keyPath} -> ${ASC_KEY_AGE}`);
	console.log("\nCheck it decrypts (PIN + touch), then remove the plaintext:");
	console.log("  node scripts/asc-api-key.ts | head -c 40");
	console.log(`  rm ${keyPath} fastlane/.env`);
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

// Run directly: wrap, or print the JSON for the Fastfile to read.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const fail = (message: string): never => {
		console.error(`error: ${message}`);
		process.exit(1);
	};
	if (process.argv.includes("--wrap")) wrap(fail);
	else {
		const key = ascApiKey(fail);
		if (!key)
			fail(
				`no App Store Connect key: expected ${ASC_KEY_AGE} (override ASC_API_KEY_AGE), or\n` +
					"ASC_KEY_ID + ASC_ISSUER_ID + ASC_KEY_CONTENT in the environment.\n" +
					"First time? node scripts/asc-api-key.ts --wrap. See docs/release-signing.md",
			);
		process.stdout.write(JSON.stringify(key));
	}
}
