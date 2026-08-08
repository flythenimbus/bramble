import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import { decodeVaultBlob, findRecoverySlots } from "../../vault-format";
import { encodeEnrollmentBundle, INVITE_TTL_MS, type WireRecoverySlot } from "../enrollment";
import { emptyEntriesPayload } from "../entries-payload";
import { pairingSas } from "../pairing-sas";
import { emptyRoster, type RosterEntry } from "../roster";
import { type Channel, makeChannel } from "./channel";
import {
	ENROLL_REJECTED,
	type EnrollOptions,
	type EnrollWasm,
	makeEnrollHandler,
	RECEIPT,
	receiveBundle,
	sendBundle,
	startEnroll,
} from "./enroll-host";
import type { Session } from "./handshake";
import type { PeerSession } from "./mesh";
import { CHUNK_BYTES } from "./secure-channel";

// Covers the provable same-password enforcement added to enrollment: the inviter
// ships its password-slot verifier in the bundle, and the joiner proves its typed
// password matches before adopting the VEK. The mesh/handshake plumbing is covered
// in peer-session.test + the Rust handshake tests; here the wasm is a stub with an
// identity Noise transport so the JSON bundle round-trips through the channel.

const b64 = (len: number) => bytesToBase64(new Uint8Array(len));

/**
 * Turn the event loop under fake timers until `cond` holds, without advancing the clock. For
 * waiting on a promise chain that includes real WebCrypto, where a fixed number of ticks is a
 * race rather than a barrier.
 *
 * Bounded in real time rather than iterations. The previous bound of 200 spins buys about 5ms of
 * real time, which is enough only because on an idle machine the crypto has already resolved
 * before the first check. Under a parallel `pnpm -r run test` it needs longer, the spins are
 * exhausted almost immediately, and the wait fails having barely waited.
 *
 * `vi.getRealSystemTime()` is the clock to use here: the fake timers freeze `Date.now()`,
 * `process.hrtime()` and `performance.now()` alike, so a deadline built on any of those never
 * arrives and this spins until the runner kills the test.
 */
// Under vitest's 5s default testTimeout on purpose, so a genuine hang surfaces as the labelled
// error below rather than an unlabelled "Test timed out" from the runner.
const FLUSH_TIMEOUT_MS = 3_000;

async function flushUntil(cond: () => boolean, label: string): Promise<void> {
	const deadline = vi.getRealSystemTime() + FLUSH_TIMEOUT_MS;
	while (vi.getRealSystemTime() < deadline) {
		if (cond()) return;
		await vi.advanceTimersByTimeAsync(0);
	}
	throw new Error(`flushUntil: ${label} never happened`);
}

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
		// Adopted the group VEK. wasmSlotCrypto now re-loads it before each wrap/encrypt (the
		// atomicity fix), so unlock_with_vek fires several times, not once.
		expect(unlock).toHaveBeenCalled();
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

	it("re-loads the group vek immediately before every wrap/encrypt (joiner atomicity)", async () => {
		const order: string[] = [];
		const wasm = mockWasm({
			unlock_with_vek: vi.fn(() => {
				order.push("unlock");
			}),
			wrap_vek_password: vi.fn(() => {
				order.push("wrap");
				return { verifier: b64(32), wrapIv: b64(12), wrappedVek: b64(48) };
			}),
			encrypt_with_vek: vi.fn(() => {
				order.push("encrypt");
				return { iv: b64(12), ciphertext: b64(16) };
			}),
		});
		await receiveBundle(joinerOpts(wasm), joinerPeer(bundleJson()), sess);
		// Each seal is immediately preceded by a load, so nothing can slip a different vault's vek
		// into the shared slot between load and op (the no-await critical section on the extension).
		expect(order).toContain("wrap");
		for (let i = 0; i < order.length; i++) {
			if (order[i] === "wrap" || order[i] === "encrypt") expect(order[i - 1]).toBe("unlock");
		}
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
		// Inviting requires an explicitly captured key; only the refusal test omits it.
		vekB64: b64(32),
		...over,
	});

	// Capture the first send (the bundle); recv never resolves, so the roster-entry ack wait is
	// skipped and we assert only the outgoing bundle's contents. That wait is now bounded, so the
	// parked call eventually rejects with a timeout — swallowed here, since it isn't what's under test.
	async function captureBundle(opts: EnrollOptions): Promise<string> {
		const sent: string[] = [];
		const channel: Channel = {
			send: (d) => void sent.push(d),
			recv: () => new Promise<string>(() => {}),
		};
		void sendBundle(opts, channel, sess).catch(() => {});
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

	it("ships the injected vekB64, not export_vek (scratch slot could be the wrong vault)", async () => {
		const wasm = mockWasm({ export_vek: () => b64(1) }); // a wrong-length scratch export
		const out = await captureBundle(inviterOpts({ wasm, vekB64: b64(32) }));
		expect(JSON.parse(out).vek).toBe(b64(32));
	});

	// Issue #27: the ambient export_vek() fallback read whichever key was loaded at SEND time. An
	// invite outliving a vault switch would ship the wrong vault's key, and the joiner would rebuild
	// a vault nothing could open. Callers now capture the key when the invite starts; refusing to
	// send without one costs a retry, sending the wrong one costs the vault.
	it("refuses to send a bundle without an explicit vekB64, rather than exporting the ambient key", async () => {
		const wasm = mockWasm({ export_vek: () => b64(32) });
		const sent: string[] = [];
		const channel: Channel = {
			send: (d) => void sent.push(d),
			recv: () => new Promise<string>(() => {}),
		};

		// Asserted against sendBundle directly: captureBundle turns any failure into "bundle was
		// not sent", which would pass even if it broke for an unrelated reason.
		await expect(
			sendBundle(inviterOpts({ wasm, vekB64: undefined }), channel, sess),
		).rejects.toThrow(/without an explicit VEK/i);
		expect(sent).toEqual([]);
	});
});

