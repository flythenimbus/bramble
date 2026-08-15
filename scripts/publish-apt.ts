#!/usr/bin/env node
// Add a built .deb to the APT repository, sign the index, and publish it to R2.
//
// Usage:
//   pnpm run publish:apt              add dist-linux/deb/*.deb, sign, upload
//   pnpm run publish:apt --dry-run    do everything except the upload
//
// This runs on the HOST, not in the Linux build container, and that split is not arbitrary: the
// repository's GPG key lives on a YubiKey, and Docker Desktop on macOS cannot pass a USB device
// through to a container. So the container builds artifacts (scripts/build-linux.ts) and this
// signs and publishes them. `aptly` and `rclone` are both available on macOS and Linux, so the
// only thing that has to be Linux is the build itself.
//
// What apt actually trusts is the signature on `Release`, not the packages: a .deb is verified by
// its checksum in `Packages`, which is covered by `Release`, which is signed. So this step is the
// integrity of the whole channel, and it is the reason the key is gated by a touch.
//
// See docs/release-signing.md, "Linux APT repository".

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEBS = join(ROOT, "dist-linux/deb");
/** aptly's own name for the repository; not user-visible. */
const REPO = "bramble";
/** The suite in `bramble.sources`. Changing it orphans every installed client. */
const SUITE = "stable";
const BUCKET = "bramble-apt";

const dryRun = process.argv.slice(2).includes("--dry-run");

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

