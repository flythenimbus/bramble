// Submit the built Firefox extension to addons.mozilla.org. Default channel is "listed" (the
// public store): AMO reviews it, then signs + publishes, so nothing is downloaded here. Pass
// --channel unlisted to sign immediately for self-distribution and write bramble-firefox.xpi. Usage:
//   node scripts/sign-firefox.ts [path/to/dist] [--channel listed|unlisted]
//   (defaults to packages/platform-extension/dist-firefox, channel listed)
//
// Firefox differs from Chrome: Mozilla holds the signing key, so there is no local key to pack a
// .crx with. What we hold are AMO API credentials (a JWT issuer + secret from addons.mozilla.org).
// The secret is encrypted at rest with age + a YubiKey (the same scheme as the CWS/Android keys).
// Listed uploads enter review (approvalTimeout: 0, so we submit without waiting; AMO signs on
// approval) and carry a source archive for the reviewer (docs/amo-source-build.md); unlisted uploads
// are auto-signed and the .xpi downloaded. Either way it is a network round-trip and AMO refuses to
// reuse a version, so it runs only at release time, never on `bundle`.
//
// Credentials resolve from the env first (AMO_API_KEY + AMO_API_SECRET, for CI / one-off),
// else an age-encrypted JSON at ~/.config/bramble/amo-api-credentials.age (override
// AMO_CREDENTIALS_AGE) holding { "apiKey": "...", "apiSecret": "..." }.
//
// One-time setup lives in docs/release-signing.md.

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import webExt from "web-ext";

const argv = process.argv.slice(2);
const channelIdx = argv.indexOf("--channel");
const channel = channelIdx >= 0 ? argv[channelIdx + 1] : "listed";
// The lone positional is the dist dir (skip the value following --channel).
const distArg = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--channel");
const DIST = resolve(distArg ?? "packages/platform-extension/dist-firefox");
const OUT = resolve("packages/platform-extension/bramble-firefox.xpi");
const HOME = process.env.HOME ?? "";
const CREDS_AGE =
	process.env.AMO_CREDENTIALS_AGE ?? join(HOME, ".config/bramble/amo-api-credentials.age");
// web-ext 8.x requires the AMO API base URL explicitly: its CLI defaults `--amo-base-url`, but the
// programmatic cmd.sign() does not, so an unset value throws "Invalid AMO API base URL: undefined".
// Production AMO (v5) for both channels; override AMO_BASE_URL only for a staging instance.
const AMO_BASE_URL = process.env.AMO_BASE_URL ?? "https://addons.mozilla.org/api/v5/";

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};
const has = (bin: string) => {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

if (channel !== "unlisted" && channel !== "listed")
	fail(`invalid --channel "${channel}" (want unlisted or listed)`);
if (!existsSync(join(DIST, "manifest.json")))
	fail(`no manifest.json in ${DIST}; run 'pnpm run bundle:firefox' first`);

// Resolve AMO credentials: env first, else the age-encrypted JSON (YubiKey PIN + touch).
let apiKey = process.env.AMO_API_KEY;
let apiSecret = process.env.AMO_API_SECRET;

// 0700 scratch dir: the plaintext credentials + signing artifacts live here and are wiped in finally.
const tmp = mkdtempSync(join(tmpdir(), "bramble-sign-ff-"));
try {
	if (!apiKey || !apiSecret) {
		if (!existsSync(CREDS_AGE))
			fail(
				`no AMO credentials: set AMO_API_KEY + AMO_API_SECRET, or provide ${CREDS_AGE} (override AMO_CREDENTIALS_AGE). See docs/release-signing.md`,
			);
		for (const bin of ["age", "age-plugin-yubikey"])
			if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
		const idFile = join(tmp, "id.txt");
		const credFile = join(tmp, "creds.json");
		// The identity stub points at the YubiKey slot; it is not key material.
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		// Prompts for PIN + touch on the terminal.
		execFileSync("age", ["-d", "-i", idFile, "-o", credFile, CREDS_AGE], { stdio: "inherit" });
		const parsed = JSON.parse(readFileSync(credFile, "utf8"));
		apiKey = parsed.apiKey;
		apiSecret = parsed.apiSecret;
		if (!apiKey || !apiSecret)
			fail(`${CREDS_AGE} must decrypt to JSON { "apiKey": "...", "apiSecret": "..." }`);
	}

	// web-ext uploads dist-firefox to AMO, waits for automated signing, and downloads the signed
	// .xpi into `artifacts`. The extension id (browser_specific_settings.gecko.id) must be set.
	const artifacts = join(tmp, "artifacts");
	// AMO review needs the buildable source for a listed add-on (Bramble is bundled + ships WASM).
	// Archive the working tree: `git stash create` captures the release's uncommitted version bump,
	// so the source matches what built dist-firefox. docs/amo-source-build.md ships inside it.
	let sourceArchive: string | undefined;
	if (channel === "listed") {
		sourceArchive = join(tmp, "bramble-source.zip");
		const worktree = execFileSync("git", ["stash", "create"]).toString().trim();
		execFileSync("git", ["archive", "--format=zip", "-o", sourceArchive, worktree || "HEAD"]);
	}
	let result: { downloadedFiles?: string[] };
	try {
		// cmd.sign throws on failure (it never calls process.exit itself), so the catch handles it.
		result = await webExt.cmd.sign({
			sourceDir: DIST,
			artifactsDir: artifacts,
			apiKey,
			apiSecret,
			channel,
			amoBaseUrl: AMO_BASE_URL,
			// Listed versions are signed only after human review; submit and return instead of
			// blocking for an approval that can take days.
			approvalTimeout: channel === "listed" ? 0 : undefined,
			// Reviewers rebuild from this and diff against the upload; unlisted needs no source.
			uploadSourceCode: sourceArchive,
		});
	} catch (e) {
		fail(`AMO signing failed: ${(e as Error).message}`);
	}

	if (channel === "listed") {
		// Nothing to download: AMO signs + publishes a listed version only after review.
		const version = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8")).version;
		console.log(
			`\nsubmitted ${version} to AMO for listed review. AMO signs and publishes it on approval; track it in the Developer Hub.`,
		);
	} else {
		// Unlisted self-distribution: web-ext auto-signs and downloads the .xpi. web-ext 8.x returns
		// downloadedFiles as bare basenames saved into artifactsDir, not full paths, so resolve them
		// against it (an absolute path from another version is passed through); else scan the dir.
		const signed = [...(result.downloadedFiles ?? []), ...readdirSync(artifacts)]
			.filter((f) => f.endsWith(".xpi"))
			.map((f) => (isAbsolute(f) ? f : join(artifacts, f)))
			.find((f) => existsSync(f));
		if (!signed) fail("web-ext produced no signed .xpi");
		copyFileSync(signed, OUT);
		console.log(`\nsigned ${OUT}\nattach it to the GitHub release (Mozilla-signed, unlisted).`);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