// The invite lifecycle (GHSA-x4f5-4wq4-c6c8). The pairing code is a bearer credential: whoever
// completes the XXpsk3 handshake is handed the vault, so what limits the damage is that the
// invite is single-use, burns on failure, and cannot be held open. Driven through the exported
// handler factory, which is where the `consumed` closure lives.
describe("invite lifecycle — single use + bounded waits", () => {
	// A peer whose channel already holds the one inbound frame the handshake pump needs.
	function invitePeer(name: string) {
		const sent: string[] = [];
		const { channel, push } = makeChannel((d) => void sent.push(d));
		push("handshake"); // completes runResponder's pump (mock handshake_read returns done)
		const peer: PeerSession = {
			remotePubkey: name,
			initiator: false,
			channel,
			close: vi.fn(),
		};
		return { peer, sent, push };
	}

	// remoteStatic must match the acking entry's publicKey, or sendBundle rejects the entry.
	const inviteWasm = (over: Partial<EnrollWasm> = {}) =>
		mockWasm({ handshake_remote_static: () => "joinerpub", ...over });

	const hostOpts = (over: Partial<EnrollOptions> = {}): EnrollOptions => ({
		relayUrl: "wss://r",
		groupKeyB64: b64(32),
		psk: b64(32),
		devicePrivB64: b64(32),
		devicePubB64: b64(16),
		wasm: inviteWasm(),
		report: () => {},
		roster: emptyRoster(),
		entries: emptyEntriesPayload(),
		vekB64: b64(32),
		approve: async () => true,
		...over,
	});

	it("serves the first peer and refuses a second one racing the same invite", async () => {
		const stop = vi.fn();
		const onEnrolled = vi.fn();
		const handle = makeEnrollHandler("inviter", hostOpts({ onEnrolled }), stop);
		const first = invitePeer("aaaaaaaa");
		const second = invitePeer("bbbbbbbb");

		// Both start before either finishes: the race the pairing code makes possible.
		const a = handle(first.peer);
		const b = handle(second.peer);
		first.push(JSON.stringify(ownEntry)); // the claimer introduces itself
		first.push(RECEIPT); // ...and confirms receipt, releasing the transport
		second.push(JSON.stringify(ownEntry)); // ...and so does the loser, to no effect
		await Promise.all([a, b]);

		expect(first.sent.length).toBeGreaterThan(0); // the bundle went to the claimer
		expect(JSON.parse(first.sent[0] ?? "{}").vek).toBe(b64(32));
		expect(second.sent).toEqual([]); // ...and nothing at all to the second peer
		expect(second.peer.close).toHaveBeenCalled();
		expect(onEnrolled).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalled(); // invite over
	});

	it("claims the invite BEFORE sending, so a peer that fails mid-transfer still burns it", async () => {
		const stop = vi.fn();
		// vekB64 omitted: sendBundle refuses after the claim, i.e. the failure lands downstream
		// of the check-and-set. The invite must NOT re-arm for the next peer.
		const handle = makeEnrollHandler("inviter", hostOpts({ vekB64: undefined }), stop);
		const first = invitePeer("aaaaaaaa");
		const second = invitePeer("bbbbbbbb");
		first.push(JSON.stringify(ownEntry));

		await expect(handle(first.peer)).rejects.toThrow(/without an explicit VEK/i);
		await handle(second.peer);

		expect(first.sent).toEqual([]);
		expect(second.sent).toEqual([]); // burned, not re-armed
		expect(second.peer.close).toHaveBeenCalled();
		expect(stop).toHaveBeenCalled(); // and the failure path still ends the session
	});

	it("does not let a peer that goes silent hold the invite open", async () => {
		vi.useFakeTimers();
		try {
			const stop = vi.fn();
			const handle = makeEnrollHandler("inviter", hostOpts(), stop);
			const peer = invitePeer("aaaaaaaa");
			// Handshake completes, then the peer never introduces itself. This is the wait that
			// used to sit upstream of stop(), making the invite outlive the exchange.
			const done = handle(peer.peer);
			await vi.advanceTimersByTimeAsync(60_000);
			await done;
			expect(peer.sent).toEqual([]);
			expect(stop).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends nothing to a joiner that never introduces itself (no legacy fallback)", async () => {
		vi.useFakeTimers();
		try {
			const approve = vi.fn(async () => true);
			const handle = makeEnrollHandler("inviter", hostOpts({ approve }), vi.fn());
			const peer = invitePeer("aaaaaaaa"); // completes the handshake, then says nothing
			const done = handle(peer.peer);
			await vi.advanceTimersByTimeAsync(60_000);
			await done;
			// An un-updated joiner lands here. Falling back to the old "send first" order would
			// hand the vault to anyone who simply stays quiet, so there is no fallback.
			expect(peer.sent).toEqual([]);
			expect(approve).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// Regression: an un-updated joiner killed the invite and the UI said nothing, when "update the
	// other device" is the one thing only the user can act on.
	it("reports an invite-killing failure to the user, with something they can act on", async () => {
		vi.useFakeTimers();
		try {
			const onEnrollFailed = vi.fn();
			const handle = makeEnrollHandler("inviter", hostOpts({ onEnrollFailed }), vi.fn());
			const peer = invitePeer("aaaaaaaa"); // completes the handshake, then never introduces itself
			const done = handle(peer.peer);
			await vi.advanceTimersByTimeAsync(60_000);
			await done;

			expect(onEnrollFailed).toHaveBeenCalledOnce();
			expect(String(onEnrollFailed.mock.calls[0]?.[0])).toMatch(/older version|update/i);
		} finally {
			vi.useRealTimers();
		}
	});

	// Issue #37: the inviter dropped a peer whose handshake stalled and said nothing, so the user
	// watched a QR that would never complete until it expired three minutes later. Staying live and
	// staying silent are separate things; only the first was intended.
	it("reports a stalled handshake without spending the invite", async () => {
		vi.useFakeTimers();
		try {
			const onEnrollAttemptFailed = vi.fn();
			const onEnrollFailed = vi.fn();
			const stop = vi.fn();
			const handle = makeEnrollHandler(
				"inviter",
				hostOpts({ onEnrollAttemptFailed, onEnrollFailed }),
				stop,
			);
			// Connects, then never finishes the handshake.
			const { channel } = makeChannel(() => {});
			const done = handle({ remotePubkey: "zzzzzzzz", initiator: false, channel, close: vi.fn() });
			await vi.advanceTimersByTimeAsync(60_000);
			await done;

			expect(onEnrollAttemptFailed).toHaveBeenCalledOnce();
			expect(String(onEnrollAttemptFailed.mock.calls[0]?.[0])).toMatch(/still works|try again/i);
			// Not the fatal one, and the session stays up: the real device may still be coming, and
			// a stranger in the room must not be able to kill the invite by connecting badly.
			expect(onEnrollFailed).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a joiner whose entry claims a key it did not prove, before sending", async () => {
		const approve = vi.fn(async () => true);
		const onEnrolled = vi.fn();
		const handle = makeEnrollHandler("inviter", hostOpts({ approve, onEnrolled }), vi.fn());
		const peer = invitePeer("aaaaaaaa");
		// A key the peer doesn't hold (a third party's, say), which the handshake disproves.
		peer.push(JSON.stringify({ ...ownEntry, publicKey: "someone-elses-key" }));

		await handle(peer.peer);

		expect(peer.sent).toEqual([]); // caught BEFORE the bundle, not after it
		expect(approve).not.toHaveBeenCalled(); // and the user is never asked about a bogus peer
		expect(onEnrolled).not.toHaveBeenCalled();
	});

	it("shows the user the SAS and the joiner's label, and sends only once approved", async () => {
		const approve = vi.fn(async () => true);
		const handle = makeEnrollHandler("inviter", hostOpts({ approve }), vi.fn());
		const peer = invitePeer("aaaaaaaa");
		peer.push(JSON.stringify(ownEntry));
		peer.push(RECEIPT);

		await handle(peer.peer);

		expect(approve).toHaveBeenCalledOnce();
		const [sas, label] = approve.mock.calls[0] as unknown as [string, string];
		expect(sas).toMatch(/^\d{4} \d{4} \d{4}$/);
		expect(label).toBe(ownEntry.label);
		// Both sides must derive the same value: the inviter from (own key, proved joiner key).
		expect(sas).toBe(await pairingSas(b64(32), b64(16), "joinerpub"));
		expect(peer.sent.length).toBeGreaterThan(0);
	});

	it("sends nothing and burns the invite when the user rejects", async () => {
		const stop = vi.fn();
		const onEnrolled = vi.fn();
		const handle = makeEnrollHandler(
			"inviter",
			hostOpts({ approve: async () => false, onEnrolled }),
			stop,
		);
		const first = invitePeer("aaaaaaaa");
		const second = invitePeer("bbbbbbbb");
		first.push(JSON.stringify(ownEntry));
		first.push(RECEIPT); // acks the rejection notice, so the inviter doesn't wait it out
		second.push(JSON.stringify(ownEntry));

		await handle(first.peer);
		await handle(second.peer);

		// Only the rejection notice, never a bundle.
		expect(first.sent).toEqual([ENROLL_REJECTED]);
		expect(onEnrolled).not.toHaveBeenCalled();
		// A rejection means the code reached someone it shouldn't have, so it must not re-arm:
		// the attacker doesn't get a second attempt just because the first was refused.
		expect(second.sent).toEqual([]);
		expect(stop).toHaveBeenCalled();
	});

	it("refuses to invite at all without an approval gate or this device's key", async () => {
		// Fail closed. An "approved by default" fallback for a host that forgot to wire the
		// callback would silently restore exactly the behaviour this whole change removes.
		const noGate = makeEnrollHandler("inviter", hostOpts({ approve: undefined }), vi.fn());
		const a = invitePeer("aaaaaaaa");
		a.push(JSON.stringify(ownEntry));
		await expect(noGate(a.peer)).rejects.toThrow(/approval gate/i);
		expect(a.sent).toEqual([]);

		const noKey = makeEnrollHandler("inviter", hostOpts({ devicePubB64: undefined }), vi.fn());
		const b = invitePeer("bbbbbbbb");
		b.push(JSON.stringify(ownEntry));
		await expect(noKey(b.peer)).rejects.toThrow(/this device's key/i);
		expect(b.sent).toEqual([]);
	});

	// Regression: sendSecure resolving means "handed to the channel", not "sent", so stop() in the
	// handler's finally dropped the tail of a multi-frame bundle. Only bites past ~30 entries.
	it("does not stop the session until the joiner confirms it has the bundle", async () => {
		const stop = vi.fn();
		const handle = makeEnrollHandler("inviter", hostOpts(), stop);
		const peer = invitePeer("aaaaaaaa");
		peer.push(JSON.stringify(ownEntry));

		const done = handle(peer.peer);
		// Poll rather than tick a fixed number of times: pairingSas does real WebCrypto between the
		// introduction and the send, so "one macrotask" is not a barrier (flaked ~1 run in 5).
		await expect.poll(() => peer.sent.length).toBeGreaterThan(0);

		// The bundle is handed to the channel, and the transport is STILL up: nothing has
		// acknowledged it yet, and the receipt below is the only thing that releases it.
		expect(stop).not.toHaveBeenCalled();

		peer.push(RECEIPT);
		await done;
		expect(stop).toHaveBeenCalled();
	});

	it("still stops (bounded) if the joiner never confirms, so the invite can't hang", async () => {
		vi.useFakeTimers();
		try {
			const stop = vi.fn();
			const handle = makeEnrollHandler("inviter", hostOpts(), stop);
			const peer = invitePeer("aaaaaaaa");
			peer.push(JSON.stringify(ownEntry));

			const done = handle(peer.peer);
			// Settle the chain first: the ack timer doesn't exist until the bundle has been sent,
			// and advancing before then would skip past a window nothing is waiting in yet. A single
			// tick isn't enough — pairingSas does real WebCrypto on the way, which needs event-loop
			// turns, so under load one flush lands short (flaked only in the full suite, never alone).
			await flushUntil(() => peer.sent.length > 0, "bundle sent");
			await vi.advanceTimersByTimeAsync(120_000);
			await done;
			// Waiting for the flush must not reintroduce the unbounded await it replaced.
			expect(stop).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// Regression: expiry has to reach whoever holds the prompt. The UI countdown isn't reliable for
	// that (a popup closes on focus loss), so the inviter offered Approve/Reject for a dead session.
	it("fires onInviteExpired before stopping, so a parked prompt can be refused", async () => {
		vi.useFakeTimers();
		try {
			const order: string[] = [];
			// A fake mesh: this test is about the invite timer, not the transport.
			const meshStop = vi.fn(() => void order.push("stopped"));
			const session = await startEnroll(
				"inviter",
				hostOpts({
					onInviteExpired: () => void order.push("expired"),
					join: async () => ({ stop: meshStop }),
					fetchIce: async () => [],
				}),
			);
			expect(session).toBeTruthy();

			await vi.advanceTimersByTimeAsync(INVITE_TTL_MS + 1_000);

			// Ordering is the point: after stop() there is no transport left for an approval to
			// use, so the notice has to come first.
			expect(order).toEqual(["expired", "stopped"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("abandons a peer that never completes the handshake, leaving the invite live", async () => {
		vi.useFakeTimers();
		try {
			const stop = vi.fn();
			const handle = makeEnrollHandler("inviter", hostOpts(), stop);
			// No inbound frame at all: the pump's recv() never resolves.
			const { channel } = makeChannel(() => {});
			const dead: PeerSession = {
				remotePubkey: "cccccccc",
				initiator: false,
				channel,
				close: vi.fn(),
			};
			const done = handle(dead);
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(done).resolves.toBeUndefined();
			expect(dead.close).toHaveBeenCalled();
			// The invite was never claimed, so the real device can still arrive in the window.
			expect(stop).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

// The joiner pins the inviter's static key from the pairing code. Anyone else in the room is a
// stranger — and dropping only that peer (not the session) is what stops a code holder from
// killing every join attempt by presenting a wrong key.
describe("joiner — inviter pin", () => {
	const joinPeer = () => {
		const { channel, push } = makeChannel(() => {});
		push("handshake");
		return { peer: { remotePubkey: "x", initiator: true, channel, close: vi.fn() }, push };
	};

	it("ignores a peer that is not the pinned inviter without stopping the session", async () => {
		const stop = vi.fn();
		const onJoined = vi.fn();
		const wasm = mockWasm({ handshake_remote_static: () => "impostorpub" });
		const handle = makeEnrollHandler(
			"joiner",
			joinerOpts(wasm, { inviterPub: "inviterpub", onJoined }),
			stop,
		);
		const { peer } = joinPeer();

		await handle(peer);

		expect(peer.close).toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled(); // the real inviter may still be out there
		expect(onJoined).not.toHaveBeenCalled();
	});

	it("refuses to join at all when no inviter key was passed to pin against", async () => {
		const wasm = mockWasm({ handshake_remote_static: () => "whatever" });
		const handle = makeEnrollHandler(
			"joiner",
			joinerOpts(wasm, { inviterPub: undefined }),
			vi.fn(),
		);
		const { peer } = joinPeer();
		// Previously `opts.inviterPub && ...` silently skipped the MITM check for such a caller.
		await expect(handle(peer)).rejects.toThrow(/inviter key/i);
	});

	// Regression: this wait spans the inviter's prompt, so it is human time. On the 30s frame budget
	// a user who actually compared the digits timed out their own join.
	it("waits out a slow approval instead of timing out while the user compares digits", async () => {
		vi.useFakeTimers();
		try {
			const onJoined = vi.fn();
			const onJoinError = vi.fn();
			const wasm = mockWasm({ handshake_remote_static: () => "inviterpub" });
			const handle = makeEnrollHandler(
				"joiner",
				joinerOpts(wasm, { inviterPub: "inviterpub", onJoined, onJoinError }),
				vi.fn(),
			);
			const { peer, push } = joinPeer();

			const done = handle(peer);
			// Longer than a frame budget, well inside the window the inviter is honouring.
			await vi.advanceTimersByTimeAsync(90_000);
			push(bundleJson());
			await done;

			expect(onJoinError).not.toHaveBeenCalled();
			expect(onJoined).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails fast when the inviter rejects, rather than sitting on the approval wait", async () => {
		const onJoined = vi.fn();
		const onJoinError = vi.fn();
		const sent: string[] = [];
		const { channel, push } = makeChannel((d) => void sent.push(d));
		push("handshake");
		const wasm = mockWasm({ handshake_remote_static: () => "inviterpub" });
		const handle = makeEnrollHandler(
			"joiner",
			joinerOpts(wasm, { inviterPub: "inviterpub", onJoined, onJoinError }),
			vi.fn(),
		);

		const done = handle({ remotePubkey: "x", initiator: true, channel, close: vi.fn() });
		push(ENROLL_REJECTED);
		await done;

		// The approval wait is human-scale (the whole invite window), so without an explicit notice
		// the real device would spin for minutes after being refused.
		expect(onJoined).not.toHaveBeenCalled();
		expect(onJoinError).toHaveBeenCalledOnce();
		expect(String(onJoinError.mock.calls[0]?.[0])).toMatch(/didn't confirm|used up/i);
		// Still acknowledged, so the inviter can flush the notice before tearing the transport down.
		expect(sent.filter(Boolean).at(-1)).toBe(RECEIPT);
	});

	it("sends its introduction first and its receipt last", async () => {
		const sent: string[] = [];
		const { channel, push } = makeChannel((d) => void sent.push(d));
		push("handshake");
		const wasm = mockWasm({ handshake_remote_static: () => "inviterpub" });
		const handle = makeEnrollHandler(
			"joiner",
			joinerOpts(wasm, { inviterPub: "inviterpub" }),
			vi.fn(),
		);

		const done = handle({ remotePubkey: "x", initiator: true, channel, close: vi.fn() });
		push(bundleJson());
		await done;

		// Identity before the bundle, flush barrier after it. The receipt carries no identity.
		// Empty frames are the stub handshake's messages, not app data.
		const frames = sent.filter(Boolean);
		expect(frames[0]).toBe(JSON.stringify(ownEntry));
		expect(frames.at(-1)).toBe(RECEIPT);
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
				vekB64: b64(32),
			},
			inviterChannel,
			sess,
		).catch(() => {}); // the parked ack wait is bounded now; not what this test asserts
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
