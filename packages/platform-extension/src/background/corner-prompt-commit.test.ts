import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	defaultOffscreen,
	extensionSender,
	loadBackground,
	type OffscreenResponse,
	pageSender,
	setAutofillIndex,
	TEST_ACTIVE_VAULT,
	TEST_VEK_KEY,
} from "../test/test-harness";

// Sidestep IndexedDB/FSA and the binary vault format: the commit path is about
// the decide -> offscreen-encrypt -> write -> index-update glue, which we assert
// via observable outcomes (a re-query reflects the change + a vault-changed
// broadcast fires).
vi.mock("../storage", () => ({
	extensionStorage: {
		readVaultBlob: async () => new Uint8Array([1, 2, 3]),
		writeVaultBlob: async () => {},
		getMeta: async () => undefined,
		setMeta: async () => {},
	},
}));

vi.mock("@core/vault-format", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		// Non-empty entries ciphertext so the outer list is decrypted (exercises
		// the full re-encrypt path), and a throwaway slot to satisfy the shape.
		decodeVaultBlob: () => ({
			slots: [{ kind: 99, payload: new Uint8Array() }],
			entriesIv: new Uint8Array(12),
			entriesCiphertext: new Uint8Array([1]),
		}),
		encodeVaultBlob: () => new Uint8Array([9, 9, 9]),
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const LOGIN = {
	type: "login",
	id: "login1",
	hostnames: ["example.com"],
	name: "Example",
	username: "alice",
	password: "pw1",
};

// Offscreen that returns a realistic outer entry list so decrypt/re-encrypt run.
function commitOffscreen(msg: Record<string, any>): OffscreenResponse {
	switch (msg.type) {
		case "CRYPTO_DECRYPT_OUTER":
			return {
				ok: true,
				data: JSON.stringify({
					entries: [
						{
							id: "login1",
							ciphertext: "c",
							iv: "i",
							wrappedDek: "w",
							dekIv: "d",
							hlc: { wall: 1, counter: 0, node: "seed" },
						},
					],
					tombstones: [],
				}),
			};
		case "CRYPTO_DECRYPT":
			return {
				ok: true,
				data: JSON.stringify({
					type: "login",
					name: "Example",
					urls: ["https://example.com"],
					username: "alice",
					password: "pw1",
				}),
			};
		case "CRYPTO_ENCRYPT":
			return { ok: true, data: { ciphertext: "c2", iv: "i2", wrappedDek: "w2", dekIv: "d2" } };
		case "CRYPTO_ENCRYPT_OUTER":
			return { ok: true, data: { iv: "oi", ciphertext: "oc" } };
		default:
			return defaultOffscreen(msg);
	}
}

async function unlocked(): Promise<BackgroundHarness> {
	const bg = await loadBackground({
		sessionSeed: { [TEST_VEK_KEY]: "SEED" },
		offscreen: commitOffscreen,
	});
	await setAutofillIndex(bg, [LOGIN]);
	return bg;
}

function vaultChanged(bg: BackgroundHarness): boolean {
	return bg.state.broadcasts.some((m) => m?.type === "VAULT_CHANGED_EXTERNAL");
}

describe("commit: save a new login (corner prompt, unlocked)", () => {
	it("encrypts, writes, indexes the new login, and broadcasts the change", async () => {
		const bg = await unlocked();
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "secret" } },
			pageSender("newsite.com", 5),
		);
		const promptId = cap.resp.data.promptId;

		const res = await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId, action: "save" } },
			pageSender("newsite.com", 5),
		);
		expect(res.resp).toEqual({ ok: true, data: null });
		expect(vaultChanged(bg)).toBe(true);
		// Stash cleared so the card doesn't re-surface.
		expect(bg.state.session["capture.pending.newsite.com"]).toBeUndefined();

		// The new login is now queryable on its host.
		const find = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "newsite.com", hasLogin: true } },
			extensionSender,
		);
		expect(find.resp.data.logins).toHaveLength(1);
		expect(find.resp.data.logins[0].secondary).toBe("bob");
	});
});

describe("commit: update an existing login (password rotation)", () => {
	it("rotates the password in the index after a single-candidate update", async () => {
		const bg = await unlocked();
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "ROTATED" } },
			pageSender("example.com", 5),
		);
		expect(cap.resp.data.kind).toBe("update-login");
		const promptId = cap.resp.data.promptId;

		// A single-candidate update upgrades the "save" action to an update.
		const res = await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId, action: "save" } },
			pageSender("example.com", 5),
		);
		expect(res.resp).toEqual({ ok: true, data: null });
		expect(vaultChanged(bg)).toBe(true);

		const fetched = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login1" } },
			extensionSender,
		);
		expect(fetched.resp.data.password).toBe("ROTATED");
	});

	it("preserves the existing username when the capture has none (password-change form)", async () => {
		const bg = await unlocked();
		// A change-password form has no username field, so the capture's username is empty.
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "", password: "ROTATED" } },
			pageSender("example.com", 5),
		);
		expect(cap.resp.data.kind).toBe("update-login");

		const res = await bg.send(
			{
				type: "CORNER_PROMPT_RESPONSE",
				payload: { promptId: cap.resp.data.promptId, action: "update", chosenEntryId: "login1" },
			},
			pageSender("example.com", 5),
		);
		expect(res.resp).toEqual({ ok: true, data: null });

		// The password rotated, but the saved username is kept, not blanked.
		const fetched = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login1" } },
			extensionSender,
		);
		expect(fetched.resp.data.password).toBe("ROTATED");
		expect(fetched.resp.data.username).toBe("alice");
	});

	it("rejects an explicit update action with no chosenEntryId", async () => {
		const bg = await unlocked();
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "ROTATED" } },
			pageSender("example.com", 5),
		);
		const { resp } = await bg.send(
			{
				type: "CORNER_PROMPT_RESPONSE",
				payload: { promptId: cap.resp.data.promptId, action: "update" },
			},
			pageSender("example.com", 5),
		);
		expect(resp).toEqual({ ok: false, error: "update missing chosenEntryId" });
	});

	// A4: a capture on site A must never be written into a login offered only on site B,
	// even if a crafted response names that entry's id. See docs/sec-audit-7726.md (A4).
	it("refuses to update a login whose hostname the capture does not match", async () => {
		const bg = await unlocked();
		// Capture on attacker.com; the only indexed login (login1) is on example.com.
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "mallory", password: "PWNED" } },
			pageSender("attacker.com", 9),
		);
		const promptId = cap.resp.data.promptId;

		const res = await bg.send(
			{
				type: "CORNER_PROMPT_RESPONSE",
				payload: { promptId, action: "update", chosenEntryId: "login1" },
			},
			pageSender("attacker.com", 9),
		);
		expect(res.resp.ok).toBe(false);
		expect(res.resp.error).toContain("not offered on this origin");
		expect(vaultChanged(bg)).toBe(false);

		// login1 is untouched: still the original credential, not the captured one.
		const fetched = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login1" } },
			extensionSender,
		);
		expect(fetched.resp.data.password).toBe("pw1");
	});
});

