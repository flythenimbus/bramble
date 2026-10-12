// node --test scripts/apt-index.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexHashes, packageFiles, publishArgs } from "./apt-index.ts";

const PACKAGES = `Package: bramble
Version: 0.9.0
Architecture: amd64
Filename: pool/main/b/bramble/Bramble_0.9.0_amd64.deb
Size: 10
SHA256: ${"a".repeat(64)}
Description: Bramble

Package: bramble
Version: 0.8.0
Architecture: amd64
SHA256: ${"b".repeat(64)}
Filename: pool/main/b/bramble/Bramble_0.8.0_amd64.deb
`;

const IN_RELEASE = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: Bramble
Suite: stable
MD5Sum:
 ${"0".repeat(32)} 100 main/binary-amd64/Packages
SHA256:
 ${"c".repeat(64)} 100 main/binary-amd64/Packages
 ${"d".repeat(64)} 50 main/binary-amd64/Packages.gz
 ${"e".repeat(64)} 120 main/binary-arm64/Packages
SHA512:
 ${"f".repeat(128)} 100 main/binary-amd64/Packages
-----BEGIN PGP SIGNATURE-----
`;

describe("packageFiles", () => {
	it("reads each package's path and checksum, in any field order", () => {
		assert.deepEqual(packageFiles(PACKAGES), [
			{ path: "pool/main/b/bramble/Bramble_0.9.0_amd64.deb", sha256: "a".repeat(64) },
			{ path: "pool/main/b/bramble/Bramble_0.8.0_amd64.deb", sha256: "b".repeat(64) },
		]);
	});

	it("refuses a stanza missing its checksum rather than re-signing it unchecked", () => {
		assert.throws(
			() => packageFiles("Package: bramble\nFilename: pool/x.deb\n"),
			/pool\/x\.deb has no SHA256/,
		);
	});
});

describe("indexHashes", () => {
	it("reads only the SHA256 section of the signed index", () => {
		const hashes = indexHashes(IN_RELEASE);
		assert.equal(hashes.get("main/binary-amd64/Packages"), "c".repeat(64));
		assert.equal(hashes.get("main/binary-arm64/Packages"), "e".repeat(64));
		assert.equal(hashes.size, 3);
	});
});

describe("publishArgs", () => {
	it("signs through the card interactively, flags before positionals", () => {
		assert.deepEqual(publishArgs({ published: true, gpgKey: "KEY" }), [
			"publish",
			"update",
			"-gpg-key=KEY",
			"stable",
		]);
		assert.deepEqual(publishArgs({ published: false, gpgKey: "KEY" }), [
			"publish",
			"repo",
			"-gpg-key=KEY",
			"bramble",
		]);
	});

	it("signs non-interactively with a passphrase file when the key comes from the environment", () => {
		assert.deepEqual(publishArgs({ published: true, gpgKey: "KEY", passphraseFile: "/tmp/p" }), [
			"publish",
			"update",
			"-batch",
			"-passphrase-file=/tmp/p",
			"-gpg-key=KEY",
			"stable",
		]);
	});
});
