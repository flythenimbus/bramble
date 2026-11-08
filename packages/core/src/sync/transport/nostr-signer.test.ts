import { describe, expect, it } from "vitest";
import { hexToBase64, hexToBytes } from "../../util/bytes";
import { sha256Hex } from "../../util/hash";
import { makeNostr, type NostrWasm } from "./nostr-signer";

const HOSTED = "wss://bramble-relay.flythenimbus.workers.dev";
const SELF_HOSTED = "wss://relay.example.com";
const ID = "ab".repeat(32);
const SIG = "cd".repeat(64);
const PUB = "ef".repeat(32);
const idB64 = hexToBase64(ID);
const hashedIdB64 = async () => hexToBase64(await sha256Hex(hexToBytes(ID)));

function fakeWasm(acceptedHashes: string[] = []) {
	const signed: string[] = [];
	const wasm: NostrWasm = {
		nostr_generate_key: () => ({ secretKey: "AA==", publicKey: "AA==" }),
		nostr_sign: (_secret, hash) => {
			signed.push(hash);
			return "AA==";
		},
		nostr_verify: (_pub, hash) => acceptedHashes.includes(hash),
	};
	return { wasm, signed };
}

describe("makeNostr signing", () => {
	it("signs the event id itself on a self-hosted relay", async () => {
		const { wasm, signed } = fakeWasm();
		await (await makeNostr(wasm, SELF_HOSTED)).signer.sign(ID);
		expect(signed).toEqual([idB64]);
	});

	it.each([HOSTED, `${HOSTED}/`])("signs the hashed id on the hosted relay (%s)", async (url) => {
		const { wasm, signed } = fakeWasm();
		await (await makeNostr(wasm, url)).signer.sign(ID);
		expect(signed).toEqual([await hashedIdB64()]);
	});

	it.each(["wss://bramble-relay.flythenimbus.workers.dev.example.com", "not a url"])(
		"signs the event id itself for %s",
		async (url) => {
			const { wasm, signed } = fakeWasm();
			await (await makeNostr(wasm, url)).signer.sign(ID);
			expect(signed).toEqual([idB64]);
		},
	);
});

describe("makeNostr verification", () => {
	it("accepts a signature over the event id", async () => {
		const { verifier } = await makeNostr(fakeWasm([idB64]).wasm, HOSTED);
		expect(await verifier.verify(PUB, ID, SIG)).toBe(true);
	});

	it("accepts a released client's signature over the hashed id, on any relay", async () => {
		const { verifier } = await makeNostr(fakeWasm([await hashedIdB64()]).wasm, SELF_HOSTED);
		expect(await verifier.verify(PUB, ID, SIG)).toBe(true);
	});

	it("rejects a signature over neither", async () => {
		const { verifier } = await makeNostr(fakeWasm([]).wasm, SELF_HOSTED);
		expect(await verifier.verify(PUB, ID, SIG)).toBe(false);
	});
});
