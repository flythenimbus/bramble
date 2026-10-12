// Pure pieces of the APT publisher (scripts/publish-apt.ts), split out so they can be tested
// without aptly, gpg or a network.

/** aptly's own name for the repository; not user-visible. */
export const REPO = "bramble";
/** The suite in `bramble.sources`. Changing it orphans every installed client. */
export const SUITE = "stable";

/** Each package a `Packages` index names: its pool path and the checksum apt will hold it to. */
export function packageFiles(packages: string): { path: string; sha256: string }[] {
	return packages
		.split(/\n\s*\n/)
		.map((stanza) => ({
			path: stanza.match(/^Filename: (.+)$/m)?.[1]?.trim(),
			sha256: stanza.match(/^SHA256: ([0-9a-f]{64})$/m)?.[1],
		}))
		.filter((entry): entry is { path: string; sha256: string | undefined } => !!entry.path)
		.map(({ path, sha256 }) => {
			if (!sha256) throw new Error(`${path} has no SHA256 in the index`);
			return { path, sha256 };
		});
}

/** The SHA256 of each index file a signed `InRelease` (or `Release`) vouches for, by path. */
export function indexHashes(release: string): Map<string, string> {
	const section = release.match(/^SHA256:\n((?: .+\n?)+)/m)?.[1] ?? "";
	const hashes = new Map<string, string>();
	for (const line of section.split("\n")) {
		const [sha256, , path] = line.trim().split(/\s+/);
		if (sha256 && path) hashes.set(path, sha256);
	}
	return hashes;
}

/**
 * The aptly command that signs and publishes the index. Flags go BEFORE the positionals: aptly
 * stops reading flags at the first non-flag word, so `publish repo bramble -gpg-key=...` takes the
 * key as the PREFIX and publishes the whole tree into a directory named after it, exiting 0.
 *
 * With a passphrase file the key came from the environment (CI), so gpg must not prompt. Without
 * one the key is on the YubiKey, which asks for its PIN through pinentry, so no -batch.
 */
export function publishArgs(opts: {
	published: boolean;
	gpgKey: string;
	passphraseFile?: string;
}): string[] {
	const signing = opts.passphraseFile
		? ["-batch", `-passphrase-file=${opts.passphraseFile}`, `-gpg-key=${opts.gpgKey}`]
		: [`-gpg-key=${opts.gpgKey}`];
	return opts.published
		? ["publish", "update", ...signing, SUITE]
		: ["publish", "repo", ...signing, REPO];
}
