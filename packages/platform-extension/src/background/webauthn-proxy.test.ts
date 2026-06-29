import type { Entry } from "@core/hooks/useVault";
import { describe, expect, it, vi } from "vitest";
import { type CeremonyFn, handleCreate, handleGet, type PasskeyProxyDeps } from "./webauthn-proxy";

function deps(over: Partial<PasskeyProxyDeps> = {}): PasskeyProxyDeps {
	return {
		crypto: {
			passkeyMakeCredential: vi.fn(async () => ({
				credentialId: "Q0lE",
				publicKeyCose: "UEs",
				privateKey: "U0s",
				attestationObject: "QVRU",
			})),
			passkeyGetAssertion: vi.fn(async () => ({
				authenticatorData: "QUQ",
				signature: "U0lH",
			})),
		},
		loadEntries: vi.fn(async () => []),
		savePlacement: vi.fn(async () => {}),
		ceremony: vi.fn(async () => ({ approved: true, userVerified: true })) as unknown as CeremonyFn,
		sha256: vi.fn(async () => "aGFzaA"),
		now: () => 1000,
		...over,
	};
}

const createJson = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		origin: "https://github.com",
		rp: { id: "github.com", name: "GitHub" },
		user: { id: "dXNlcg", name: "octocat", displayName: "Octo" },
		challenge: "Y2hhbA",
		pubKeyCredParams: [{ type: "public-key", alg: -7 }],
		...over,
	});

const githubEntries: Entry[] = [
	{
		id: "login-1",
		type: "login",
		name: "GitHub",
		urls: ["https://github.com"],
		username: "octocat",
		password: "pw",
		passkeys: [
			{
				credentialId: "Q0lE",
				rpId: "github.com",
				userHandle: "dXNlcg",
				alg: -7,
				publicKeyCose: "UEs",
				privateKey: "U0s",
				signCount: 0,
				createdAt: 0,
			},
		],
	} as Entry,
];

describe("handleCreate", () => {
	it("mints, stores, and returns a registration response", async () => {
		const d = deps();
		const res = await handleCreate(d, 7, createJson(), "https://github.com");
		expect(res.requestId).toBe(7);
		expect(res.error).toBeUndefined();
		expect(d.crypto.passkeyMakeCredential).toHaveBeenCalledWith("github.com", true);
		expect(d.savePlacement).toHaveBeenCalledTimes(1);
		const r = JSON.parse(res.responseJson as string);
		expect(r.type).toBe("public-key");
		expect(r.response.attestationObject).toBeTruthy();
		expect(r.response.clientDataJSON).toBeTruthy();
	});

	it("rejects a cross-origin rpId with SecurityError", async () => {
		const d = deps();
		const res = await handleCreate(d, 1, createJson(), "https://evil.com");
		expect(res.error?.name).toBe("SecurityError");
		expect(d.crypto.passkeyMakeCredential).not.toHaveBeenCalled();
	});

	it("rejects when ES256 is not offered", async () => {
		const res = await handleCreate(
			deps(),
			1,
			createJson({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] }),
			"https://github.com",
		);
		expect(res.error?.name).toBe("NotSupportedError");
	});

	it("maps a declined ceremony to NotAllowedError and mints nothing", async () => {
		const d = deps({ ceremony: vi.fn(async () => ({ approved: false })) as unknown as CeremonyFn });
		const res = await handleCreate(d, 1, createJson(), "https://github.com");
		expect(res.error?.name).toBe("NotAllowedError");
		expect(d.crypto.passkeyMakeCredential).not.toHaveBeenCalled();
	});
});

describe("handleGet", () => {
	const getJson = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			origin: "https://github.com",
			rpId: "github.com",
			challenge: "Y2hhbA",
			allowCredentials: [],
			...over,
		});

	it("asserts with the chosen passkey and returns an authentication response", async () => {
		const d = deps({
			loadEntries: vi.fn(async () => githubEntries),
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: true,
				credentialId: "Q0lE",
			})) as unknown as CeremonyFn,
		});
		const res = await handleGet(d, 9, getJson(), "https://github.com");
		expect(res.requestId).toBe(9);
		expect(res.error).toBeUndefined();
		expect(d.crypto.passkeyGetAssertion).toHaveBeenCalledWith("github.com", "U0s", "aGFzaA", true);
		const r = JSON.parse(res.responseJson as string);
		expect(r.response.signature).toBeTruthy();
		expect(r.response.userHandle).toBeTruthy();
	});

	it("returns NotAllowedError when no stored passkey matches", async () => {
		const d = deps({ loadEntries: vi.fn(async () => []) });
		const res = await handleGet(d, 1, getJson(), "https://github.com");
		expect(res.error?.name).toBe("NotAllowedError");
	});

	it("rejects a cross-origin rpId with SecurityError", async () => {
		const res = await handleGet(deps(), 1, getJson(), "https://evil.com");
		expect(res.error?.name).toBe("SecurityError");
	});
});
