import { describe, expect, it, vi } from "vitest";

// Regression guard for THE per-vault fix: in the offscreen, "load the vek then run the op" must be
// one synchronous section, so a second dispatch can't slip a different vault's vek into the shared
// wasm slot between them. We stub the wasm to record call order and fire two differently-keyed
// dispatches concurrently; if anyone ever puts an await between the load and the op, the loads
// cluster (load, load, op, op) and this fails. See docs/multiple-vaults.md "The atomicity rule".

const { order, stub } = vi.hoisted(() => {
	const order: string[] = [];
	let loaded = "";
	const stub = {
		unlock_with_vek: (vek: string) => {
			loaded = vek;
			order.push(`load:${vek}`);
		},
		encrypt_with_vek: (_plaintext: string) => {
			order.push(`op:${loaded}`);
			return { iv: "iv", ciphertext: "ct" };
		},
	};
	return { order, stub };
});

vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

import { handleHostMessage } from "./offscreen-core";

describe("offscreen crypto atomicity (the no-await rule)", () => {
	it("keeps load+op atomic when two differently-keyed dispatches interleave", async () => {
		// Repeat: a single pass could pass by luck of scheduling; a broken critical section trips
		// reliably across rounds.
		for (let round = 0; round < 25; round++) {
			order.length = 0;
			await Promise.all([
				handleHostMessage("CRYPTO_ENCRYPT_OUTER", { plaintext: "A", vekB64: "vekA" }),
				handleHostMessage("CRYPTO_ENCRYPT_OUTER", { plaintext: "B", vekB64: "vekB" }),
			]);
			// Every op must sit immediately after its OWN load, never after another op's load.
			for (let i = 0; i < order.length; i++) {
				const m = order[i];
				if (m?.startsWith("op:")) expect(order[i - 1]).toBe(`load:${m.slice(3)}`);
			}
			// Sanity: both ops actually ran.
			expect(order.filter((m) => m.startsWith("op:"))).toHaveLength(2);
		}
	});
});
