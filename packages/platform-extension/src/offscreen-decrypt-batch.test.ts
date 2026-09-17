import { describe, expect, it, vi } from "vitest";

// CRYPTO_DECRYPT_BATCH decrypts every entry inside ONE load-the-vek section and
// returns plaintexts in order, so the popup opens a large vault with a single
// offscreen round-trip instead of one per entry.

const { loads, stub } = vi.hoisted(() => {
	const loads: string[] = [];
	const stub = {
		unlock_with_vek: (vek: string) => loads.push(vek),
		// Echo the ciphertext so the test can assert order and per-entry decryption.
		decrypt_entry: (ct: string, _iv: string, _wrappedDek: string, _dekIv: string) => {
			if (ct === "broken") throw new Error("cannot decrypt");
			return `pt:${ct}`;
		},
	};
	return { loads, stub };
});

vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

import { handleHostMessage } from "./offscreen-core";

const entry = (ct: string) => ({ ciphertext: ct, iv: "iv", wrappedDek: "wd", dekIv: "di" });

describe("offscreen CRYPTO_DECRYPT_BATCH", () => {
	it("decrypts every entry in order, loading the vek once", async () => {
		loads.length = 0;
		const res = await handleHostMessage("CRYPTO_DECRYPT_BATCH", {
			entries: [entry("a"), entry("b"), entry("c")],
			vekB64: "vek",
		});
		expect(res).toEqual({ ok: true, data: ["pt:a", "pt:b", "pt:c"] });
		// One round-trip == the vek is loaded exactly once for the whole batch.
		expect(loads).toEqual(["vek"]);
	});

	it("returns an empty array for an empty vault", async () => {
		loads.length = 0;
		const res = await handleHostMessage("CRYPTO_DECRYPT_BATCH", { entries: [], vekB64: "vek" });
		expect(res).toEqual({ ok: true, data: [] });
	});
});

describe("offscreen CRYPTO_DECRYPT_INDEX", () => {
	it("keeps ids and skips only the undecryptable entry in one VEK section", async () => {
		loads.length = 0;
		const res = await handleHostMessage("CRYPTO_DECRYPT_INDEX", {
			entries: [
				{ id: "a", ...entry("a") },
				{ id: "bad", ...entry("broken") },
				{ id: "c", ...entry("c") },
			],
			vekB64: "vek",
		});
		expect(res).toEqual({
			ok: true,
			data: [
				{ id: "a", plaintext: "pt:a" },
				{ id: "bad", plaintext: null },
				{ id: "c", plaintext: "pt:c" },
			],
		});
		expect(loads).toEqual(["vek"]);
	});
	it("leaves the existing crypto adapter batch strict", async () => {
		const res = await handleHostMessage("CRYPTO_DECRYPT_BATCH", {
			entries: [entry("a"), entry("broken")],
			vekB64: "vek",
		});
		expect(res.ok).toBe(false);
	});
	it("supports an empty index", async () => {
		expect(await handleHostMessage("CRYPTO_DECRYPT_INDEX", { entries: [], vekB64: "vek" })).toEqual(
			{ ok: true, data: [] },
		);
	});
});
