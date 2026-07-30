// Export then re-import through the real CXF path, which is what a user moving between two
// Bramble installs (or out to another manager and back) actually goes through.

import { beforeAll, describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { isLogin } from "../hooks/useVault";
import { bytesToBase64 } from "../util/bytes";
import { parseCxf } from "./from-cxf";
import { toCxf } from "./to-cxf";

const OPTS = { exporterRpId: "app.bramble.mobile", exporterDisplayName: "Bramble", now: 1_760_000 };

let privateKey = "";
let publicKeyCose = "";

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	privateKey = bytesToBase64(
		new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
	);
	publicKeyCose = bytesToBase64(new Uint8Array([1, 2, 3])); // replaced on import by the derived key
});

async function roundTrip(entry: Entry) {
	const out = toCxf([entry], OPTS);
	const res = await parseCxf(JSON.stringify(out.payload));
	const back = res.imported[0];
	if (!back) throw new Error("nothing re-imported");
	return { back, warnings: [...out.warnings, ...res.warnings] };
}

describe("CXF round trip", () => {
	it("preserves a login with urls, notes, custom fields and timestamps", async () => {
		const { back } = await roundTrip({
			id: "e1",
			type: "login",
			name: "GitHub",
			urls: ["https://github.com", "https://gist.github.com"],
			username: "octocat",
			password: "correct horse battery staple",
			notes: "recovery kit in the safe",
			customFields: [
				{ key: "PIN", value: "1234", hidden: true },
				{ key: "Account", value: "12345" },
			],
			createdAt: 1_700_000_000_000,
			updatedAt: 1_750_000_500_000,
		});
		expect(back).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octocat",
			password: "correct horse battery staple",
			urls: ["https://github.com", "https://gist.github.com"],
			notes: "recovery kit in the safe",
			customFields: [
				{ key: "PIN", value: "1234", hidden: true },
				{ key: "Account", value: "12345" },
			],
			createdAt: 1_700_000_000_000,
			updatedAt: 1_750_000_500_000,
		});
	});

	it("preserves a TOTP key through the structured hop", async () => {
		const { back } = await roundTrip({
			id: "e1",
			type: "login",
			name: "GitHub",
			urls: [],
			username: "octocat",
			password: "pw",
			totp: "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60",
		});
		if (!isLogin(back)) throw new Error("expected a login");
		expect(back.totp).toContain("secret=JBSWY3DPEHPK3PXP");
		expect(back.totp).toContain("digits=8");
		expect(back.totp).toContain("period=60");
	});

	it("preserves a passkey's key material, which is the whole point of CXF over CSV", async () => {
		const { back } = await roundTrip({
			id: "e1",
			type: "login",
			name: "GitHub",
			urls: ["https://github.com"],
			username: "octocat",
			password: "",
			passkeys: [
				{
					credentialId: bytesToBase64(new Uint8Array([0xfb, 0xff, 0xbe, 0x01])),
					rpId: "github.com",
					userHandle: bytesToBase64(new Uint8Array([0xaa, 0xbb])),
					userName: "octocat",
					userDisplayName: "Octo Cat",
					alg: -7,
					publicKeyCose,
					privateKey,
					signCount: 0,
					createdAt: 1_700_000_000_000,
				},
			],
		});
		if (!isLogin(back)) throw new Error("expected a login");
		const [pk] = back.passkeys ?? [];
		expect(pk?.privateKey).toBe(privateKey);
		expect(pk?.credentialId).toBe(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xbe, 0x01])));
		expect(pk?.userHandle).toBe(bytesToBase64(new Uint8Array([0xaa, 0xbb])));
		expect(pk?.rpId).toBe("github.com");
		expect(pk?.userName).toBe("octocat");
		expect(pk?.userDisplayName).toBe("Octo Cat");
		expect(pk?.signCount).toBe(0);
		// The public key is rebuilt from the private key rather than carried, so it comes back
		// as a real COSE_Key, not the placeholder that went out.
		expect(pk?.publicKeyCose).not.toBe(publicKeyCose);
		expect(pk?.publicKeyCose.length).toBeGreaterThan(80);
	});

	it("preserves a card", async () => {
		const { back } = await roundTrip({
			id: "c1",
			type: "card",
			name: "Visa",
			cardholderName: "Ada Lovelace",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "4",
			expYear: "2030",
			cvv: "123",
		});
		expect(back).toMatchObject({
			type: "card",
			name: "Visa",
			cardholderName: "Ada Lovelace",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "4",
			expYear: "2030",
			cvv: "123",
		});
	});

	it("preserves a note", async () => {
		const { back } = await roundTrip({
			id: "n1",
			type: "note",
			name: "Wifi",
			notes: "the password is on the router",
		});
		expect(back).toMatchObject({
			type: "note",
			name: "Wifi",
			notes: "the password is on the router",
		});
	});

	it("degrades an SSH key to a note carrying its fields, and warns both ways", async () => {
		const { back, warnings } = await roundTrip({
			id: "s1",
			type: "ssh-key",
			name: "deploy key",
			publicKey: "ssh-ed25519 AAAA",
			privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
			passphrase: "hunter2",
			keyType: "ed25519",
		});
		expect(warnings[0]).toMatch(/SSH key/);
		expect(back.type).toBe("note");
		expect(back.customFields).toEqual([
			{ key: "Key Type", value: "ed25519" },
			{ key: "Public Key", value: "ssh-ed25519 AAAA" },
			{
				key: "Private Key",
				value: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
				hidden: true,
			},
			{ key: "Passphrase", value: "hunter2", hidden: true },
		]);
	});
});
