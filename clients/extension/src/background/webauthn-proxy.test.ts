import type { Entry } from "@core/hooks/useVault";
import { base64UrlToBytes } from "@core/util/bytes";
import { describe, expect, it, vi } from "vitest";
import type { RequestCaller } from "./webauthn-json";
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

const caller = (origin: string, crossOrigin = false): RequestCaller => ({ origin, crossOrigin });

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
				prf: { credWithUV: "V1VW", credWithoutUV: "Tk9VVg==" },
			})),
			passkeyGetAssertion: vi.fn(async () => ({
				authenticatorData: "QUQ",
				signature: "U0lH",
			})),
			passkeyPrfEval: vi.fn(async () => ({ first: "+/8=" })),
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
		const res = await handleCreate(d, 7, createJson(), caller("https://github.com"));
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

	it("refuses a twin of a credential we already hold, with InvalidStateError", async () => {
		const d = deps({ loadEntries: vi.fn(async () => githubEntries) });
		const res = await handleCreate(
			d,
			1,
			createJson({ excludeCredentials: [{ type: "public-key", id: "Q0lE" }] }),
			caller("https://github.com"),
		);
		expect(res.error?.name).toBe("InvalidStateError");
		expect(d.crypto.passkeyMakeCredential).not.toHaveBeenCalled();
		expect(d.savePlacement).not.toHaveBeenCalled();
		// Consent first: the RP must not be able to probe the vault without the user seeing a card.
		expect(d.ceremony).toHaveBeenCalledTimes(1);
	});

	it("still mints when excludeCredentials names credentials this vault has never seen", async () => {
		// The second-device and second-account cases: the RP lists what it has, none of it ours.
		const d = deps({ loadEntries: vi.fn(async () => githubEntries) });
		const res = await handleCreate(
			d,
			1,
			createJson({ excludeCredentials: [{ type: "public-key", id: "b3RoZXI" }] }),
			caller("https://github.com"),
		);
		expect(res.error).toBeUndefined();
		expect(d.crypto.passkeyMakeCredential).toHaveBeenCalledTimes(1);
		expect(d.savePlacement).toHaveBeenCalledTimes(1);
	});

	it("rejects a cross-origin rpId with SecurityError", async () => {
		const d = deps();
		const res = await handleCreate(d, 1, createJson(), caller("https://evil.com"));
		expect(res.error?.name).toBe("SecurityError");
		expect(d.crypto.passkeyMakeCredential).not.toHaveBeenCalled();
	});

	it("rejects when ES256 is not offered", async () => {
		const res = await handleCreate(
			deps(),
			1,
			createJson({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] }),
			caller("https://github.com"),
		);
		expect(res.error?.name).toBe("NotSupportedError");
	});

	it("maps a declined ceremony to NotAllowedError and mints nothing", async () => {
		const d = deps({ ceremony: vi.fn(async () => ({ approved: false })) as unknown as CeremonyFn });
		const res = await handleCreate(d, 1, createJson(), caller("https://github.com"));
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
		await handleCreate(d, 1, createJson(), caller("https://github.com"));
		const plan = (d.savePlacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(plan.kind).toBe("attach");
		expect(plan.entryId).toBe("login-1");
		// Only the new passkey: the write adds it to the login's list as it is then.
		expect(plan.passkey.rpId).toBe("github.com");
		expect(plan).not.toHaveProperty("passkeys");
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
		await handleCreate(d, 1, createJson(), caller("https://github.com"));
		const plan = (d.savePlacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(plan.kind).toBe("create");
	});
});

