// The desktop updater's signing key, unlocked from its age + YubiKey wrapper.
//
// Shared by the macOS build (build-macos.ts) and the containerised Linux one (build-linux.ts),
// because both produce an artifact the installed app will verify against the public key compiled
// into it: an unsigned or wrongly-signed archive is a release that looks complete and updates
// nobody. One copy of the unlock, so the two cannot drift into two ideas of where the key lives.
//
// The plaintext is returned to the caller and passed onward through the environment. It is never
// written to disk: this key is the root of trust for every update the app will ever accept, so a
// copy left in a temp file is a copy someone could ship a malicious update with.
// See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { yubiKeyIdentity } from "./age-yubikey-identity.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

export const KEY_AGE =
	process.env.DESKTOP_UPDATER_KEY_AGE ?? join(homedir(), ".config/bramble/desktop-updater-key.age");

const has = (bin: string): boolean => {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/**
 * The updater key's contents, from the environment if already set, else off the YubiKey.
 * Undefined when there is no key to be had; the caller decides whether that is fatal.
 *
 * `onError` reports rather than throws, because an unplugged key is the ordinary case here and a
 * stack trace buries the one line that says what to do about it.
 */
export function signingKey(onError: (message: string) => never): string | undefined {
	// Already provided (CI, or an unencrypted key during development).
	if (process.env.TAURI_SIGNING_PRIVATE_KEY) return process.env.TAURI_SIGNING_PRIVATE_KEY;
	if (!existsSync(KEY_AGE)) return undefined;

	for (const bin of ["age", "age-plugin-yubikey"])
		if (!has(bin)) onError(`${bin} not found; see docs/release-signing.md`);

	// 0700 scratch dir for the identity stub, which points at the YubiKey slot and is not key
	// material. The key itself is read from stdout and never lands in it.
	const tmp = mkdtempSync(join(tmpdir(), "bramble-updater-"));
	try {
		const idFile = join(tmp, "id.txt");
		try {
			writeFileSync(idFile, yubiKeyIdentity());
		} catch (e) {
			onError(`error: ${(e as Error).message}`);
		}
		notifyYubiKeyTouch("decrypt the desktop updater signing key");
		return execFileSync("age", ["-d", "-i", idFile, KEY_AGE], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
