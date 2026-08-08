import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultOffscreen,
	loadBackground,
	type OffscreenResponse,
	pageSender,
	TEST_VEK_KEY,
} from "../test/test-harness";

// Rebuilding the autofill index from disk is what answers a page's query when no view pushed one
// (AUTOFILL_SET_INDEX) - notably right after unlocking in the picker's pop-out window, where the
// page re-queries the moment the unlock is broadcast. It read the decrypted outer payload as a bare
// `EncryptedEntry[]`, but that payload is `{entries, tombstones}`, so it threw, left the index null,
// and every query came back "vault locked" - leaving the page's "Vault locked" row up.

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
		// Non-empty entries ciphertext, so the hydrate path really decrypts the outer list.
		decodeVaultBlob: () => ({
			slots: [{ kind: 99, payload: new Uint8Array() }],
			entriesIv: new Uint8Array(12),
			entriesCiphertext: new Uint8Array([1]),
		}),
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function diskOffscreen(msg: Record<string, any>): OffscreenResponse {
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
		default:
			return defaultOffscreen(msg);
	}
}

describe("autofill query with no pushed index (rebuild from disk)", () => {
	it("answers with the vault's logins, not 'locked'", async () => {
		// Unlocked (a VEK is cached) but no view ever pushed an index: exactly the state a page is
		// in when it re-queries on the unlock broadcast.
		const bg = await loadBackground({
			sessionSeed: { [TEST_VEK_KEY]: "SEED" },
			offscreen: diskOffscreen,
		});
		const { resp } = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		await bg.flush();

		expect(resp.data).toMatchObject({
			locked: false,
			logins: [{ id: "login1", name: "Example", secondary: "alice" }],
		});
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_MATCHES")).toBeUndefined();
	});

	it("reports locked when the vault really is locked", async () => {
		const bg = await loadBackground({ offscreen: diskOffscreen });
		const { resp } = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		await bg.flush();

		expect(resp.data).toMatchObject({ locked: true, logins: [] });
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_MATCHES")).toBeUndefined();
	});
});