describe("handleGet", () => {
	it("hands the stored algorithm to the signer, not an assumed one", async () => {
		// A 32-byte secret cannot say whether it is a P-256 scalar or an Ed25519 seed, so the
		// credential's own alg is what lets the core pick. Signing an imported EdDSA passkey as
		// ES256 would produce a signature the site rejects.
		const eddsa: Entry[] = [
			{
				...(githubEntries[0] as Extract<Entry, { type: "login" }>),
				passkeys: [
					{
						...(githubEntries[0] as Extract<Entry, { type: "login" }>).passkeys![0],
						alg: -8,
					},
				],
			} as Entry,
		];
		const d = deps({ loadEntries: vi.fn(async () => eddsa) });
		await handleGet(d, 1, getJson(), caller("https://github.com"));
		expect(d.crypto.passkeyGetAssertion).toHaveBeenCalledWith(
			"github.com",
			"U0s",
			-8,
			expect.any(String),
			true,
		);
	});

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
		const res = await handleGet(d, 9, getJson(), caller("https://github.com"));
		expect(res.requestId).toBe(9);
		expect(res.error).toBeUndefined();
		expect(d.crypto.passkeyGetAssertion).toHaveBeenCalledWith(
			"github.com",
			"U0s",
			-7,
			"aGFzaA",
			true,
		);
		const r = JSON.parse(res.responseJson as string);
		expect(r.response.signature).toBeTruthy();
		expect(r.response.userHandle).toBeTruthy();
	});

	it("returns NotAllowedError when no stored passkey matches", async () => {
		const d = deps({ loadEntries: vi.fn(async () => []) });
		const res = await handleGet(d, 1, getJson(), caller("https://github.com"));
		expect(res.error?.name).toBe("NotAllowedError");
	});

	it("rejects a cross-origin rpId with SecurityError", async () => {
		const res = await handleGet(deps(), 1, getJson(), caller("https://evil.com"));
		expect(res.error?.name).toBe("SecurityError");
	});

	it("signs for the real caller: its own origin, and crossOrigin for an iframe", async () => {
		const d = deps({
			loadEntries: vi.fn(async () => githubEntries),
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: true,
				credentialId: "Q0lE",
			})) as unknown as CeremonyFn,
		});
		const res = await handleGet(d, 1, getJson(), caller("https://gist.github.com", true));
		const clientData = JSON.parse(
			new TextDecoder().decode(
				base64UrlToBytes(JSON.parse(res.responseJson as string).response.clientDataJSON),
			),
		);
		expect(clientData).toMatchObject({ origin: "https://gist.github.com", crossOrigin: true });
	});
});

