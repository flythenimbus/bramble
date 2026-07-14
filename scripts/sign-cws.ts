// Publish the built Chromium extension to the Chrome Web Store via the Publish API V2
// (service-account auth). Uploads the signed packages/platform-extension/bramble.crx to the item,
// then publishes it (it goes to CWS review, then live). The Chrome analog of sign-firefox.ts (AMO).
//   node scripts/sign-cws.ts [path/to/bramble.crx] [--upload-only]
//   --upload-only  upload the new package but don't publish (dry run for the auth + upload)
//
// The item has "Verified CRX Uploads" enabled, so the store requires a signed .crx. Uploads use the
// CWS REST API v2 (chromewebstore.googleapis.com), where the X-Goog-Upload-File-Name: *.crx header
// is what marks the raw body as a CRX package; CWS then verifies the .crx signature against the
// item's registered public key and repackages under its own key before publishing. (The legacy
// v1.1 uploadType=media flow has no way to signal this, so it rejected every upload with "You must
// update your item with a crx package" regardless of the bytes.) `pnpm run sign` produces the .crx
// first; it must be signed with the key whose public half is registered on the CWS dashboard.
//
// Auth: a Google Cloud service account with the Chrome Web Store API enabled, added to the CWS
// publisher (Developer Dashboard -> Account). The v2 API takes the same auth/chromewebstore scope
// and supports service accounts. Credentials resolve from CWS_SERVICE_ACCOUNT_JSON (a path to the
// plaintext SA JSON, for CI) else the age-encrypted ~/.config/bramble/cws-service-account.age
// (override CWS_SERVICE_ACCOUNT_AGE), unlocked by your YubiKey (PIN + touch). Item id: CWS_ITEM_ID;
// publisher id: CWS_PUBLISHER_ID (your developer-account id). See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const argv = process.argv.slice(2);
const uploadOnly = argv.includes("--upload-only");
const CRX = resolve(
	argv.find((a) => !a.startsWith("--")) ?? "packages/platform-extension/bramble.crx",
);
const ITEM_ID = process.env.CWS_ITEM_ID ?? "kmokhdhoggbdcgoepifeckhgbfakaknm";
// The v2 API is publisher-scoped: publishers/{PUBLISHER_ID}/items/{ITEM_ID}. The publisher id is
// your developer-account id (Chrome Web Store Developer Dashboard -> Account, or in the dashboard URL).
const PUBLISHER_ID = process.env.CWS_PUBLISHER_ID ?? "38b433bd-8538-4d67-aedf-a1297d133309";
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

if (!existsSync(CRX)) fail(`no ${CRX}; run 'pnpm run sign' (or 'pnpm run bundle') first`);
if (!PUBLISHER_ID)
	fail(
		"set CWS_PUBLISHER_ID to your Chrome Web Store publisher id (the developer-account id in the Developer Dashboard URL / Account page). See docs/release-signing.md",
	);

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
	const bearer = `Bearer ${accessToken}`;
	const itemPath = `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`;

	// Upload the signed .crx via the CWS API v2. The X-Goog-Upload-File-Name ending in ".crx" marks
	// the raw body as a signed CRX package; the store verifies its signature against the item's
	// registered "Verified CRX Uploads" key, then repackages under its own key.
	type UploadRes = {
		uploadState?: string;
		crxVersion?: string;
		itemError?: { error_code?: string; error_detail?: string }[];
	};
	const uploadDetail = (r: UploadRes) => {
		const d = r.itemError
			?.map((e) => e.error_detail)
			.filter(Boolean)
			.join("; ");
		return d || JSON.stringify(r);
	};
	const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/${itemPath}:upload`;
	console.log(`uploading ${CRX}\n  -> ${uploadUrl}`);
	const upRes = await fetch(uploadUrl, {
		method: "POST",
		headers: {
			authorization: bearer,
			"x-goog-upload-protocol": "raw",
			"x-goog-upload-file-name": basename(CRX),
		},
		body: readFileSync(CRX),
	});
	let up = (await upRes.json()) as UploadRes;
	if (!upRes.ok) fail(`upload failed (HTTP ${upRes.status}): ${uploadDetail(up)}`);
	// v2 upload states: SUCCEEDED (done), IN_PROGRESS (async — poll :fetchStatus), FAILED. A raw
	// upload of this size usually settles synchronously; poll for the async case (give up after ~60s).
	// (Match on both the v2 and legacy spellings so a state rename can't false-fail a good upload.)
	const inProgress = (s?: string) =>
		s === "IN_PROGRESS" || s === "UPLOAD_IN_PROGRESS" || s === "PENDING";
	const succeeded = (s?: string) => s === "SUCCEEDED" || s === "SUCCESS";
	for (let i = 0; inProgress(up.uploadState) && i < 20; i++) {
		await new Promise((r) => setTimeout(r, 3000));
		const stRes = await fetch(`https://chromewebstore.googleapis.com/v2/${itemPath}:fetchStatus`, {
			headers: { authorization: bearer },
		});
		const st = (await stRes.json()) as { lastAsyncUploadState?: string } & UploadRes;
		up = {
			uploadState: st.lastAsyncUploadState,
			crxVersion: st.crxVersion,
			itemError: st.itemError,
		};
	}
	if (!succeeded(up.uploadState))
		fail(`upload failed (state ${up.uploadState ?? "unknown"}): ${uploadDetail(up)}`);
	console.log(
		`upload OK (state ${up.uploadState}${up.crxVersion ? `, crx v${up.crxVersion}` : ""})`,
	);

	if (uploadOnly) {
		console.log(`\nuploaded ${ITEM_ID} (not published; drop --upload-only to publish).`);
	} else {
		console.log("upload OK; publishing...");
		const pubRes = await fetch(`https://chromewebstore.googleapis.com/v2/${itemPath}:publish`, {
			method: "POST",
			headers: { authorization: bearer, "content-type": "application/json" },
			body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
		});
		const pub = (await pubRes.json()) as { status?: string[]; error?: { message?: string } };
		if (!pubRes.ok || pub.error)
			fail(`publish failed (${pubRes.status}): ${pub.error?.message ?? JSON.stringify(pub)}`);
		console.log(
			`\npublished ${ITEM_ID} to the Chrome Web Store${
				pub.status?.length ? ` (status: ${pub.status.join(", ")})` : ""
			}. It goes live after CWS review.`,
		);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
