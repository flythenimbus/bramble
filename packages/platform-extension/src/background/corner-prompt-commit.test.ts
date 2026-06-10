import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	defaultOffscreen,
	extensionSender,
	loadBackground,
	type OffscreenResponse,
	pageSender,
} from "../test/test-harness";

// Sidestep IndexedDB/FSA and the binary vault format: the commit path is about
// the decide -> offscreen-encrypt -> write -> index-update glue, which we assert
// via observable outcomes (a re-query reflects the change + a vault-changed
// broadcast fires).
vi.mock("../storage", () => ({
	PENDING_BLOB_KEY: "vault.pendingFlush",
	extensionStorage: {
		readVaultBlob: async () => new Uint8Array([1, 2, 3]),
		writeVaultBlob: async () => {},
		canWriteFromBackground: async () => true,
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
				data: JSON.stringify([
					{ id: "login1", ciphertext: "c", iv: "i", wrappedDek: "w", dekIv: "d" },
				]),
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
		sessionSeed: { "vault.vek": "SEED" },
		offscreen: commitOffscreen,
	});
	await bg.send({ type: "AUTOFILL_SET_INDEX", payload: [LOGIN] }, extensionSender);
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
});

describe("commit: CORNER_FLUSH_HANDOFF after unlock", () => {
	it("commits a parked save handoff and reports success", async () => {
		const bg = await loadBackground({
			sessionSeed: {
				"vault.vek": "SEED",
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
		await bg.send({ type: "AUTOFILL_SET_INDEX", payload: [LOGIN] }, extensionSender);

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
});