describe("PRF", () => {
	const extensionResults = (res: { responseJson?: string }) =>
		JSON.parse(res.responseJson as string).clientExtensionResults;
	const prfCreate = (prf: unknown) => createJson({ extensions: { prf } });

	it("create stores the minted PRF secrets on the credential", async () => {
		const d = deps();
		await handleCreate(d, 1, createJson(), caller("https://github.com"));
		const plan = vi.mocked(d.savePlacement).mock.calls[0]?.[0];
		if (plan?.kind !== "create") throw new Error("expected a new login");
		expect(plan.data.passkeys?.[0]?.prf).toEqual({ credWithUV: "V1VW", credWithoutUV: "Tk9VVg==" });
	});

	it("create answers a PRF request with enabled and the eval output", async () => {
		const d = deps();
		const res = await handleCreate(
			d,
			1,
			prfCreate({ eval: { first: "-_8" } }),
			caller("https://github.com"),
		);
		// base64url in, standard base64 to the core: raw input, never pre-hashed.
		expect(d.crypto.passkeyPrfEval).toHaveBeenCalledWith("V1VW", "+/8=", undefined);
		expect(extensionResults(res)).toEqual({ prf: { enabled: true, results: { first: "-_8" } } });
	});

	it("create answers a bare PRF request with enabled and no results", async () => {
		const d = deps();
		const res = await handleCreate(d, 1, prfCreate({}), caller("https://github.com"));
		expect(extensionResults(res)).toEqual({ prf: { enabled: true } });
		expect(d.crypto.passkeyPrfEval).not.toHaveBeenCalled();
	});

	it("create without a PRF request returns no extension results", async () => {
		const res = await handleCreate(deps(), 1, createJson(), caller("https://github.com"));
		expect(extensionResults(res)).toEqual({});
	});

	it("create gives enabled but no results without user verification", async () => {
		const d = deps({
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: false,
			})) as unknown as CeremonyFn,
		});
		const res = await handleCreate(
			d,
			1,
			prfCreate({ eval: { first: "AQ" } }),
			caller("https://github.com"),
		);
		expect(extensionResults(res)).toEqual({ prf: { enabled: true } });
		expect(d.crypto.passkeyPrfEval).not.toHaveBeenCalled();
	});

	const FIXTURE_PRF = { credWithUV: "S0VZVVY=", credWithoutUV: "S0VZTk9VVg==" };
	const login = githubEntries[0] as Extract<Entry, { type: "login" }>;
	const prfEntries: Entry[] = [
		{ ...login, passkeys: [{ ...login.passkeys![0]!, prf: FIXTURE_PRF }] } as Entry,
	];
	const prfGet = (prf: unknown) =>
		JSON.stringify({
			rpId: "github.com",
			challenge: "Y2hhbA",
			allowCredentials: [],
			extensions: { prf },
		});
	const getDeps = (entries: Entry[], over: Partial<PasskeyProxyDeps> = {}) =>
		deps({
			loadEntries: vi.fn(async () => entries),
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: true,
				credentialId: "Q0lE",
			})) as unknown as CeremonyFn,
			...over,
		});

	it("get evaluates PRF with the chosen credential's own inputs", async () => {
		const d = getDeps(prfEntries);
		const res = await handleGet(
			d,
			1,
			prfGet({ eval: { first: "Ag" }, evalByCredential: { Q0lE: { first: "AQ" } } }),
			caller("https://github.com"),
		);
		expect(d.crypto.passkeyPrfEval).toHaveBeenCalledWith("S0VZVVY=", "AQ==", undefined);
		expect(extensionResults(res)).toEqual({ prf: { results: { first: "-_8" } } });
	});

	it("get falls back to eval when the credential has no own inputs", async () => {
		const d = getDeps(prfEntries);
		await handleGet(
			d,
			1,
			prfGet({ eval: { first: "Ag" }, evalByCredential: { WFla: { first: "AQ" } } }),
			caller("https://github.com"),
		);
		expect(d.crypto.passkeyPrfEval).toHaveBeenCalledWith("S0VZVVY=", "Ag==", undefined);
	});

	it("get signs in without PRF output for a passkey minted before PRF", async () => {
		const d = getDeps(githubEntries);
		const res = await handleGet(
			d,
			1,
			prfGet({ eval: { first: "Ag" } }),
			caller("https://github.com"),
		);
		expect(res.error).toBeUndefined();
		expect(extensionResults(res)).toEqual({});
		expect(d.crypto.passkeyPrfEval).not.toHaveBeenCalled();
	});

	it("get gives no PRF output without user verification", async () => {
		const d = getDeps(prfEntries, {
			ceremony: vi.fn(async () => ({
				approved: true,
				userVerified: false,
				credentialId: "Q0lE",
			})) as unknown as CeremonyFn,
		});
		const res = await handleGet(
			d,
			1,
			prfGet({ eval: { first: "Ag" } }),
			caller("https://github.com"),
		);
		expect(extensionResults(res)).toEqual({});
		expect(d.crypto.passkeyPrfEval).not.toHaveBeenCalled();
	});

	it("a failed PRF evaluation still completes the ceremony", async () => {
		const failing = vi.fn(async () => {
			throw new Error("offscreen gone");
		});
		const c = deps();
		c.crypto.passkeyPrfEval = failing;
		const created = await handleCreate(
			c,
			1,
			prfCreate({ eval: { first: "AQ" } }),
			caller("https://github.com"),
		);
		expect(created.error).toBeUndefined();
		expect(extensionResults(created)).toEqual({ prf: { enabled: true } });

		const g = getDeps(prfEntries);
		g.crypto.passkeyPrfEval = failing;
		const got = await handleGet(
			g,
			1,
			prfGet({ eval: { first: "Ag" } }),
			caller("https://github.com"),
		);
		expect(got.error).toBeUndefined();
		expect(extensionResults(got)).toEqual({});
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

	it("single match -> shows the one account so the user knows who, signs in with it", async () => {
		const { h, cards } = host({ entries: [pk("AAA", "octocat")] });
		const d = await runGetCeremony(req, h);
		expect(d).toMatchObject({ approved: true, userVerified: true, credentialId: "AAA" });
		expect(cards[0]?.passkeyChoices?.map((c) => c.label)).toEqual(["octocat"]); // account shown
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
