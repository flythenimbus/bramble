import { describe, expect, it } from "vitest";
import {
	buildSignalEvent,
	computeEventId,
	decryptSignal,
	deriveRoomId,
	encryptSignal,
	type NostrSigner,
	type NostrVerifier,
	serializeForId,
	signalFilter,
	verifyEvent,
} from "./nostr";

// A fake signer/verifier pair: the "signature" is just a tag over the id, so the
// codec's build/verify wiring is exercised without real schnorr (cargo covers that).
const signer: NostrSigner = {
	pubkeyHex: "ab".repeat(32),
	sign: (id) => Promise.resolve(`sig:${id}`),
};
const verifier: NostrVerifier = {
	verify: (_pk, id, sig) => Promise.resolve(sig === `sig:${id}`),
};

describe("room id", () => {
	it("is deterministic per group key and differs across keys", async () => {
		const k1 = new Uint8Array(32).fill(1);
		const k2 = new Uint8Array(32).fill(2);
		expect(await deriveRoomId(k1)).toBe(await deriveRoomId(k1));
		expect(await deriveRoomId(k1)).not.toBe(await deriveRoomId(k2));
		expect(await deriveRoomId(k1)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("signal payload crypto", () => {
	it("round-trips under the group key", async () => {
		const key = crypto.getRandomValues(new Uint8Array(32));
		const ct = await encryptSignal(key, "v=0\r\no=- 1 1 IN IP4 0.0.0.0");
		expect(await decryptSignal(key, ct)).toBe("v=0\r\no=- 1 1 IN IP4 0.0.0.0");
	});

	it("does not decrypt under the wrong key", async () => {
		const ct = await encryptSignal(new Uint8Array(32).fill(1), "secret sdp");
		await expect(decryptSignal(new Uint8Array(32).fill(2), ct)).rejects.toThrow();
	});
});

describe("event build / verify", () => {
	it("builds a signed ephemeral event tagged with the room", async () => {
		const ev = await buildSignalEvent(signer, "room123", "payload", 1_700_000_000);
		expect(ev.kind).toBe(20000);
		expect(ev.pubkey).toBe(signer.pubkeyHex);
		expect(ev.tags).toEqual([["d", "room123"]]);
		expect(ev.id).toBe(await computeEventId(ev));
		expect(ev.sig).toBe(`sig:${ev.id}`);
		expect(await verifyEvent(verifier, ev)).toBe(true);
	});

	it("rejects an event whose content was tampered (id mismatch)", async () => {
		const ev = await buildSignalEvent(signer, "room123", "payload", 1_700_000_000);
		expect(await verifyEvent(verifier, { ...ev, content: "tampered" })).toBe(false);
	});

	it("rejects a bad signature", async () => {
		const ev = await buildSignalEvent(signer, "room123", "payload", 1_700_000_000);
		expect(await verifyEvent(verifier, { ...ev, sig: "sig:wrong" })).toBe(false);
	});
});

describe("serialization / filter", () => {
	it("serializes per NIP-01 (array with leading 0)", () => {
		const s = serializeForId({
			pubkey: "pk",
			created_at: 5,
			kind: 20000,
			tags: [["d", "r"]],
			content: "c",
		});
		expect(s).toBe('[0,"pk",5,20000,[["d","r"]],"c"]');
	});

	it("builds a room subscription filter", () => {
		expect(signalFilter("room123")).toEqual({ kinds: [20000], "#d": ["room123"] });
	});
});
