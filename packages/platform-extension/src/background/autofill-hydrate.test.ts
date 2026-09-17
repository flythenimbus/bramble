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

vi.mock("../storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../storage")>()),
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
		case "CRYPTO_DECRYPT_INDEX":
			return {
				ok: true,
				data: [
					{
						id: "login1",
						plaintext: JSON.stringify({
							type: "login",
							name: "Example",
							urls: ["https://example.com"],
							username: "alice",
							password: "pw1",
						}),
					},
				],
			};
		default:
			return defaultOffscreen(msg);
	}
}

/** The same disk, but the one login on it has been archived. */
function archivedOffscreen(msg: Record<string, any>): OffscreenResponse {
	if (msg.type !== "CRYPTO_DECRYPT_INDEX") return diskOffscreen(msg);
	return {
		ok: true,
		data: [
			{
				id: "login1",
				plaintext: JSON.stringify({
					type: "login",
					name: "Example",
					urls: ["https://example.com"],
					username: "alice",
					password: "pw1",
					archivedAt: 5000,
				}),
			},
		],
	};
}

describe("autofill query with no pushed index (rebuild from disk)", () => {
	// This path projects the decrypted entry itself instead of consuming core's
	// toAutofillIndex, so it carries the archived rule separately and can drift from it.
	it("leaves an archived login out of the rebuilt index", async () => {
		const bg = await loadBackground({
			sessionSeed: { [TEST_VEK_KEY]: "SEED" },
			offscreen: archivedOffscreen,
		});
		const { resp } = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		await bg.flush();

		expect(resp.data).toMatchObject({ locked: false, logins: [] });
	});

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

	it("never publishes a rebuild that completed after lock and active-vault replacement", async () => {
		let releaseOldDecrypt: ((response: OffscreenResponse) => void) | undefined;
		const bg = await loadBackground({
			sessionSeed: { [TEST_VEK_KEY]: "OLD" },
			offscreen: (message) => {
				if (message.type === "CRYPTO_DECRYPT_OUTER") {
					const old = message.vaultId === "v1";
					return {
						ok: true,
						data: JSON.stringify({
							entries: [
								{
									id: old ? "old-login" : "new-login",
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
				}
				if (message.type === "CRYPTO_DECRYPT_INDEX") {
					const response = {
						ok: true,
						data: [
							{
								id: message.vaultId === "v1" ? "old-login" : "new-login",
								plaintext: JSON.stringify({
									type: "login",
									name: message.vaultId === "v1" ? "Old vault" : "New vault",
									urls: ["https://example.com"],
									username: message.vaultId === "v1" ? "old" : "new",
									password: message.vaultId === "v1" ? "old-secret" : "new-secret",
								}),
							},
						],
					};
					if (message.vaultId !== "v1") return response;
					return new Promise((resolve) => {
						releaseOldDecrypt = resolve;
					});
				}
				return defaultOffscreen(message);
			},
		});

		const staleQuery = bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		await bg.flush();
		expect(releaseOldDecrypt).toBeTypeOf("function");

		await bg.send({ type: "CRYPTO_LOCK" });
		bg.state.session["vault.activeId"] = "v2";
		bg.fireStorageChanged({ "vault.activeId": { oldValue: "v1", newValue: "v2" } }, "session");
		await bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "NEW" } });
		releaseOldDecrypt?.({
			ok: true,
			data: [
				{
					id: "old-login",
					plaintext: JSON.stringify({
						type: "login",
						name: "Old vault",
						urls: ["https://example.com"],
						username: "old",
						password: "old-secret",
					}),
				},
			],
		});
		expect((await staleQuery).resp).toEqual({ ok: false, error: "unavailable" });

		const current = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		expect(current.resp.data).toMatchObject({
			locked: false,
			logins: [{ id: "new-login", name: "New vault", secondary: "new" }],
		});
		expect(current.resp.data.logins.map((entry: { id: string }) => entry.id)).not.toContain(
			"old-login",
		);
	});
});

describe("keyed best-effort index hydration", () => {
	const plaintext = (name: string) =>
		JSON.stringify({
			type: "login",
			name,
			urls: ["https://example.com"],
			username: name,
			password: "pw",
		});
	async function queryWith(results: unknown) {
		const bg = await loadBackground({
			sessionSeed: { [TEST_VEK_KEY]: "SEED" },
			offscreen: (message) => {
				if (message.type === "CRYPTO_DECRYPT_OUTER")
					return {
						ok: true,
						data: JSON.stringify({
							entries: ["a", "bad", "c"].map((id) => ({
								id,
								ciphertext: id,
								iv: "i",
								wrappedDek: "w",
								dekIv: "d",
								hlc: { wall: 1, counter: 0, node: "seed" },
							})),
							tombstones: [],
						}),
					};
				if (message.type === "CRYPTO_DECRYPT_INDEX") return { ok: true, data: results };
				return defaultOffscreen(message);
			},
		});
		const result = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("example.com", 4),
		);
		return { bg, resp: result.resp };
	}
	it("keeps valid entries with their ids even when replies are reordered and one fails", async () => {
		const { bg, resp } = await queryWith([
			{ id: "c", plaintext: plaintext("C") },
			{ id: "bad", plaintext: null },
			{ id: "a", plaintext: plaintext("A") },
		]);
		expect(resp.data.locked).toBe(false);
		expect(resp.data.logins).toHaveLength(2);
		expect(resp.data.logins).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "a", name: "A" }),
				expect.objectContaining({ id: "c", name: "C" }),
			]),
		);
		const calls = bg.state.offscreenCalls.filter((m) => m.type === "CRYPTO_DECRYPT_INDEX");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.payload.vekB64).toBe("SEED");
		expect(calls[0]?.payload.entries.map((e: { id: string }) => e.id)).toEqual(["a", "bad", "c"]);
	});
	it("skips malformed plaintext without discarding other entries", async () => {
		const { resp } = await queryWith([
			{ id: "a", plaintext: plaintext("A") },
			{ id: "bad", plaintext: "not JSON" },
			{ id: "c", plaintext: plaintext("C") },
		]);
		expect(resp.data.locked).toBe(false);
		expect(resp.data.logins).toHaveLength(2);
	});
	it.each(
		[
			[],
			[{ id: "a", plaintext: plaintext("A") }],
			["wrong", "shape", "reply"],
			[
				{ id: "a", plaintext: null },
				{ id: "a", plaintext: null },
				{ id: "c", plaintext: null },
			],
			[
				{ id: "a", plaintext: null },
				{ id: "bad", plaintext: null },
				{ id: "unknown", plaintext: null },
			],
		].map((results) => ({ results })),
	)("does not publish an incomplete or mismatched response ($results)", async ({ results }) => {
		const { resp } = await queryWith(results);
		expect(resp.data?.logins ?? []).toEqual([]);
	});
});