function aptly(argv: string[], opts: { quiet?: boolean } = {}): string {
	return execFileSync("aptly", argv, {
		encoding: "utf8",
		stdio: opts.quiet ? ["inherit", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
	});
}

for (const bin of ["aptly", "gpg", "rclone"]) {
	if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
}

const gpgKey = process.env.BRAMBLE_APT_GPG_KEY;
if (!gpgKey) {
	fail(
		"BRAMBLE_APT_GPG_KEY is not set: the fingerprint or uid of the repository signing key.\n" +
			"Put it in .env.local. See docs/release-signing.md.",
	);
}

if (!existsSync(DEBS)) fail(`no packages at ${DEBS}. Run \`pnpm run build:linux\` first.`);
const packages = readdirSync(DEBS).filter((f) => f.endsWith(".deb"));
if (packages.length === 0) fail(`no .deb in ${DEBS}. Run \`pnpm run build:linux\` first.`);

// Created on first use rather than by a separate setup step, so a fresh clone (or a new machine)
// needs nothing typed beyond the key.
const repos = aptly(["repo", "list", "-raw"], { quiet: true });
if (!repos.split("\n").some((line) => line.trim() === REPO)) {
	console.log(`creating the aptly repo "${REPO}"…`);
	aptly(["repo", "create", `-distribution=${SUITE}`, "-component=main", REPO]);
}

for (const deb of packages) {
	console.log(`adding ${deb}…`);
	// -force-replace so re-publishing the same version after a failed run is not an error; version
	// numbers come from tauri.conf.json, and a release that half-failed should be re-runnable.
	aptly(["repo", "add", "-force-replace", REPO, join(DEBS, deb)]);
}

// aptly can sign with its own Go OpenPGP implementation instead of shelling out to gpg, and that
// one cannot talk to a smartcard: it would report a missing secret key for a key that is plainly
// there, because the secret half is on the token. Checked rather than assumed, since the default
// has changed between aptly versions.
const config = JSON.parse(execFileSync("aptly", ["config", "show"], { encoding: "utf8" }));
if (config.gpgProvider && config.gpgProvider !== "gpg") {
	fail(
		`aptly is configured with gpgProvider "${config.gpgProvider}", which cannot use a key on a\n` +
			'YubiKey. Set "gpgProvider": "gpg" in ~/.aptly.conf.',
	);
}

// The touch is here, and only here. Everything above is public metadata.
notifyYubiKeyTouch("sign the APT repository index");
const published = aptly(["publish", "list", "-raw"], { quiet: true });
const already = published.split("\n").some((line) => line.trim().startsWith(`. ${SUITE}`));
// Flags BEFORE the positional arguments: aptly's parser stops looking for flags at the first
// non-flag word, so `publish repo bramble -gpg-key=...` reads the key as the PREFIX argument and
// publishes the whole tree into a directory named `-gpg-key=<fingerprint>`. It succeeds, too,
// which is the annoying part: the only symptom is that dists/ is not where anything expects it.
//
// No -batch either: it stops gpg from prompting, and a card asks for its PIN through pinentry.
// The passphrase prompt -batch exists to avoid is not one this key has.
aptly(
	already
		? ["publish", "update", `-gpg-key=${gpgKey}`, SUITE]
		: ["publish", "repo", `-gpg-key=${gpgKey}`, REPO],
);

const rootDir = config.rootDir;
if (!rootDir) fail("could not read aptly's rootDir from `aptly config show`.");
const publishedDir = join(rootDir.replace("~", process.env.HOME ?? "~"), "public");

// The public key, exported from whatever actually signed above rather than from a committed copy:
// the two drifting apart is a repository nobody can verify, and the failure reads as a network
// problem ("the following signatures were invalid") rather than as a mismatch.
writeFileSync(
	join(publishedDir, "keys.asc"),
	execFileSync("gpg", ["--armor", "--export", gpgKey], { encoding: "utf8" }),
);
copyFileSync(
	join(ROOT, "packages/platform-desktop/apt/bramble.sources"),
	join(publishedDir, "bramble.sources"),
);

console.log(`\npublished tree: ${publishedDir}`);
if (dryRun) {
	console.log("--dry-run: not uploading.");
	process.exit(0);
}

// rclone configured from the environment, so there is no rclone.conf to keep in sync with
// .env.local and no credential written to disk by this script.
for (const [key, value] of Object.entries({
	RCLONE_CONFIG_R2_TYPE: "s3",
	RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
	RCLONE_CONFIG_R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "",
	RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "",
	RCLONE_CONFIG_R2_ENDPOINT: `https://${process.env.R2_ACCOUNT_ID ?? ""}.r2.cloudflarestorage.com`,
	// R2 ignores ACLs, and rclone sends one unless told not to, which some S3 gateways reject.
	RCLONE_CONFIG_R2_NO_CHECK_BUCKET: "true",
})) {
	process.env[key] = value;
}
if (
	!process.env.R2_ACCOUNT_ID ||
	!process.env.R2_ACCESS_KEY_ID ||
	!process.env.R2_SECRET_ACCESS_KEY
) {
	fail("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set (.env.local).");
}

/**
 * Flags every transfer needs, for one reason: R2 answers 501 NotImplemented to operations rclone
 * performs by default against S3.
 *
 * Without these, every upload fails its first attempt and succeeds on the retry, which works but
 * fills a release log with nine errors and an "Attempt 2/3 succeeded" — and a log that always
 * carries errors is a log nobody reads when there is a real one.
 *
 * `--checksum` compares by hash instead of size-and-modtime, so rclone never needs to SET a
 * modtime afterwards (which it does through a server-side copy that R2 rejects). `--s3-no-head`
 * drops the HEAD-after-upload that rclone otherwise does to confirm what it just wrote.
 */
const RCLONE = ["--checksum", "--s3-no-head", "--s3-no-check-bucket", "--progress"];

// The index last. rclone walks alphabetically, so `dists/` would otherwise be live before the
// `pool/` files it points at, and an apt run in that window 404s on a package it was just told
// about. Two passes, packages first, is the whole fix.
console.log("uploading packages…");
execFileSync("rclone", ["sync", join(publishedDir, "pool"), `r2:${BUCKET}/pool`, ...RCLONE], {
	stdio: "inherit",
});
console.log("uploading the index…");
execFileSync("rclone", ["sync", join(publishedDir, "dists"), `r2:${BUCKET}/dists`, ...RCLONE], {
	stdio: "inherit",
});
// The key and the sources snippet, which are what a new user fetches before anything else.
for (const file of ["keys.asc", "bramble.sources"]) {
	execFileSync("rclone", ["copyto", join(publishedDir, file), `r2:${BUCKET}/${file}`, ...RCLONE], {
		stdio: "inherit",
	});
}

console.log("\ndone. Verify with:");
console.log("  curl -fsSL https://apt.bramble.sh/dists/stable/InRelease | gpg --verify -");
