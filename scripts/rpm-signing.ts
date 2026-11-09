// The pure half of sign-rpm.ts, testable without rpm or gpg.

export function rpmSignArgs(opts: {
	gpg: string;
	gpgKey: string;
	passphraseFile: string;
	file: string;
}): string[] {
	return [
		"--addsign",
		// Ubuntu's rpm points this at a gpg2 that does not exist.
		"--define",
		`__gpg ${opts.gpg}`,
		"--define",
		`_gpg_name ${opts.gpgKey}`,
		"--define",
		`_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase-file ${opts.passphraseFile}`,
		opts.file,
	];
}

/** rpm exits 0 for a package with no signature at all, so only its output can prove one. */
export const hasGoodSignature = (checksig: string): boolean =>
	/: digests signatures OK\s*$/.test(checksig);
