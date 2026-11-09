// node --test scripts/rpm-signing.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasGoodSignature, rpmSignArgs } from "./rpm-signing.ts";

describe("hasGoodSignature", () => {
	it("accepts a package whose signature verified", () => {
		assert.equal(hasGoodSignature("/x/Bramble-1.rpm: digests signatures OK\n"), true);
	});

	it("rejects a package with digests but no signature, which rpm exits 0 for", () => {
		assert.equal(hasGoodSignature("/x/Bramble-1.rpm: digests OK\n"), false);
	});

	it("rejects a signature from a key the keyring does not hold", () => {
		assert.equal(hasGoodSignature("/x/Bramble-1.rpm: digests SIGNATURES NOT OK\n"), false);
	});
});

describe("rpmSignArgs", () => {
	it("names gpg, the key and the passphrase file, with the package last", () => {
		assert.deepEqual(
			rpmSignArgs({ gpg: "/usr/bin/gpg", gpgKey: "KEY", passphraseFile: "/tmp/p", file: "a.rpm" }),
			[
				"--addsign",
				"--define",
				"__gpg /usr/bin/gpg",
				"--define",
				"_gpg_name KEY",
				"--define",
				"_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase-file /tmp/p",
				"a.rpm",
			],
		);
	});
});
