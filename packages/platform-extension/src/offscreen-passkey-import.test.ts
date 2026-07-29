import { describe, expect, it, vi } from "vitest";

const { calls, stub } = vi.hoisted(() => {
	const calls: string[] = [];
	const stub = {
		passkey_import_pkcs8: (pkcs8B64: string) => {
			calls.push(pkcs8B64);
			return { privateKey: "c2NhbGFy", publicKeyCose: "Y29zZQ==" };
		},
	};
	return { calls, stub };
});

vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

import { handleHostMessage } from "./offscreen-core";

describe("offscreen CRYPTO_PASSKEY_IMPORT_PKCS8", () => {
	it("validates and forwards the PKCS#8 value to the crypto adapter", async () => {
		calls.length = 0;
		const res = await handleHostMessage("CRYPTO_PASSKEY_IMPORT_PKCS8", {
			pkcs8B64: "cGtjczg=",
		});

		expect(res).toEqual({
			ok: true,
			data: { privateKey: "c2NhbGFy", publicKeyCose: "Y29zZQ==" },
		});
		expect(calls).toEqual(["cGtjczg="]);
	});

	it("rejects a malformed transport payload before calling crypto", async () => {
		calls.length = 0;
		const res = await handleHostMessage("CRYPTO_PASSKEY_IMPORT_PKCS8", {});

		expect(res.ok).toBe(false);
		expect(calls).toEqual([]);
	});
});
