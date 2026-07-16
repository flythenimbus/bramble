import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import { decodeVaultBlob, findRecoverySlots } from "../../vault-format";
import { encodeEnrollmentBundle, type WireRecoverySlot } from "../enrollment";
import { emptyEntriesPayload } from "../entries-payload";
import { emptyRoster, type RosterEntry } from "../roster";
import { type Channel, makeChannel } from "./channel";
import { type EnrollOptions, type EnrollWasm, receiveBundle, sendBundle } from "./enroll-host";
import type { Session } from "./handshake";
import type { PeerSession } from "./mesh";
import { CHUNK_BYTES } from "./secure-channel";

// Covers the provable same-password enforcement added to enrollment: the inviter
// ships its password-slot verifier in the bundle, and the joiner proves its typed
// password matches before adopting the VEK. The mesh/handshake plumbing is covered
// in peer-session.test + the Rust handshake tests; here the wasm is a stub with an
// identity Noise transport so the JSON bundle round-trips through the channel.

const b64 = (len: number) => bytesToBase64(new Uint8Array(len));

// The inviter's password-slot fields, base64 (lengths are irrelevant to the stub).
const CHECK = { saltB64: b64(16), slotIdB64: b64(16), verifierB64: b64(32) };

const sess: Session = { sessionId: 1, remoteStatic: "joinerpub" };

const ownEntry: RosterEntry = {
	id: "joiner",
	publicKey: "joinerpub",
	label: "Joiner",
	addedAt: 0,
	hlc: { wall: 0, counter: 0, node: "joiner" },
};

// Fixed, correctly-sized crypto outputs so buildVaultBytes -> encodeVaultBlob (which
// validates field lengths via zod) succeeds on the happy paths.
function mockWasm(overrides: Partial<EnrollWasm> = {}): EnrollWasm {
	return {
		nostr_generate_key: () => ({ secretKey: "AA==", publicKey: "AA==" }),
		nostr_sign: () => "AA==",
		nostr_verify: () => true,
		handshake_enroll_initiator: () => ({ sessionId: 1, message: "" }),
		handshake_enroll_responder: () => 1,
		handshake_encrypt: (_sid: number, pt: string) => pt, // identity transport
		handshake_decrypt: (_sid: number, ct: string) => ct,
		handshake_read: () => ({ done: true }),
		handshake_remote_static: () => "",
		export_vek: () => b64(32),
		unlock_with_vek: vi.fn(),
		generate_salt: () => b64(16),
		generate_slot_id: () => b64(16),
		wrap_vek_password: () => ({ verifier: b64(32), wrapIv: b64(12), wrappedVek: b64(48) }),
		wrap_vek_webauthn: () => ({ verifier: b64(32), wrapIv: b64(12), wrappedVek: b64(48) }),
		encrypt_with_vek: () => ({ iv: b64(12), ciphertext: b64(16) }),
		verify_password_slot: vi.fn(() => true),
		...overrides,
	} as EnrollWasm;
}

const bundleJson = (
	over: { primaryPasswordCheck?: typeof CHECK; recoverySlots?: WireRecoverySlot[] } = {},
) =>
	encodeEnrollmentBundle({
		vek: b64(32),
		roster: emptyRoster(),
		entries: emptyEntriesPayload(),
		...over,
	});

// A joiner peer whose channel already holds the inviter's bundle to receive.
function joinerPeer(json: string, close: () => void = () => {}): PeerSession {
	const { channel, push } = makeChannel(() => {}); // joiner's ack send is ignored
	push(json);
	return { remotePubkey: "inviter", initiator: false, channel, close };
}

function joinerOpts(wasm: EnrollWasm, over: Partial<EnrollOptions> = {}): EnrollOptions {
	return {
		relayUrl: "wss://r",
		groupKeyB64: b64(32),
		psk: b64(32),
		devicePrivB64: b64(32),
		wasm,
		report: () => {},
		ownEntry,
		password: "typed-password",
		...over,
	};
}

