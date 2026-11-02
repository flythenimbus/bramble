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
	prfInputsFor,
	proxyCaller,
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
		expect(isRegistrableSuffix("alice.github.io", "github.io")).toBe(false);
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
		const cd = buildClientData("webauthn.get", "Y2hhbGxlbmdl", {
			origin: "https://example.com",
			crossOrigin: false,
		});
		expect(JSON.parse(cd.json)).toEqual({
			type: "webauthn.get",
			challenge: "Y2hhbGxlbmdl",
			origin: "https://example.com",
			crossOrigin: false,
		});
		expect(new TextDecoder().decode(base64UrlToBytes(cd.b64Url))).toBe(cd.json);
	});

	it("records a cross-origin iframe caller as crossOrigin", () => {
		const cd = buildClientData("webauthn.get", "Y2hhbA", {
			origin: "https://pay.example.net",
			crossOrigin: true,
		});
		expect(JSON.parse(cd.json)).toMatchObject({
			origin: "https://pay.example.net",
			crossOrigin: true,
		});
	});
});

describe("proxyCaller (Chrome's stamp of the real requester)", () => {
	const stamped = (stamp: unknown) =>
		JSON.stringify({ challenge: "Y2hhbA", extensions: { remoteDesktopClientOverride: stamp } });

	it("reads the requester's origin and whether it is a cross-origin iframe", () => {
		expect(
			proxyCaller(stamped({ origin: "https://a.example.com", sameOriginWithAncestors: true })),
		).toEqual({ origin: "https://a.example.com", crossOrigin: false });
		expect(
			proxyCaller(stamped({ origin: "https://pay.example.net", sameOriginWithAncestors: false })),
		).toEqual({ origin: "https://pay.example.net", crossOrigin: true });
	});

	it("returns null when the request carries no usable stamp", () => {
		expect(proxyCaller(JSON.stringify({ challenge: "Y2hhbA" }))).toBeNull();
		expect(proxyCaller(stamped({ origin: "chrome-extension://abcdef" }))).toBeNull();
		expect(proxyCaller(stamped({ origin: 5 }))).toBeNull();
		expect(proxyCaller(stamped("https://a.example.com"))).toBeNull();
		expect(proxyCaller("not json")).toBeNull();
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

describe("PRF extension", () => {
	const creation = (extensions?: unknown) =>
		parseCreationOptions(
			JSON.stringify({
				rp: { id: "github.com" },
				user: { id: "dXNlcg", name: "octocat" },
				challenge: "Y2hhbA",
				pubKeyCredParams: [{ type: "public-key", alg: -7 }],
				...(extensions === undefined ? {} : { extensions }),
			}),
		);

	it("parses PRF inputs on creation", () => {
		expect(creation({ prf: { eval: { first: "AQ" } } }).prf).toEqual({ eval: { first: "AQ" } });
		expect(creation({ prf: {} }).prf).toEqual({});
		expect(creation().prf).toBeUndefined();
		expect(creation({ prf: true }).prf).toBeUndefined();
	});

	it("parses PRF inputs on request and drops malformed ones", () => {
		const r = parseRequestOptions(
			JSON.stringify({
				challenge: "Y2hhbA",
				extensions: {
					prf: {
						eval: { first: "Ag" },
						evalByCredential: { Q0lE: { first: "AQ", second: "Aw" }, bad: { first: 5 } },
					},
				},
			}),
		);
		expect(r.prf).toEqual({
			eval: { first: "Ag" },
			evalByCredential: { Q0lE: { first: "AQ", second: "Aw" } },
		});
	});

	it("treats PRF values without a string first as absent", () => {
		const r = parseRequestOptions(
			JSON.stringify({ challenge: "Y2hhbA", extensions: { prf: { eval: {} } } }),
		);
		expect(r.prf).toEqual({});
	});

	it("prfInputsFor prefers the credential's own inputs over eval", () => {
		const prf = { eval: { first: "Ag" }, evalByCredential: { Q0lE: { first: "AQ" } } };
		expect(prfInputsFor(prf, "Q0lE")).toEqual({ first: "AQ" });
		expect(prfInputsFor(prf, "WFla")).toEqual({ first: "Ag" });
		expect(prfInputsFor({ evalByCredential: { Q0lE: { first: "AQ" } } }, "WFla")).toBeUndefined();
		expect(prfInputsFor(undefined, "Q0lE")).toBeUndefined();
	});

	it("response builders carry prf only when given", () => {
		const reg = (prf?: { enabled: boolean; results?: { first: string } }) =>
			JSON.parse(
				registrationResponseJSON({
					credentialIdStdB64: "Q0lE",
					attestationObjectStdB64: "QVRU",
					authenticatorDataStdB64: "QUQ=",
					publicKeyStdB64: "UEs=",
					clientDataB64Url: "Y2Q",
					prf,
				}),
			).clientExtensionResults;
		expect(reg({ enabled: true, results: { first: "AQ" } })).toEqual({
			prf: { enabled: true, results: { first: "AQ" } },
		});
		expect(reg()).toEqual({});

		const auth = (prf?: { results: { first: string } }) =>
			JSON.parse(
				authenticationResponseJSON({
					credentialIdStdB64: "Q0lE",
					authenticatorDataStdB64: "QUQ=",
					signatureStdB64: "U0lH",
					clientDataB64Url: "Y2Q",
					prf,
				}),
			).clientExtensionResults;
		expect(auth({ results: { first: "AQ" } })).toEqual({ prf: { results: { first: "AQ" } } });
		expect(auth()).toEqual({});
	});
});

describe("RP ID public-suffix regressions", () => {
	it.each(["com.sg", "com.hk", "co.th", "edu.au", "net.br", "nhs.uk", "org.nz", "b.ck"])(
		"rejects a passkey scoped to %s",
		(suffix) => {
			expect(isRegistrableSuffix(`evil.${suffix}`, suffix)).toBe(false);
			expect(isRegistrableSuffix(`login.dbs.${suffix}`, `dbs.${suffix}`)).toBe(true);
		},
	);
	it("accepts the PSL exception but rejects a wildcard public suffix", () => {
		expect(isRegistrableSuffix("www.city.kobe.jp", "city.kobe.jp")).toBe(true);
		expect(isRegistrableSuffix("x.foo.kobe.jp", "foo.kobe.jp")).toBe(false);
	});
});
