// Sign the built extension into a .crx for Chrome Web Store verified upload.
// Usage: pnpm run sign [path/to/dist] [--optional]   (defaults to platform-extension/dist-chromium)
//
// Decrypts the RSA signing key (age, unlocked by your YubiKey: PIN + touch),
// packs the unpacked extension into a signed .crx, then wipes the plaintext key.
// Upload the resulting .crx via the CWS dashboard or the Update API.
//
// --optional skips (exit 0) when the key or age tooling is absent, instead of
// failing. `pnpm run bundle` uses it so CI and keyless builds still succeed.
//
// One-time setup lives in docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crx3 from "crx3";

const argv = process.argv.slice(2);
const optional = argv.includes("--optional");
const distArg = argv.find((a) => !a.startsWith("--"));
const DIST = resolve(distArg ?? "packages/platform-extension/dist-chromium");
const OUT = resolve("packages/platform-extension/bramble.crx");
const KEY_AGE =
	process.env.CWS_KEY_AGE ?? join(process.env.HOME ?? "", ".config/bramble/cws-signing-key.age");

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};

// In --optional mode a missing key/tool is a skip, not an error.
const skip = (msg: string): never => {
	console.log(`sign: skipped (${msg})`);
	process.exit(0);
};
const need = optional ? skip : fail;

const has = (bin: string) => {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

if (!existsSync(join(DIST, "manifest.json")))
	fail(`no manifest.json in ${DIST}; run 'pnpm run bundle' first`);
if (!existsSync(KEY_AGE)) need(`encrypted key not found at ${KEY_AGE} (override with CWS_KEY_AGE)`);
for (const bin of ["age", "age-plugin-yubikey"]) {
	if (!has(bin)) need(`${bin} not found; see docs/release-signing.md for setup`);
}

// 0700 scratch dir; the plaintext key never leaves it and is wiped in finally.
const tmp = mkdtempSync(join(tmpdir(), "bramble-sign-"));
const keyPem = join(tmp, "key.pem");
const idFile = join(tmp, "id.txt");
try {
	// The identity stub points at the YubiKey slot; it is not key material.
	writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
	// Prompts for PIN + touch on the terminal.
	execFileSync("age", ["-d", "-i", idFile, "-o", keyPem, KEY_AGE], { stdio: "inherit" });
	await crx3([DIST], { keyPath: keyPem, crxPath: OUT });
	console.log(`\nsigned ${OUT}\nupload it to the Chrome Web Store (verified upload).`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