describe("receiveBundle — provable password match", () => {
	it("aborts (no VEK adopted, no vault built) when the typed password doesn't match", async () => {
		const verify = vi.fn(() => false);
		const unlock = vi.fn();
		const onJoined = vi.fn();
		const onJoinError = vi.fn();
		const close = vi.fn();
		const wasm = mockWasm({ verify_password_slot: verify, unlock_with_vek: unlock });

		await receiveBundle(
			joinerOpts(wasm, { onJoined, onJoinError }),
			joinerPeer(bundleJson({ primaryPasswordCheck: CHECK }), close),
			sess,
		);

		expect(verify).toHaveBeenCalledTimes(1);
		expect(onJoinError).toHaveBeenCalledOnce();
		expect(String(onJoinError.mock.calls[0]?.[0])).toMatch(/match/i);
		expect(close).toHaveBeenCalledOnce();
		expect(unlock).not.toHaveBeenCalled(); // never adopted the group VEK
		expect(onJoined).not.toHaveBeenCalled(); // no vault rebuilt
	});

	it("verifies against the inviter's fields and proceeds when the password matches", async () => {
		const verify = vi.fn(() => true);
		const unlock = vi.fn();
		const onJoined = vi.fn();
		const onJoinError = vi.fn();
		const wasm = mockWasm({ verify_password_slot: verify, unlock_with_vek: unlock });

		await receiveBundle(
			joinerOpts(wasm, { password: "correct", onJoined, onJoinError }),
			joinerPeer(bundleJson({ primaryPasswordCheck: CHECK })),
			sess,
		);

		expect(verify).toHaveBeenCalledWith(
			"correct",
			CHECK.saltB64,
			CHECK.slotIdB64,
			CHECK.verifierB64,
			expect.any(Uint8Array), // the magic-version prefix
		);
		expect(unlock).toHaveBeenCalledOnce();
		expect(onJoined).toHaveBeenCalledOnce();
		expect(onJoinError).not.toHaveBeenCalled();
	});

	it("copies the inviter's forwarded recovery slot into the rebuilt vault (shared recovery code)", async () => {
		const onJoined = vi.fn();
		const wasm = mockWasm();
		// A correctly-sized serialized recovery slot (slotId 16, salt 16, verifier 32, iv 12, vek 48).
		const recoverySlots: WireRecoverySlot[] = [
			{
				saltB64: b64(16),
				slotIdB64: b64(16),
				verifierB64: b64(32),
				wrapIvB64: b64(12),
				wrappedVekB64: b64(48),
			},
		];
		await receiveBundle(
			joinerOpts(wasm, { onJoined }),
			joinerPeer(bundleJson({ recoverySlots })),
			sess,
		);
		expect(onJoined).toHaveBeenCalledOnce();
		const blobB64 = onJoined.mock.calls[0]?.[0].vaultBlobB64 as string;
		expect(findRecoverySlots(decodeVaultBlob(base64ToBytes(blobB64)))).toHaveLength(1);
	});

	it("falls back without enforcement when the bundle carries no password check", async () => {
		const verify = vi.fn(() => false);
		const onJoined = vi.fn();
		const wasm = mockWasm({ verify_password_slot: verify });

		// No primaryPasswordCheck: a security-key-only inviter or an older build.
		await receiveBundle(joinerOpts(wasm, { onJoined }), joinerPeer(bundleJson()), sess);

		expect(verify).not.toHaveBeenCalled();
		expect(onJoined).toHaveBeenCalledOnce();
	});

	it("skips the password check when this device joins with a security key", async () => {
		const verify = vi.fn(() => false);
		const onJoined = vi.fn();
		const wasm = mockWasm({ verify_password_slot: verify });

		await receiveBundle(
			joinerOpts(wasm, {
				password: undefined,
				webauthn: { hmacSecretB64: b64(32), credentialIdB64: b64(20), saltB64: b64(32) },
				onJoined,
			}),
			joinerPeer(bundleJson({ primaryPasswordCheck: CHECK })),
			sess,
		);

		expect(verify).not.toHaveBeenCalled();
		expect(onJoined).toHaveBeenCalledOnce();
	});
});

