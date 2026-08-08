import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	defaultOffscreen,
	extensionSender,
	loadBackground,
	pageSender,
	TEST_VEK_KEY,
} from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AUTOFILL_REVALIDATE_SUBMIT", () => {
	it("accepts only the generation issued with a current page selection", async () => {
		const bg = await unlockedWithIndex();
		const sender = pageSender("example.com", 11);
		const selected = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			sender,
		);
		const sessionGeneration = selected.resp.data.sessionGeneration as number;
		expect(
			(await bg.send({ type: "AUTOFILL_REVALIDATE_SUBMIT", sessionGeneration }, sender)).resp,
		).toEqual({ ok: true, data: { sessionGeneration } });
		expect(
			(await bg.send({ type: "AUTOFILL_REVALIDATE_SUBMIT", sessionGeneration: "0" }, sender)).resp,
		).toEqual({ ok: false, error: "invalid_request" });
	});

	it("rejects the issued generation from the synchronous start of a held lock", async () => {
		let release: ((response: ReturnType<typeof defaultOffscreen>) => void) | undefined;
		const bg = await loadBackground({
			sessionSeed: { [VEK_KEY]: "SEED" },
			offscreen: (message) =>
				message.type === "CRYPTO_LOCK"
					? new Promise((resolve) => {
							release = resolve;
						})
					: defaultOffscreen(message),
		});
		await bg.send({ type: "AUTOFILL_SET_INDEX", payload: ENTRIES }, extensionSender);
		const sender = pageSender("example.com", 11);
		const selected = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			sender,
		);
		const sessionGeneration = selected.resp.data.sessionGeneration as number;

		const locking = bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		expect(release).toBeTypeOf("function");
		expect(
			(await bg.send({ type: "AUTOFILL_REVALIDATE_SUBMIT", sessionGeneration }, sender)).resp,
		).toEqual({ ok: false, error: "unavailable" });
		release?.(defaultOffscreen({ type: "CRYPTO_LOCK" }));
		await locking;
	});

	it("does not treat outbound offscreen lock delivery as a new lock request", async () => {
		const bg = await unlockedWithIndex();
		const sender = pageSender("example.com", 11);
		const selected = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			sender,
		);
		const sessionGeneration = selected.resp.data.sessionGeneration as number;

		const outbound = await bg.send({ target: "offscreen", type: "CRYPTO_LOCK" });
		expect(outbound.handled).toBe(false);
		expect(
			(await bg.send({ type: "AUTOFILL_REVALIDATE_SUBMIT", sessionGeneration }, sender)).resp,
		).toEqual({ ok: true, data: { sessionGeneration } });
	});
});

const VEK_KEY = TEST_VEK_KEY;

const ENTRIES = [
	{
		type: "login",
		id: "login1",
		hostnames: ["example.com"],
		name: "Example",
		username: "alice",
		password: "pw1",
	},
	{
		type: "login",
		id: "login2",
		hostnames: ["example.com"],
		name: "Example 2FA",
		username: "bob",
		password: "pw2",
		totp: "JBSWY3DPEHPK3PXP",
	},
	{
		type: "card",
		id: "card1",
		name: "My Visa",
		brand: "Visa",
		cardholderName: "A B",
		number: "4111111111111234",
		expMonth: "3",
		expYear: "2030",
		cvv: "123",
	},
];

async function unlockedWithIndex(): Promise<BackgroundHarness> {
	const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
	await bg.send({ type: "AUTOFILL_SET_INDEX", payload: ENTRIES }, extensionSender);
	return bg;
}

describe("AUTOFILL_SET_INDEX / CLEAR_INDEX", () => {
	it("SET_INDEX persists known hostnames and arms auto-lock", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SET_INDEX", payload: ENTRIES },
			extensionSender,
		);
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.local["autofill.knownHostnames"]).toEqual(["example.com"]);
		expect(bg.state.alarms["vault:autolock"]).toBeDefined();
	});

	it("CLEAR_INDEX drops the in-memory index", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send({ type: "AUTOFILL_CLEAR_INDEX" });
		expect(resp).toEqual({ ok: true, data: null });
	});
});

describe("AUTOFILL_FIND origin gate + matching", () => {
	it("rejects a non-extension sender with the bare 'forbidden' string", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasLogin: true } },
			pageSender("example.com"),
		);
		expect(resp).toEqual({ ok: false, error: "forbidden" });
	});

	it("returns hostname-matched logins for an extension sender", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasLogin: true } },
			extensionSender,
		);
		expect(resp.data.locked).toBe(false);
		expect(resp.data.logins.map((l: any) => l.id)).toEqual(["login1", "login2"]);
	});

	it("offers cards on any host and otps only for totp logins", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{
				type: "AUTOFILL_FIND",
				payload: { hostname: "unrelated.com", hasLogin: true, hasCard: true, hasOtp: true },
			},
			extensionSender,
		);
		// Cards aren't hostname-scoped.
		expect(resp.data.cards.map((c: any) => c.id)).toEqual(["card1"]);
		expect(resp.data.cards[0].secondary).toContain("1234");
		// otps require a hostname match; unrelated.com matches no login.
		expect(resp.data.otps).toHaveLength(0);
		expect(resp.data.logins).toHaveLength(0);
	});

	it("lists only totp logins under otps on a matching host", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasOtp: true } },
			extensionSender,
		);
		expect(resp.data.otps.map((o: any) => o.id)).toEqual(["login2"]);
	});

	it("reports locked with hasPotentialMatch once the index is gone but the host is known", async () => {
		const bg = await unlockedWithIndex();
		await bg.send({ type: "CRYPTO_LOCK" });
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "sub.example.com", hasLogin: true } },
			extensionSender,
		);
		expect(resp.data.locked).toBe(true);
		expect(resp.data.hasPotentialMatch).toBe(true);
	});
});

