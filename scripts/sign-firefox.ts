// Sign the built Firefox extension into a Mozilla-signed .xpi for GitHub-hosted
// self-distribution (AMO "unlisted" channel). Usage:
//   node scripts/sign-firefox.ts [path/to/dist] [--channel unlisted|listed]
//   (defaults to packages/platform-extension/dist-firefox, channel unlisted)
//
// Firefox signing differs from Chrome: Mozilla holds the signing key, so there is no local
// key to pack a .crx with. What we hold are AMO API credentials (a JWT issuer + secret from
// addons.mozilla.org). The secret is encrypted at rest with age + a YubiKey (the same scheme
// as the CWS/Android keys); we decrypt it, hand it to web-ext, and Mozilla returns the signed
// .xpi. Unlike local .crx signing this is a network round-trip and AMO refuses to re-sign a
// version, so it runs only at release time, never on `bundle`.
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
import { join, resolve } from "node:path";
import webExt from "web-ext";

const argv = process.argv.slice(2);
const channelIdx = argv.indexOf("--channel");
const channel = channelIdx >= 0 ? argv[channelIdx + 1] : "unlisted";
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
		});
	} catch (e) {
		fail(`AMO signing failed: ${(e as Error).message}`);
	}

	const signed =
		result.downloadedFiles?.find((f) => f.endsWith(".xpi")) ??
		readdirSync(artifacts)
			.filter((f) => f.endsWith(".xpi"))
			.map((f) => join(artifacts, f))[0];
	if (!signed || !existsSync(signed)) fail("web-ext produced no signed .xpi");
	copyFileSync(signed, OUT);
	console.log(`\nsigned ${OUT}\nattach it to the GitHub release (Mozilla-signed, ${channel}).`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