describe("sendBundle — inviter ships its password verifier", () => {
	const inviterOpts = (over: Partial<EnrollOptions> = {}): EnrollOptions => ({
		relayUrl: "wss://r",
		groupKeyB64: b64(32),
		psk: b64(32),
		devicePrivB64: b64(32),
		wasm: mockWasm(),
		report: () => {},
		roster: emptyRoster(),
		entries: emptyEntriesPayload(),
		...over,
	});

	// Capture the first send (the bundle); recv never resolves, so the roster-entry
	// ack wait is skipped and we assert only the outgoing bundle's contents.
	async function captureBundle(opts: EnrollOptions): Promise<string> {
		const sent: string[] = [];
		const channel: Channel = {
			send: (d) => void sent.push(d),
			recv: () => new Promise<string>(() => {}),
		};
		void sendBundle(opts, channel, sess);
		await new Promise((r) => setTimeout(r, 0));
		const out = sent[0];
		if (out === undefined) throw new Error("bundle was not sent");
		return out;
	}

	it("includes primaryPasswordCheck when passwordCheck is provided", async () => {
		const out = await captureBundle(inviterOpts({ passwordCheck: CHECK }));
		expect(JSON.parse(out).primaryPasswordCheck).toEqual(CHECK);
	});

	it("omits primaryPasswordCheck when this device has no password slot", async () => {
		const out = await captureBundle(inviterOpts()); // no passwordCheck
		expect(JSON.parse(out).primaryPasswordCheck).toBeUndefined();
	});
});

describe("large vault: bundle spans multiple Noise frames", () => {
	// A vault big enough that the bundle exceeds one 64 KiB Noise frame — the case that
	// used to throw "message too large for one Noise frame". Cheap to inflate via tombstones.
	const tombstones = Array.from({ length: 400 }, (_, i) => ({
		id: `deleted-${i}-${"x".repeat(80)}`,
		hlc: { wall: i, counter: 0, node: "n" },
	}));
	const bigEntries = { entries: [], tombstones };

	it("chunks the bundle on send and the joiner reassembles + rebuilds from it", async () => {
		// Sanity: this bundle really does exceed one frame, so sendBundle must chunk it.
		expect(bundleJson().length).toBeLessThan(CHUNK_BYTES);
		const bigBundle = encodeEnrollmentBundle({
			vek: b64(32),
			roster: emptyRoster(),
			entries: bigEntries,
		});
		expect(bigBundle.length).toBeGreaterThan(CHUNK_BYTES);

		// Inviter: capture every frame sendBundle emits (the ack wait is parked).
		const frames: string[] = [];
		const inviterChannel: Channel = {
			send: (d) => void frames.push(d),
			recv: () => new Promise<string>(() => {}),
		};
		void sendBundle(
			{
				relayUrl: "wss://r",
				groupKeyB64: b64(32),
				psk: b64(32),
				devicePrivB64: b64(32),
				wasm: mockWasm(),
				report: () => {},
				roster: emptyRoster(),
				entries: bigEntries,
			},
			inviterChannel,
			sess,
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(frames.length).toBeGreaterThan(1); // multi-frame, not one oversized send
		expect(frames.every((f) => f.startsWith("{"))).toBe(true); // JSON continuation frames

		// Joiner: feed those frames in; receiveBundle must reassemble, decode, and rebuild.
		const onJoined = vi.fn();
		const onJoinError = vi.fn();
		const { channel, push } = makeChannel(() => {}); // ack send ignored
		for (const f of frames) push(f);
		await receiveBundle(
			joinerOpts(mockWasm(), { onJoined, onJoinError }),
			{ remotePubkey: "inviter", initiator: false, channel, close: () => {} },
			sess,
		);
		expect(onJoinError).not.toHaveBeenCalled();
		expect(onJoined).toHaveBeenCalledOnce();
	});
});
