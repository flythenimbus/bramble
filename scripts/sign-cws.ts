// Publish the built Chromium extension to the Chrome Web Store via the Publish API V2
// (service-account auth). Uploads packages/platform-extension/bramble.zip to the item, then
// publishes it (it goes to CWS review, then live). The Chrome analog of sign-firefox.ts (AMO).
//   node scripts/sign-cws.ts [path/to/bramble.zip] [--upload-only]
//   --upload-only  upload the new package but don't publish (dry run for the auth + upload)
//
// Auth: a Google Cloud service account with the Chrome Web Store API enabled, added to the CWS
// publisher (Developer Dashboard -> Account). Credentials resolve from CWS_SERVICE_ACCOUNT_JSON
// (a path to the plaintext SA JSON, for CI) else the age-encrypted
// ~/.config/bramble/cws-service-account.age (override CWS_SERVICE_ACCOUNT_AGE), unlocked by your
// YubiKey (PIN + touch). Item id: CWS_ITEM_ID or the default below. See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const argv = process.argv.slice(2);
const uploadOnly = argv.includes("--upload-only");
const ZIP = resolve(
	argv.find((a) => !a.startsWith("--")) ?? "packages/platform-extension/bramble.zip",
);
const ITEM_ID = process.env.CWS_ITEM_ID ?? "kmokhdhoggbdcgoepifeckhgbfakaknm";
const HOME = process.env.HOME ?? "";
const SA_AGE =
	process.env.CWS_SERVICE_ACCOUNT_AGE ?? join(HOME, ".config/bramble/cws-service-account.age");

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
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

if (!existsSync(ZIP)) fail(`no ${ZIP}; run 'pnpm run bundle' first`);

// 0700 scratch dir; the plaintext service-account key never leaves it and is wiped in finally.
const tmp = mkdtempSync(join(tmpdir(), "bramble-cws-"));
try {
	// Resolve the service-account JSON: env path first (CI), else decrypt the age file (YubiKey).
	let saJson: string;
	const envPath = process.env.CWS_SERVICE_ACCOUNT_JSON;
	if (envPath) {
		if (!existsSync(envPath)) fail(`CWS_SERVICE_ACCOUNT_JSON=${envPath} not found`);
		saJson = readFileSync(envPath, "utf8");
	} else {
		if (!existsSync(SA_AGE))
			fail(
				`no CWS credentials: set CWS_SERVICE_ACCOUNT_JSON, or provide ${SA_AGE} (override CWS_SERVICE_ACCOUNT_AGE). See docs/release-signing.md`,
			);
		for (const bin of ["age", "age-plugin-yubikey"])
			if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
		const idFile = join(tmp, "id.txt");
		const saFile = join(tmp, "sa.json");
		// The identity stub points at the YubiKey slot; it is not key material.
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		// Prompts for PIN + touch on the terminal.
		notifyYubiKeyTouch("decrypt the Chrome Web Store service account");
		execFileSync("age", ["-d", "-i", idFile, "-o", saFile, SA_AGE], { stdio: "inherit" });
		saJson = readFileSync(saFile, "utf8");
	}

	const sa = JSON.parse(saJson) as {
		client_email?: string;
		private_key?: string;
		token_uri?: string;
	};
	if (!sa.client_email || !sa.private_key)
		fail("service-account JSON is missing client_email / private_key");
	const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";

	// Service-account OAuth (V2): sign a short-lived RS256 JWT and exchange it for an access token.
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: sa.client_email,
		scope: "https://www.googleapis.com/auth/chromewebstore",
		aud: tokenUri,
		iat: now,
		exp: now + 3600,
	};
	const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
	const jwt = `${signingInput}.${createSign("RSA-SHA256")
		.update(signingInput)
		.sign(sa.private_key as string)
		.toString("base64url")}`;

	const tokenRes = await fetch(tokenUri, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}),
	});
	if (!tokenRes.ok) fail(`token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
	const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
	if (!accessToken) fail("no access_token in the OAuth response");
	const auth = { authorization: `Bearer ${accessToken}`, "x-goog-api-version": "2" };

	// Upload the new package (CWS re-signs from this zip; the local .crx is only for the GitHub release).
	console.log(`uploading ${ZIP} to Chrome Web Store item ${ITEM_ID}...`);
	const upRes = await fetch(
		`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}?uploadType=media`,
		{ method: "PUT", headers: auth, body: readFileSync(ZIP) },
	);
	const up = (await upRes.json()) as {
		uploadState?: string;
		itemError?: { error_detail?: string }[];
	};
	if (!upRes.ok || up.uploadState !== "SUCCESS") {
		const detail = up.itemError?.map((e) => e.error_detail).join("; ") ?? JSON.stringify(up);
		fail(`upload failed (state ${up.uploadState ?? upRes.status}): ${detail}`);
	}

	if (uploadOnly) {
		console.log(`\nuploaded ${ITEM_ID} (not published; drop --upload-only to publish).`);
	} else {
		console.log("upload OK; publishing...");
		const pubRes = await fetch(
			`https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}/publish`,
			{ method: "POST", headers: { ...auth, "content-length": "0" } },
		);
		const pub = (await pubRes.json()) as { status?: string[]; statusDetail?: string[] };
		// "OK" = accepted; "ITEM_PENDING_REVIEW" = accepted and queued for review. Anything else fails.
		const ok =
			pubRes.ok && (pub.status ?? []).some((s) => s === "OK" || s === "ITEM_PENDING_REVIEW");
		if (!ok)
			fail(
				`publish failed: ${(pub.statusDetail ?? pub.status ?? [JSON.stringify(pub)]).join("; ")}`,
			);
		console.log(
			`\npublished ${ITEM_ID} to the Chrome Web Store (status: ${(pub.status ?? []).join(", ")}). It goes live after CWS review.`,
		);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
