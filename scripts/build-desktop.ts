#!/usr/bin/env node
// Build the desktop app, decrypting the updater signing key only for as long as the bundler needs
// it.
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { yubiKeyIdentity } from "./age-yubikey-identity.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const HOME = homedir();
const KEY_AGE =
	process.env.DESKTOP_UPDATER_KEY_AGE ?? join(HOME, ".config/bramble/desktop-updater-key.age");

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const has = (bin: string): boolean => {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/** The updater key's contents, from the environment if already set, else off the YubiKey. */
function signingKey(): string | undefined {
	// Already provided (CI, or an unencrypted key during development).
	if (process.env.TAURI_SIGNING_PRIVATE_KEY) return process.env.TAURI_SIGNING_PRIVATE_KEY;
	if (!existsSync(KEY_AGE)) return undefined;

	for (const bin of ["age", "age-plugin-yubikey"])
		if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);

	// 0700 scratch dir for the identity stub, which points at the YubiKey slot and is not key
	// material. The key itself is read from stdout and never lands in it.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-updater-"));
	try {
		const idFile = join(tmp, "id.txt");
		writeFileSync(idFile, yubiKeyIdentity());
		notifyYubiKeyTouch("decrypt the desktop updater signing key");
		return execFileSync("age", ["-d", "-i", idFile, KEY_AGE], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const key = signingKey();
if (!key) {
	// Refused rather than built unsigned: an unsigned archive is rejected by every installed app,
	// so a release built without the key looks complete and silently breaks updating.
	fail(
		`no updater signing key: expected ${KEY_AGE} (override DESKTOP_UPDATER_KEY_AGE) or\n` +
			"TAURI_SIGNING_PRIVATE_KEY in the environment. See docs/release-signing.md",
	);
}

const args = [
	"--filter",
	"@vault/platform-desktop",
	"exec",
	"tauri",
	"build",
	...process.argv.slice(2),
];
execFileSync("pnpm", args, {
	stdio: "inherit",
	env: {
		...process.env,
		TAURI_SIGNING_PRIVATE_KEY: key,
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
	},
});