describe("commit: a signup capture is always a new login", () => {
	it("saves a new login on a signup even when a matching login already exists", async () => {
		const bg = await unlocked();
		// Signup capture (newLogin) on example.com, where login1 (alice) is already saved.
		const cap = await bg.send(
			{
				type: "CORNER_PROMPT_CAPTURE",
				payload: { username: "", password: "GENERATED", newLogin: true },
			},
			pageSender("example.com", 5),
		);
		// The card offers to SAVE a new login, not update the existing one.
		expect(cap.resp.data.kind).toBe("save-login");

		const res = await bg.send(
			{
				type: "CORNER_PROMPT_RESPONSE",
				payload: { promptId: cap.resp.data.promptId, action: "save" },
			},
			pageSender("example.com", 5),
		);
		expect(res.resp).toEqual({ ok: true, data: null });

		// Two logins now on example.com: the original plus the new one.
		const find = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasLogin: true } },
			extensionSender,
		);
		expect(find.resp.data.logins).toHaveLength(2);
		// The original login is untouched (not rotated).
		const fetched = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "login1" } },
			extensionSender,
		);
		expect(fetched.resp.data.password).toBe("pw1");
	});
});

describe("commit: CORNER_FLUSH_HANDOFF after unlock", () => {
	it("commits a parked save handoff and reports success", async () => {
		const bg = await loadBackground({
			sessionSeed: {
				[TEST_VEK_KEY]: "SEED",
				"cornerPrompt.handoff": {
					intent: "save",
					capture: {
						promptId: "p1",
						etld1: "newsite.com",
						hostname: "newsite.com",
						username: "bob",
						password: "secret",
						capturedAt: 0,
					},
				},
			},
			offscreen: commitOffscreen,
		});
		await setAutofillIndex(bg, [LOGIN]);

		const { resp } = await bg.send({ type: "CORNER_FLUSH_HANDOFF" });
		expect(resp).toEqual({ ok: true, data: true });
		expect(vaultChanged(bg)).toBe(true);
		expect(bg.state.session["cornerPrompt.handoff"]).toBeUndefined();

		const find = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "newsite.com", hasLogin: true } },
			extensionSender,
		);
		expect(find.resp.data.logins.map((l: any) => l.secondary)).toContain("bob");
	});

	// The popup fires the flush the instant its unwrap resolves, but the background mirrors the
	// active vault id from a storage event that can still be in flight, so the first flush can
	// see a "locked" vault. It must park the handoff (not consume it) and commit once the id
	// lands — previously the handoff was cleared first, losing the capture outright.
	it("parks the handoff when the unlock isn't visible yet, then commits it", async () => {
		const bg = await loadBackground({
			// VEK cached, but the active-vault id hasn't been mirrored yet: reads as locked.
			sessionSeed: {
				[TEST_VEK_KEY]: "SEED",
				"vault.activeId": undefined,
				"cornerPrompt.handoff": {
					intent: "save",
					capture: {
						promptId: "p1",
						etld1: "newsite.com",
						hostname: "newsite.com",
						username: "bob",
						password: "secret",
						capturedAt: 0,
						newLogin: true,
					},
				},
			},
			offscreen: commitOffscreen,
		});
		const early = await bg.send({ type: "CORNER_FLUSH_HANDOFF" });
		expect(early.resp).toEqual({ ok: false, error: "vault still locked" });
		expect(bg.state.session["cornerPrompt.handoff"]).toBeDefined();

		// The active id lands; the next flush re-reads it and commits the parked capture.
		await bg.chrome.storage.session.set({ "vault.activeId": TEST_ACTIVE_VAULT });
		await setAutofillIndex(bg, [LOGIN]);
		const late = await bg.send({ type: "CORNER_FLUSH_HANDOFF" });
		expect(late.resp).toEqual({ ok: true, data: true });
		expect(bg.state.session["cornerPrompt.handoff"]).toBeUndefined();

		const find = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "newsite.com", hasLogin: true } },
			extensionSender,
		);
		expect(find.resp.data.logins.map((l: any) => l.secondary)).toContain("bob");
	});
});