describe("AUTOFILL_FETCH", () => {
	it("rejects a non-extension sender", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login1" } },
			pageSender("example.com"),
		);
		expect(resp).toEqual({ ok: false, error: "forbidden" });
	});

	it("returns the login fill payload with a live TOTP code", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login2" } },
			extensionSender,
		);
		expect(resp.ok).toBe(true);
		expect(resp.data.kind).toBe("login");
		expect(resp.data.username).toBe("bob");
		expect(resp.data.password).toBe("pw2");
		expect(resp.data.totp).toMatch(/^\d{6}$/);
	});

	it("returns the card fill payload", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "card1" } },
			extensionSender,
		);
		expect(resp.data).toMatchObject({
			kind: "card",
			number: "4111111111111234",
			cvv: "123",
			expMonth: "3",
			expYear: "2030",
		});
	});

	it("throws for an unknown entry id", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "ghost" } },
			extensionSender,
		);
		expect(resp).toEqual({ ok: false, error: "Error: entry not found: ghost" });
	});
});

describe("AUTOFILL_SELECT authorize + fill", () => {
	it("returns a login only on the original response channel and emits no tab fill", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1", isAuto: false, otpOnly: false } },
			pageSender("example.com", 11, 7),
		);
		expect(resp).toMatchObject({
			ok: true,
			data: {
				payload: { kind: "login", username: "alice", password: "pw1" },
				isAuto: false,
				otpOnly: false,
			},
		});
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_FILL")).toBeUndefined();
	});

	it("fails closed when the sender is not a page content sender", async () => {
		const bg = await unlockedWithIndex();
		const noFrame = {
			origin: "https://example.com",
			url: "https://example.com/login",
		};
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			noFrame,
		);
		expect(resp).toEqual({ ok: false, error: "forbidden" });
	});

	it("refuses to fill a login on a non-matching origin (clickjacking / wrong-site guard)", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			pageSender("evil.com", 11),
		);
		expect(resp).toEqual({ ok: false, error: "unavailable" });
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_FILL")).toBeUndefined();
	});

	it("fills a card on any origin (cards are site-agnostic)", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "card1", otpOnly: false } },
			pageSender("some-shop.example", 12),
		);
		expect(resp).toMatchObject({ ok: true, data: { payload: { kind: "card" } } });
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_FILL")).toBeUndefined();
	});
});

describe("AUTOFILL_QUERY direct response transport", () => {
	it("derives the sender hostname, returns summaries directly, and sends no tab message", async () => {
		const bg = await unlockedWithIndex();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_QUERY", hostname: "evil.com", hasLogin: true },
			pageSender("example.com", 42),
		);
		expect(resp.ok).toBe(true);
		expect(resp.data.logins.map((login: { id: string }) => login.id)).toEqual(
			expect.arrayContaining(["login1", "login2"]),
		);
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_MATCHES")).toBeUndefined();
	});

	it("rejects malformed optional ids and echoes a canonical id without granting authority", async () => {
		const bg = await unlockedWithIndex();
		const requestId = "123e4567-e89b-42d3-a456-426614174000";
		const valid = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true, requestId },
			pageSender("example.com", 42),
		);
		expect(valid.resp).toMatchObject({ ok: true, requestId });
		const invalid = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true, requestId: "not-a-uuid" },
			pageSender("example.com", 42),
		);
		expect(invalid.resp).toEqual({ ok: false, error: "invalid_request" });
	});
});

describe("AUTOFILL_SELECT session transitions", () => {
	it("fails a select held across lock, including lock-to-unlock ABA", async () => {
		const bg = await unlockedWithIndex();
		const originalGet = bg.chrome.storage.local.get;
		let release: ((value: unknown) => void) | undefined;
		bg.chrome.storage.local.get = vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const pending = bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			pageSender("example.com", 11),
		);
		await Promise.resolve();
		await bg.send({ type: "CRYPTO_LOCK" });
		bg.chrome.storage.local.get = originalGet;
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		release?.(await originalGet(["pref.autoLockMinutes"]));
		expect((await pending).resp).toEqual({ ok: false, error: "unavailable" });
	});

	it("rejects a select that begins while the vault is locked", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			pageSender("example.com", 11),
		);
		expect(resp).toEqual({ ok: false, error: "unavailable" });
	});
});
