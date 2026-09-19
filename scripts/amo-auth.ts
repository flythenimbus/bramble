// addons.mozilla.org API auth, shared by the listing push (metadata-firefox.ts) and the release
// preflight (release.ts), so there is one way a token is made.
//
// AMO takes a JWT signed HS256 with the API secret, issued by the API key, and rejects one that
// lives longer than five minutes. Sixty seconds covers a single request with room for clock skew.

import { createHmac, randomUUID } from "node:crypto";

export const AMO_API =
	// Override for a staging instance; no trailing slash, so paths join with one.
	(process.env.AMO_BASE_URL ?? "https://addons.mozilla.org/api/v5/").replace(/\/$/, "");

export function amoJwt(apiKey: string, apiSecret: string): string {
	const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64(JSON.stringify({ iss: apiKey, jti: randomUUID(), iat: now, exp: now + 60 }));
	const sig = b64(createHmac("sha256", apiSecret).update(`${head}.${body}`).digest());
	return `${head}.${body}.${sig}`;
}
