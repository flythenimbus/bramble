/** Turn a KDBX_* failure code into an actionable, human-readable message. */
export function kdbxErrorMessage(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes("KDBX_WRONG_CREDENTIAL")) return "Wrong master password or key file.";
	if (msg.includes("KDBX_UNSUPPORTED_VERSION"))
		return "Only KeePass KDBX4 databases are supported. Re-save it as KDBX4, or export to XML.";
	if (msg.includes("KDBX_UNSUPPORTED_CIPHER"))
		return "This database uses an unsupported cipher (only AES-256 and ChaCha20 are supported).";
	if (msg.includes("KDBX_UNSUPPORTED_KDF"))
		return "This database uses an unsupported key-derivation function. Re-save it with Argon2 in KeePass.";
	// Carries the offending numbers so a bug report is self-diagnosing; every other code here had
	// a message and this one did not, which is why it read as the generic failure below (#78).
	const tooExpensive = /KDBX_KDF_TOO_EXPENSIVE:(\d+)KiB\/(\d+)/.exec(msg);
	if (tooExpensive)
		return `This database's key-derivation settings (${tooExpensive[1]} KiB of memory over ${tooExpensive[2]} rounds) are heavier than Bramble will attempt. Lower them in KeePassXC's database settings and save it again.`;
	if (msg.includes("KDBX_KDF_TOO_EXPENSIVE"))
		return "This database's key-derivation settings are heavier than Bramble will attempt. Lower the Argon2 memory or rounds in KeePassXC and save it again.";
	if (msg.includes("KDBX_UNSUPPORTED_STREAM"))
		return "This database uses an unsupported inner cipher.";
	if (msg.includes("KDBX_NOT_KEEPASS")) return "This doesn't look like a KeePass .kdbx file.";
	if (msg.includes("KDBX_CORRUPT")) return "This .kdbx file appears to be damaged.";
	return "Couldn't open this database.";
}
