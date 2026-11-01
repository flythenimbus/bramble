import { describe, expect, it, vi } from "vitest";

const { calls, stub } = vi.hoisted(() => {
	const calls: unknown[][] = [];
	const stub = {
		passkey_prf_eval: (...args: unknown[]) => {
			calls.push(args);
			return { first: "b3V0MQ==", second: "b3V0Mg==" };
		},
	};
	return { calls, stub };
});

vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

import { handleHostMessage } from "./offscreen-core";

describe("offscreen CRYPTO_PASSKEY_PRF", () => {
	it("validates and forwards the secret and both inputs to the crypto adapter", async () => {
		calls.length = 0;
		const res = await handleHostMessage("CRYPTO_PASSKEY_PRF", {
			secretB64: "c2Vj",
			firstB64: "Zmlyc3Q=",
			secondB64: "c2Vjb25k",
		});

		expect(res).toEqual({ ok: true, data: { first: "b3V0MQ==", second: "b3V0Mg==" } });
		expect(calls).toEqual([["c2Vj", "Zmlyc3Q=", "c2Vjb25k"]]);
	});

	it("rejects a malformed transport payload before calling crypto", async () => {
		calls.length = 0;
		const res = await handleHostMessage("CRYPTO_PASSKEY_PRF", {});

		expect(res.ok).toBe(false);
		expect(calls).toEqual([]);
	});
});
