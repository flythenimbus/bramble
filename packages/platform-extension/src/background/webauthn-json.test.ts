import {
	base64ToBase64Url,
	base64UrlToBase64,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "@core/util/bytes";
import { describe, expect, it } from "vitest";
import {
	authenticationResponseJSON,
	buildClientData,
	defaultRpId,
	isRegistrableSuffix,
	originHostname,
	parseCreationOptions,
	parseRequestOptions,
	registrationResponseJSON,
} from "./webauthn-json";

describe("base64url", () => {
	it("round-trips bytes through base64url with no +/= chars", () => {
		for (const len of [1, 2, 3, 16, 32, 65]) {
			const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 255) & 0xff);
			const url = bytesToBase64Url(bytes);
			expect(url).not.toMatch(/[+/=]/);
			expect([...base64UrlToBytes(url)]).toEqual([...bytes]);
		}
	});

	it("converts standard base64 (Rust output) to base64url and back", () => {
		const bytes = new Uint8Array([255, 255, 255, 0, 16]); // forces + and / in std b64
		const std = bytesToBase64(bytes);
		const url = base64ToBase64Url(std);
		expect(url).not.toMatch(/[+/=]/);
		// re-padding restores a decodable standard string
		expect([...base64UrlToBytes(url)]).toEqual([...bytes]);
		expect(base64UrlToBase64(url)).toBe(std);
	});
});

describe("isRegistrableSuffix (phishing resistance)", () => {
	it("accepts the registrable domain and exact host", () => {
		expect(isRegistrableSuffix("accounts.google.com", "google.com")).toBe(true);
		expect(isRegistrableSuffix("accounts.google.com", "accounts.google.com")).toBe(true);
		expect(isRegistrableSuffix("google.com", "google.com")).toBe(true);
		expect(isRegistrableSuffix("x.localhost", "localhost")).toBe(true);
	});

	it("rejects cross-origin, bare public suffixes, and empty", () => {
		expect(isRegistrableSuffix("evil.com", "google.com")).toBe(false);
		expect(isRegistrableSuffix("evil.com", "com")).toBe(false);
		expect(isRegistrableSuffix("login.evil.co.uk", "co.uk")).toBe(false);
		expect(isRegistrableSuffix("a.com", "")).toBe(false);
	});
});

describe("rpId helpers", () => {
	it("defaults rpId to the full host and lowercases", () => {
		expect(originHostname("https://Accounts.Google.com:443")).toBe("accounts.google.com");
		expect(defaultRpId("Accounts.Google.com")).toBe("accounts.google.com");
	});
});

describe("buildClientData", () => {
	it("produces canonical webauthn clientData with the verbatim challenge", () => {
		const cd = buildClientData("webauthn.get", "Y2hhbGxlbmdl", "https://example.com");
		expect(JSON.parse(cd.json)).toEqual({
			type: "webauthn.get",
			challenge: "Y2hhbGxlbmdl",
			origin: "https://example.com",
			crossOrigin: false,
		});
		expect(new TextDecoder().decode(base64UrlToBytes(cd.b64Url))).toBe(cd.json);
	});
});

describe("response builders", () => {
	it("registration response converts std base64 fields to base64url", () => {
		const credId = bytesToBase64(new Uint8Array([255, 255, 255]));
		const att = bytesToBase64(new Uint8Array([1, 2, 255, 254]));
		const authData = bytesToBase64(new Uint8Array([9, 8, 7]));
		const spki = bytesToBase64(new Uint8Array([5, 6, 255]));
		const r = JSON.parse(
			registrationResponseJSON({
				credentialIdStdB64: credId,
				attestationObjectStdB64: att,
				authenticatorDataStdB64: authData,
				publicKeyStdB64: spki,
				clientDataB64Url: "Y2Q",
			}),
		);
		expect(r.type).toBe("public-key");
		expect(r.id).toBe(base64ToBase64Url(credId));
		expect(r.id).toBe(r.rawId);
		expect(r.response.attestationObject).toBe(base64ToBase64Url(att));
		expect(r.response.authenticatorData).toBe(base64ToBase64Url(authData));
		expect(r.response.publicKeyAlgorithm).toBe(-7); // required by RegistrationResponseJSON
		expect(r.response.publicKey).toBe(base64ToBase64Url(spki));
		expect(r.response.clientDataJSON).toBe("Y2Q");
		expect(r.response.transports).toEqual(["internal", "hybrid"]);
	});

	it("authentication response carries userHandle or null", () => {
		const credId = bytesToBase64(new Uint8Array([9, 9]));
		const withHandle = JSON.parse(
			authenticationResponseJSON({
				credentialIdStdB64: credId,
				authenticatorDataStdB64: bytesToBase64(new Uint8Array([7])),
				signatureStdB64: bytesToBase64(new Uint8Array([8])),
				clientDataB64Url: "Y2Q",
				userHandleStdB64: bytesToBase64(new Uint8Array([255])),
			}),
		);
		expect(withHandle.response.userHandle).toBe(
			base64ToBase64Url(bytesToBase64(new Uint8Array([255]))),
		);

		const noHandle = JSON.parse(
			authenticationResponseJSON({
				credentialIdStdB64: credId,
				authenticatorDataStdB64: "QQ",
				signatureStdB64: "QQ",
				clientDataB64Url: "Y2Q",
			}),
		);
		expect(noHandle.response.userHandle).toBeNull();
	});
});

describe("option parsing", () => {
	it("parses creation options at the root or nested under publicKey", () => {
		const opts = {
			rp: { id: "github.com", name: "GitHub" },
			user: { id: "dXNlcg", name: "octocat", displayName: "Octo Cat" },
			challenge: "Y2hhbA",
			pubKeyCredParams: [{ type: "public-key", alg: -7 }],
			authenticatorSelection: { userVerification: "required" },
			excludeCredentials: [{ id: "ZXhjbA", type: "public-key" }],
		};
		const flat = parseCreationOptions(JSON.stringify(opts));
		expect(flat.rpId).toBe("github.com");
		expect(flat.userHandleB64Url).toBe("dXNlcg");
		expect(flat.algs).toEqual([-7]);
		expect(flat.excludeCredentialsB64Url).toEqual(["ZXhjbA"]);
		expect(flat.userVerification).toBe("required");

		const nested = parseCreationOptions(JSON.stringify({ publicKey: opts }));
		expect(nested.rpId).toBe("github.com");
	});

	it("parses request options and defaults userVerification to preferred", () => {
		const r = parseRequestOptions(
			JSON.stringify({
				challenge: "Y2hhbA",
				rpId: "github.com",
				allowCredentials: [{ id: "Y3JlZA", type: "public-key" }],
			}),
		);
		expect(r.rpId).toBe("github.com");
		expect(r.allowCredentialsB64Url).toEqual(["Y3JlZA"]);
		expect(r.userVerification).toBe("preferred");
	});
});
