import type { Entry } from "@core/hooks/useVault";
import { describe, expect, it, vi } from "vitest";
import {
	type CardReply,
	type CeremonyFn,
	type CeremonyHost,
	handleCreate,
	handleGet,
	type PasskeyProxyDeps,
	runCreateCeremony,
	runGetCeremony,
} from "./webauthn-proxy";

function deps(over: Partial<PasskeyProxyDeps> = {}): PasskeyProxyDeps {
	return {
		crypto: {
			passkeyMakeCredential: vi.fn(async () => ({
				credentialId: "Q0lE",
				publicKeyCose: "UEs",
				privateKey: "U0s",
				attestationObject: "QVRU",
				authenticatorData: "QUQ",
				publicKey: "UEs",
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
		onSaved: vi.fn(),
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
		expect(d.onSaved).toHaveBeenCalledWith({
			rpId: "github.com",
			created: true,
			loginName: "GitHub",
		});
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

	it("attaches to the login the ceremony picked", async () => {
		const d = deps({
			loadEntries: vi.fn(async () => githubEntries),
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: true,
				placement: { entryId: "login-1" },
			})) as unknown as CeremonyFn,
		});
		await handleCreate(d, 1, createJson(), "https://github.com");
		const plan = (d.savePlacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(plan.kind).toBe("attach");
		expect(plan.entryId).toBe("login-1");
		expect(plan.passkeys).toHaveLength(2); // existing + the new one
	});

	it("creates a new login when the ceremony picks 'new'", async () => {
		const d = deps({
			loadEntries: vi.fn(async () => githubEntries),
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: true,
				placement: "new",
			})) as unknown as CeremonyFn,
		});
		await handleCreate(d, 1, createJson(), "https://github.com");
		const plan = (d.savePlacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(plan.kind).toBe("create");
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

describe("runCreateCeremony", () => {
	const ghLogin = (id: string, username: string): Entry =>
		({
			id,
			type: "login",
			name: `GitHub ${username}`,
			urls: ["https://github.com"],
			username,
			password: "pw",
		}) as Entry;
	const req = { kind: "create" as const, rpId: "github.com", origin: "https://github.com" };

	// A host that records the cards shown and returns scripted replies in order.
	function host(opts: {
		locked?: boolean;
		unlockOk?: boolean;
		entries?: Entry[];
		replies?: CardReply[];
	}) {
		const cards: { existingLoginName?: string; candidates?: { id: string }[] }[] = [];
		let i = 0;
		const h: CeremonyHost = {
			isLocked: () => opts.locked ?? false,
			ensureUnlocked: async () => opts.unlockOk ?? true,
			loadEntries: async () => opts.entries ?? [],
			showCard: async (o) => {
				cards.push(o);
				return opts.replies?.[i++] ?? { approved: true };
			},
		};
		return { h, cards };
	}

	it("unlocked + no domain login -> one confirm card, placement 'new'", async () => {
		const { h, cards } = host({ entries: [] });
		const d = await runCreateCeremony(req, h);
		expect(d).toMatchObject({ approved: true, placement: "new" });
		expect(cards).toHaveLength(1);
		expect(cards[0]).toEqual({}); // generic confirm, no candidates/existingLoginName
	});

	it("unlocked + single domain login -> 'Add to X' card, attach", async () => {
		const { h, cards } = host({ entries: [ghLogin("login-1", "octocat")] });
		const d = await runCreateCeremony({ ...req, userName: "anything" }, h);
		expect(d).toMatchObject({ approved: true, placement: { entryId: "login-1" } });
		expect(cards[0]?.existingLoginName).toBe("GitHub octocat");
	});

	it("unlocked + ambiguous -> picker card; chosen id becomes the target", async () => {
		const five = ["a", "b", "c", "d", "e"].map((u, i) => ghLogin(`gh-${i}`, u));
		const { h, cards } = host({
			entries: five,
			replies: [{ approved: true, choice: "gh-3" }],
		});
		const d = await runCreateCeremony({ ...req, userName: "nomatch" }, h);
		expect(d).toMatchObject({ approved: true, placement: { entryId: "gh-3" } });
		expect(cards[0]?.candidates).toHaveLength(5);
	});

	it("picker 'new' choice -> placement 'new'", async () => {
		const five = ["a", "b", "c", "d", "e"].map((u, i) => ghLogin(`gh-${i}`, u));
		const { h } = host({ entries: five, replies: [{ approved: true, choice: "new" }] });
		expect(await runCreateCeremony({ ...req, userName: "nomatch" }, h)).toMatchObject({
			placement: "new",
		});
	});

	it("locked -> confirm then unlock, no second card for a single account", async () => {
		const { h, cards } = host({ locked: true, entries: [ghLogin("login-1", "octocat")] });
		const d = await runCreateCeremony(req, h);
		expect(d).toMatchObject({ approved: true, placement: { entryId: "login-1" } });
		expect(cards).toHaveLength(1); // the unlock-confirm only; no "Add to X" re-prompt
	});

	it("locked + ambiguous -> confirm, unlock, then the picker (two cards)", async () => {
		const five = ["a", "b", "c", "d", "e"].map((u, i) => ghLogin(`gh-${i}`, u));
		const { h, cards } = host({
			locked: true,
			entries: five,
			replies: [{ approved: true }, { approved: true, choice: "gh-1" }],
		});
		const d = await runCreateCeremony({ ...req, userName: "nomatch" }, h);
		expect(cards).toHaveLength(2);
		expect(d).toMatchObject({ placement: { entryId: "gh-1" } });
	});

	it("declining the first card aborts without unlocking", async () => {
		const unlock = vi.fn(async () => true);
		const { h } = host({ locked: true, replies: [{ approved: false }] });
		h.ensureUnlocked = unlock;
		expect(await runCreateCeremony(req, h)).toEqual({ approved: false });
		expect(unlock).not.toHaveBeenCalled();
	});

	it("failed unlock aborts", async () => {
		const { h } = host({ locked: true, unlockOk: false });
		expect(await runCreateCeremony(req, h)).toEqual({ approved: false });
	});

	it("declining the picker aborts", async () => {
		const five = ["a", "b", "c", "d", "e"].map((u, i) => ghLogin(`gh-${i}`, u));
		const { h } = host({ entries: five, replies: [{ approved: false }] });
		expect(await runCreateCeremony({ ...req, userName: "nomatch" }, h)).toEqual({
			approved: false,
		});
	});
});

describe("runGetCeremony", () => {
	const req = { kind: "get" as const, rpId: "github.com", origin: "https://github.com" };
	const pk = (credentialId: string, username: string): Entry =>
		({
			id: `login-${credentialId}`,
			type: "login",
			name: "GitHub",
			urls: ["https://github.com"],
			username,
			password: "pw",
			passkeys: [
				{
					credentialId,
					rpId: "github.com",
					userHandle: "dXNlcg",
					userName: username,
					alg: -7,
					publicKeyCose: "UEs",
					privateKey: "U0s",
					signCount: 0,
					createdAt: 0,
				},
			],
		}) as Entry;

	function host(opts: {
		locked?: boolean;
		unlockOk?: boolean;
		entries?: Entry[];
		replies?: CardReply[];
	}) {
		const cards: { passkeyChoices?: { credentialId: string; label: string }[] }[] = [];
		let i = 0;
		const h: CeremonyHost = {
			isLocked: () => opts.locked ?? false,
			ensureUnlocked: async () => opts.unlockOk ?? true,
			loadEntries: async () => opts.entries ?? [],
			showCard: async (o) => {
				cards.push(o);
				return opts.replies?.[i++] ?? { approved: true };
			},
		};
		return { h, cards };
	}

	it("single match -> signs in with it, no picker", async () => {
		const { h, cards } = host({ entries: [pk("AAA", "octocat")] });
		const d = await runGetCeremony(req, h);
		expect(d).toMatchObject({ approved: true, userVerified: true, credentialId: "AAA" });
		expect(cards[0]?.passkeyChoices).toBeUndefined(); // a plain confirm, not a picker
	});

	it("no match -> approved with no credentialId (handleGet maps to NotAllowedError)", async () => {
		const { h } = host({ entries: [] });
		expect(await runGetCeremony(req, h)).toEqual({
			approved: true,
			userVerified: true,
			credentialId: undefined,
		});
	});

	it("multiple matches -> picker; chosen credentialId returned", async () => {
		const entries = [pk("AAA", "octocat"), pk("BBB", "octocat2")];
		const { h, cards } = host({ entries, replies: [{ approved: true, choice: "BBB" }] });
		const d = await runGetCeremony(req, h);
		expect(cards[0]?.passkeyChoices?.map((c) => c.label)).toEqual(["octocat", "octocat2"]);
		expect(d).toMatchObject({ approved: true, credentialId: "BBB" });
	});

	it("declining the picker aborts", async () => {
		const entries = [pk("AAA", "octocat"), pk("BBB", "octocat2")];
		const { h } = host({ entries, replies: [{ approved: false }] });
		expect(await runGetCeremony(req, h)).toEqual({ approved: false });
	});

	it("locked -> confirm + unlock then picker for multiple", async () => {
		const entries = [pk("AAA", "octocat"), pk("BBB", "octocat2")];
		const { h, cards } = host({
			locked: true,
			entries,
			replies: [{ approved: true }, { approved: true, choice: "AAA" }],
		});
		const d = await runGetCeremony(req, h);
		expect(cards).toHaveLength(2);
		expect(d).toMatchObject({ credentialId: "AAA" });
	});

	it("decline first card / failed unlock -> aborted", async () => {
		expect(await runGetCeremony(req, host({ replies: [{ approved: false }] }).h)).toEqual({
			approved: false,
		});
		expect(await runGetCeremony(req, host({ locked: true, unlockOk: false }).h)).toEqual({
			approved: false,
		});
	});
});
