import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

/**
 * Imports APT_GPG_PRIVATE_KEY into a gpg home that exists for this run only, and returns the
 * passphrase file that unlocks it. Undefined when the variable is not set.
 */
export function importEnvGpgKey(gpgKey: string): string | undefined {
	const envKey = process.env.APT_GPG_PRIVATE_KEY;
	if (!envKey) return undefined;
	const signer = gpgKey.replace(/\s/g, "").toUpperCase();
	const passphrase =
		process.env.APT_GPG_PASSPHRASE ??
		fail("APT_GPG_PRIVATE_KEY is set but APT_GPG_PASSPHRASE is not.");
	const home = mkdtempSync(join(tmpdir(), "bramble-apt-gpg-"));
	chmodSync(home, 0o700);
	process.env.GNUPGHOME = home;
	process.on("exit", () => {
		try {
			execFileSync("gpgconf", ["--kill", "gpg-agent"], { stdio: "ignore" });
		} catch {}
		rmSync(home, { recursive: true, force: true });
	});
	writeFileSync(join(home, "gpg.conf"), "pinentry-mode loopback\n");
	writeFileSync(join(home, "gpg-agent.conf"), "allow-loopback-pinentry\n");
	const truncated =
		`APT_GPG_PRIVATE_KEY holds no secret key for ${gpgKey}.\n` +
		"A multi-line secret typed at gh's interactive prompt keeps only its first line; set it from\n" +
		"the clipboard instead:  pbpaste | gh secret set APT_GPG_PRIVATE_KEY --env apt-release";
	try {
		execFileSync("gpg", ["--batch", "--import"], {
			input: envKey,
			stdio: ["pipe", "ignore", "pipe"],
		});
	} catch {
		fail(truncated);
	}
	const secret = execFileSync("gpg", ["--batch", "--list-secret-keys", "--with-colons"], {
		encoding: "utf8",
	});
	const held = secret
		.split("\n")
		.filter((line) => line.startsWith("fpr:"))
		.map((line) => line.split(":")[9] ?? "");
	if (!held.some((fpr) => fpr.endsWith(signer))) fail(truncated);
	const passphraseFile = join(home, "passphrase");
	writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
	return passphraseFile;
}
