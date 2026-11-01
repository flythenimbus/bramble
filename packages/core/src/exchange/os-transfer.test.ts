import { describe, expect, it, vi } from "vitest";
import type { CredentialExchangeAdapter } from "../adapters/exchange";
import type { Entry } from "../hooks/useVault";
import { bytesToBase64, bytesToBase64Url } from "../util/bytes";
import { exportToOs, importFromOs } from "./os-transfer";
import { testParserContext } from "./test-crypto";

const login: Entry = {
	id: "e1",
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
};

function adapter(over: Partial<CredentialExchangeAdapter> = {}): CredentialExchangeAdapter {
	return {
		exporterId: "app.bramble.mobile",
		availability: async () => ({ available: true, providerEnabled: true }),
		exportToApp: async (build) => {
			await build("1.0");
		},
		hasPendingImport: async () => false,
		claimImportToken: async () => null,
		redeemImportToken: async () => "{}",
		...over,
	};
}

describe("importFromOs", () => {
	it("returns null when no transfer is waiting, without redeeming anything", async () => {
		const redeem = vi.fn();
		expect(
			await importFromOs(adapter({ redeemImportToken: redeem }), testParserContext),
		).toBeNull();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("redeems the claimed token and parses the payload", async () => {
		const payload = JSON.stringify({
			version: { major: 1, minor: 0 },
			accounts: [
				{
					items: [
						{
							title: "GitHub",
							credentials: [
								{
									type: "basic-auth",
									username: { fieldType: "string", value: "octocat" },
									password: { fieldType: "concealed-string", value: "pw" },
								},
							],
						},
					],
				},
			],
		});
		const redeem = vi.fn().mockResolvedValue(payload);
		const res = await importFromOs(
			adapter({ claimImportToken: async () => "T", redeemImportToken: redeem }),
			testParserContext,
		);
		expect(redeem).toHaveBeenCalledWith("T");
		expect(res?.imported).toHaveLength(1);
		expect(res?.imported[0]).toMatchObject({ type: "login", username: "octocat" });
	});
});

describe("exportToOs", () => {
	it("builds the payload only inside the adapter callback, after a destination exists", async () => {
		let built: string | undefined;
		const ex = adapter({
			exportToApp: async (build) => {
				expect(built).toBeUndefined(); // nothing read from the vault before this point
				built = await build("1.0");
			},
		});
		await exportToOs(ex, [login], "Bramble", 1_760_000);
		const payload = JSON.parse(built ?? "{}");
		expect(payload.exporterRpId).toBe("app.bramble.mobile");
		expect(payload.exporterDisplayName).toBe("Bramble");
		expect(payload.accounts[0].items[0].title).toBe("GitHub");
	});

	it("surfaces the mapper's warnings", async () => {
		const ssh: Entry = {
			id: "s1",
			type: "ssh-key",
			name: "deploy key",
			publicKey: "ssh-ed25519 AAAA",
			privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
		};
		const warnings = await exportToOs(adapter(), [ssh], "Bramble", 1_760_000);
		expect(warnings[0]).toMatch(/SSH key/);
	});

	it("propagates a cancelled picker, so the caller doesn't report a success", async () => {
		const ex = adapter({
			exportToApp: async () => {
				throw new Error("cancelled");
			},
		});
		await expect(exportToOs(ex, [login], "Bramble")).rejects.toThrow("cancelled");
	});
});

// iOS before 26.4 has no fido2Extensions in its CXF types and drops them silently.
describe("an OS that can't carry passkey extensions", () => {
	const oldOs = async () => ({ available: true, providerEnabled: true, passkeyExtensions: false });

	it("export warns when the OS can't carry passkey extensions", async () => {
		const withPrf: Entry = {
			...login,
			passkeys: [
				{
					credentialId: "AQID",
					rpId: "github.com",
					userHandle: "BA==",
					alg: -7,
					publicKeyCose: "AQ==",
					privateKey: bytesToBase64(new Uint8Array(32).fill(4)),
					signCount: 0,
					createdAt: 1,
					prf: { credWithUV: "qg==", credWithoutUV: "uw==" },
				},
			],
		} as Entry;
		const warnings = await exportToOs(
			adapter({ availability: oldOs }),
			[withPrf],
			"Bramble",
			1_760_000,
		);
		expect(warnings).toEqual([expect.stringMatching(/^1 passkey went without/)]);
	});

	it("import warns on such an OS when passkeys arrived, and not when none did", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
		]);
		const key = bytesToBase64Url(
			new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
		);
		const transfer = (credentials: unknown[]) =>
			JSON.stringify({
				version: { major: 1, minor: 0 },
				accounts: [{ items: [{ title: "GitHub", credentials }] }],
			});
		const redeem = (payload: string) =>
			adapter({
				availability: oldOs,
				claimImportToken: async () => "T",
				redeemImportToken: async () => payload,
			});

		const withPasskey = await importFromOs(
			redeem(
				transfer([
					{ type: "passkey", credentialId: "AQID", rpId: "github.com", userHandle: "BA", key },
				]),
			),
			testParserContext,
		);
		expect(withPasskey?.warnings).toEqual([
			expect.stringMatching(/^This iOS version doesn't pass passkey PRF secrets/),
		]);

		const plain = await importFromOs(
			redeem(
				transfer([
					{
						type: "basic-auth",
						username: { fieldType: "string", value: "octocat" },
						password: { fieldType: "concealed-string", value: "pw" },
					},
				]),
			),
			testParserContext,
		);
		expect(plain?.warnings).toEqual([]);
	});
});
