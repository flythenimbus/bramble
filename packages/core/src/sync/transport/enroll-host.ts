// Enrollment orchestration over the mesh. On a peer channel: run the XXpsk3
// handshake (joiner=initiator, inviter=responder), the joiner pins the inviter's
// static key against the pairing code, then the inviter seals {vek, roster,
// entries} over the Noise session and the joiner rebuilds its vault from it —
// inside the offscreen, so the VEK never leaves it (only the wrapped blob does).
// See docs/p2p-sync.md.
//
// The joiner speaks first. Completing the handshake proves only that a peer holds the pairing
// code, which is not the same as being the user's device, so nothing is sent until the joiner
// has introduced itself with its roster entry, that entry is bound to the key it proved in the
// handshake, and the user has confirmed the SAS on both screens (GHSA-x4f5-4wq4-c6c8).

import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import {
	buildVaultBytes,
	type VaultBuildCrypto,
	wrapPasswordSlot,
	wrapWebauthnSlot,
} from "../../vault/build-vault";
import { type RecoverySlot, SLOT_KIND_RECOVERY, verifierPrefix } from "../../vault-format";
import {
	decodeEnrollmentBundle,
	type EntriesPayload,
	encodeEnrollmentBundle,
	INVITE_TTL_MS,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	type WireRecoverySlot,
} from "..";
import { pairingSas } from "../pairing-sas";
import type { Channel } from "./channel";
import {
	type Awaitable,
	type PumpWasm,
	runInitiator,
	runResponder,
	type Session,
} from "./handshake";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { type MeshSession, type MeshSessionOptions, startMeshSession } from "./peer-session";
import { recvSecure, sendSecure } from "./secure-channel";
import { withTimeout } from "./with-timeout";

// Every enrollment wait a peer can stall is bounded. Unbounded ones are what made the invite
// lifecycle unenforceable: `stop()` sat downstream of an unbounded await on the joiner's ack,
// so "the inviter serves one device then stops itself" was not racy, it was never reached
// (GHSA-x4f5-4wq4-c6c8). Per-frame, not per-message: a large vault legitimately spans frames.
//
// Machine-speed waits only: the handshake, the joiner's introduction, and continuation frames of
// a bundle already in flight. Nothing here waits on a person.
const ENROLL_TIMEOUT_MS = 30_000;

// The joiner's wait for the FIRST bundle frame, which spans the inviter's approval prompt and so
// is human time, not machine time. It has to be at least the inviter's own ceiling or a careful
// user times out the joiner on the happy path — with the invite already burned, and while
// teaching people that comparing the digits is what makes pairing fail. Tied to INVITE_TTL_MS
// rather than picked separately: the inviter's approval cannot outlive the invite timer, which
// tears the session down, so this can't be short of the real bound by construction.
const APPROVAL_WAIT_MS = INVITE_TTL_MS;

// The inviter's wait for the joiner's "I have it" frame. Covers the tail of the transfer plus the
// joiner's Argon2 vault rebuild, which is seconds on a slow phone, so it is deliberately slacker
// than a frame wait. Expiring here is harmless: the bundle is long since delivered.
const VAULT_ACK_TIMEOUT_MS = 60_000;

// The same barrier behind the much smaller rejection notice: nothing is being rebuilt, so this
// only has to cover the round trip.
const REJECT_ACK_TIMEOUT_MS = 5_000;

// The joiner's "I got your last frame". Content-free on purpose: identity was settled by the
// introduction BEFORE anything was sent, so this is not an identity claim, it is a flush barrier.
// See awaitReceipt. Exported so the tests assert the wire value rather than a copy of it.
export const RECEIPT = "bramble/enroll/received";

// Sent when the user answers "that is not my device". The joiner would otherwise sit on its
// approval wait with no idea anything had happened, which is up to the whole invite window.
export const ENROLL_REJECTED = "bramble/enroll/rejected";

/** The XXpsk3 enrollment handshake exports. Returns are Awaitable so the native
 * plugin (async bridge) and the in-webview WASM module share one interface. */
interface EnrollHandshakeWasm extends PumpWasm {
	handshake_enroll_initiator(
		privB64: string,
		pskB64: string,
	): Awaitable<{ sessionId: number; message: string }>;
	handshake_enroll_responder(privB64: string, pskB64: string): Awaitable<number>;
	handshake_encrypt(sessionId: number, plaintext: string): Awaitable<string>;
	handshake_decrypt(sessionId: number, ciphertextB64: string): Awaitable<string>;
}

/** The vault-crypto slice enrollment needs (the VEK is loaded in the wasm). */
interface CryptoWasm {
	export_vek(): Awaitable<string>;
	unlock_with_vek(vekB64: string): Awaitable<void>;
	generate_salt(): Awaitable<string>;
	generate_slot_id(): Awaitable<string>;
	wrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): Awaitable<{ verifier: string; wrapIv: string; wrappedVek: string }>;
	wrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): Awaitable<{ verifier: string; wrapIv: string; wrappedVek: string }>;
	encrypt_with_vek(plaintext: string): Awaitable<{ iv: string; ciphertext: string }>;
	/** Constant-time verifier check (no VEK unwrap) used to prove the joiner's typed
	 * password matches the inviter's existing master password. */
	verify_password_slot(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	): Awaitable<boolean>;
}

export type EnrollWasm = NostrWasm & EnrollHandshakeWasm & CryptoWasm;
export type EnrollRole = "inviter" | "joiner";
type Report = (status: string) => void;

interface JoinResult {
	vaultBlobB64: string;
	roster: RosterPayload;
}

export interface EnrollOptions {
	relayUrl: string;
	iceUrl?: string;
	groupKeyB64: string;
	psk: string;
	devicePrivB64: string;
	/** Inviter: this device's OWN Noise static public key (base64). Required to invite: it is half
	 * the SAS input, and the inviter cannot derive it from the private key it holds here. */
	devicePubB64?: string;
	wasm: EnrollWasm;
	report: Report;
	/** Inviter: the bundle's non-secret parts (the VEK is added from the wasm here). */
	roster?: RosterPayload;
	entries?: EntriesPayload;
	/** Inviter: this vault's VEK (base64), captured by the caller when the invite starts so the
	 * bundle ships the RIGHT vault's key. REQUIRED to invite — there is no ambient fallback.
	 * export_vek() reads whichever key is loaded at send time, which is the vault the user is in
	 * NOW, not necessarily the one being shared: on the extension's scratch-slot offscreen it
	 * returns whatever op ran last, and on mobile's single-VEK core it follows a vault switch.
	 * Shipping the wrong key hands the joiner a vault it can never open. See
	 * docs/multiple-vaults.md "Enrollment". */
	vekB64?: string;
	/** Inviter: this device's own password-slot fields (base64), shipped so the joiner
	 * can prove its typed password matches. Omitted when there is no password slot. */
	passwordCheck?: { saltB64: string; slotIdB64: string; verifierB64: string };
	/** Inviter: this device's recovery slot(s) (base64), forwarded so the joiner's vault ends up with
	 * the same recovery code (they wrap the shared VEK). Omitted when there is no recovery code. */
	recoverySlots?: WireRecoverySlot[];
	/** Joiner: pin the inviter's static key, the unlock material for the rebuilt vault
	 * (a password OR a security-key slot), and this device's roster entry to hand the
	 * inviter so both rosters end up symmetric. */
	inviterPub?: string;
	password?: string;
	webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
	ownEntry?: RosterEntry;
	/** Joiner: deliver the rebuilt (VEK-wrapped) vault blob to the host for writing. */
	onJoined?: (result: JoinResult) => void;
	/** Joiner: report a recoverable enrollment failure (e.g. the typed password did not
	 * match the existing device) so the host surfaces it instead of hanging. */
	onJoinError?: (message: string) => void;
	/** Inviter: the joiner's roster entry (JSON), to add to our roster. */
	onEnrolled?: (entryJson: string) => void;
	/** Inviter: show the SAS and the joining device's label, and resolve with the user's answer.
	 * REQUIRED to invite — there is no ambient "approved" fallback, because this is the only thing
	 * standing between a peer that holds the pairing code and the vault. `label` is chosen by the
	 * joiner, so it is context for the user, never proof; the SAS is the proof. */
	approve?: (sas: string, label: string) => Promise<boolean>;
	/** Joiner: the SAS to show while the other device waits for the user to confirm it. */
	onSas?: (sas: string) => void;
	/** Inviter: the invite window closed. Fired before the session is stopped, so the host can
	 * settle a prompt still waiting on `approve` and tell the UI. Expiry has to be authoritative
	 * HERE rather than left to a countdown in the UI: the UI may not be running (an extension
	 * popup closes on focus loss and comes back with its local state gone), and a prompt left on
	 * screen after the transport is dead offers a decision that can no longer be carried out. */
	onInviteExpired?: () => void;
	/** Inviter: a device tried to join and the invite died doing it. Carries a message for the
	 * user, because the reasons are things only they can act on (update the other device, try a
	 * new code). Fired only for failures that CONSUME the invite; a peer that never completes the
	 * handshake leaves it live and must not blow away a QR the real device is still coming for. */
	onEnrollFailed?: (message: string) => void;
	/** The mesh joiner and ICE fetch, overridden in tests with fakes. Same seam (and same reason)
	 * as MeshSessionOptions.join, passed straight through; without it the invite timer can only be
	 * exercised by standing up a real transport. */
	join?: MeshSessionOptions["join"];
	fetchIce?: MeshSessionOptions["fetchIce"];
}

export async function startEnroll(role: EnrollRole, opts: EnrollOptions): Promise<MeshSession> {
	let session: MeshSession | null = null;
	let expiry: ReturnType<typeof setTimeout> | undefined;
	// The inviter serves one device then stops itself; the joiner is stopped by the host.
	const handlePeer = makeEnrollHandler(role, opts, () => session?.stop());
	session = await startMeshSession({
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		roomLabel: "bramble/enroll",
		wasm: opts.wasm,
		report: opts.report,
		onPeer: handlePeer,
		onStop: () => clearTimeout(expiry),
		join: opts.join,
		fetchIce: opts.fetchIce,
	});
	// An invite is a bearer credential, so it must not outlive the window the user is watching.
	// A LOCAL timer, deliberately, rather than comparing wall clocks against the code's `exp`:
	// no amount of device clock skew can then stretch the window. The joiner's `exp` check is
	// only there to produce a readable error. See docs/p2p-sync.md "Pairing code".
	if (role === "inviter") {
		expiry = setTimeout(() => {
			opts.report("invite expired: generate a new code to add a device");
			// Before stop(): a peer may be sitting on the approval prompt right now, and once the
			// session is gone there is nothing left for an "Approve" to act on.
			opts.onInviteExpired?.();
			session?.stop();
		}, INVITE_TTL_MS);
	}
	opts.report(role === "inviter" ? "waiting for a device to join…" : "connecting to inviter…");
	return session;
}

// Load the group vek into the slot, then run the op, with no await between them on the
// synchronous (extension) path. The joiner shares the offscreen wasm with the per-op seam, so a
// concurrent crypto op could otherwise clobber the loaded vek between the joiner's wraps.
//
// Mobile's calls are async, so this chains a .then instead. That is NOT because mobile has no
// contention — it has a single process-global VEK, so it has the most — but because there is no
// synchronous option there. The joiner is safe regardless: it is rebuilding a vault from a bundle,
// so the key it loads here is the one it just received, not one it looked up.
function loadThen<T>(wasm: CryptoWasm, vekB64: string, op: () => Awaitable<T>): Promise<T> {
	const r = wasm.unlock_with_vek(vekB64);
	return r instanceof Promise ? r.then(op) : Promise.resolve(op());
}

function wasmSlotCrypto(wasm: CryptoWasm, vekB64: string): VaultBuildCrypto {
	return {
		generateSalt: () => Promise.resolve(wasm.generate_salt()),
		generateSlotId: () => Promise.resolve(wasm.generate_slot_id()),
		wrapVekPassword: (i) =>
			loadThen(wasm, vekB64, () =>
				wasm.wrap_vek_password(i.password, i.saltB64, i.slotIdB64, i.magicVersion),
			),
		wrapVekWebauthn: (i) =>
			loadThen(wasm, vekB64, () =>
				wasm.wrap_vek_webauthn(i.hmacSecretB64, i.slotIdB64, i.magicVersion),
			),
		encryptWithVek: (p) => loadThen(wasm, vekB64, () => wasm.encrypt_with_vek(p)),
	};
}

/**
 * The per-peer handler for ONE invite, with the single-use claim in its closure.
 *
 * Exported (like sendBundle/receiveBundle below) because that closure is the seam the
 * concurrency tests need: two peers have to race the same invite, and neither startEnroll nor
 * roster-sync exposes the `join` override MeshSessionOptions has. A factory keeps that out of
 * the production options object.
 */
export function makeEnrollHandler(
	role: EnrollRole,
	opts: EnrollOptions,
	stop: () => void,
): (peer: PeerSession) => Promise<void> {
	// Single use. The first peer to complete the handshake claims the invite; a claim is never
	// released, so a failure downstream BURNS the code rather than re-arming it. That is
	// deliberate: a second peer arriving means the code reached someone it shouldn't have, and
	// the recovery ("generate a new one") costs the user a tap.
	let consumed = false;
	return async (peer: PeerSession): Promise<void> => {
		const { channel, remotePubkey } = peer;
		opts.report(`channel open with ${remotePubkey.slice(0, 8)}: authenticating…`);
		const { wasm, devicePrivB64: priv, psk } = opts;
		let sess: Session;
		try {
			sess = await withTimeout(
				role === "inviter"
					? runResponder(wasm, channel, () => wasm.handshake_enroll_responder(priv, psk))
					: runInitiator(wasm, channel, () => wasm.handshake_enroll_initiator(priv, psk)),
				ENROLL_TIMEOUT_MS,
				"enrollment handshake",
			);
		} catch (e) {
			// Drop just this peer. The invite stays live (it was never claimed) so the real device
			// can still arrive within the window.
			opts.report(`⚠ handshake with ${remotePubkey.slice(0, 8)} failed: ${(e as Error).message}`);
			peer.close();
			return;
		}

		if (role === "joiner") {
			// Pin the inviter's static key from the pairing code. Previously guarded on
			// `opts.inviterPub &&`, so a caller that forgot it silently got NO MITM protection;
			// every current caller passes it (PairingCodeSchema requires it), so requiring it here
			// only converts a latent footgun into a loud one.
			if (!opts.inviterPub) throw new Error("enroll: joining without an inviter key to pin");
			if (sess.remoteStatic !== opts.inviterPub) {
				// Close only THIS peer, and leave the session running. Stopping it here let anyone
				// in the room kill every join attempt just by presenting a wrong static key: the
				// real inviter is still out there, and the pin is what tells them apart.
				opts.report(`⚠ ${remotePubkey.slice(0, 8)} is not the inviter, ignoring (possible MITM)`);
				peer.close();
				return;
			}
			if (!opts.ownEntry) throw new Error("enroll: joining without a roster entry to present");
			opts.report("authenticated ✅, waiting for confirmation on your other device…");
			try {
				// Hello first: hand the inviter our roster entry BEFORE it sends anything, so it can
				// bind it to the key we just proved and show the user who is actually joining. Sent
				// exactly once, and it is byte-identical to the ack an older inviter already expects
				// after the bundle, which is what makes that direction of skew work unchanged.
				await sendSecure(channel, opts.wasm, sess.sessionId, JSON.stringify(opts.ownEntry));
				opts.onSas?.(await pairingSas(opts.psk, opts.ownEntry.publicKey, sess.remoteStatic));
				await receiveBundle(opts, peer, sess);
			} catch (e) {
				// A stalled inviter used to hang the joiner forever (the host awaits `joined`).
				opts.report(`⚠ enrollment failed: ${(e as Error).message}`);
				peer.close();
				opts.onJoinError?.(
					"Pairing didn't complete. Check the code was confirmed on your other device, then generate a new one.",
				);
			}
			return;
		}

		// Check-and-set with NO await between the two statements: JS runs this stretch to
		// completion, so two peers that finish the handshake concurrently cannot both see false.
		// It has to happen here, BEFORE anything is sent, not after the transfer.
		if (consumed) {
			opts.report(`⚠ refusing ${remotePubkey.slice(0, 8)}: this invite has already been used`);
			peer.close();
			return;
		}
		consumed = true;
		opts.report("authenticated ✅, identifying the device…");
		try {
			await serveJoiner(opts, channel, sess);
		} finally {
			// Whatever happened, this invite is spent. Ends the session on the failure paths too,
			// which previously fell through to an unbounded await and left the room open.
			stop();
		}
	};
}

/**
 * The inviter's side of one claimed invite: learn who is joining, get the user's confirmation,
 * and only then hand over the vault. Exported for unit tests, like the two seams below.
 *
 * Every step before `sendBundle` is a gate, and the order is the point: an attacker that wins the
 * race to the handshake gets no further than a prompt the user is about to reject.
 */
async function serveJoiner(opts: EnrollOptions, channel: Channel, sess: Session): Promise<void> {
	if (!opts.devicePubB64) throw new Error("enroll: refusing to invite without this device's key");
	if (!opts.approve) throw new Error("enroll: refusing to invite without an approval gate");
	const entry = await recvJoinerHello(opts, channel, sess);
	if (!entry) return; // reason already reported
	const sas = await pairingSas(opts.psk, opts.devicePubB64, sess.remoteStatic);
	opts.report(`confirm this code matches on the other device: ${sas}`);
	if (!(await opts.approve(sas, entry.label))) {
		// Burned, not re-armed: the invite is spent either way (see makeEnrollHandler). If the user
		// says "that isn't my device", the code demonstrably reached someone else, so the one thing
		// we must not do is give them another attempt at it.
		opts.report("⚠ pairing rejected: this code is now dead, generate a new one");
		// Tell the joiner, and wait for it to confirm. Without this the peer just sees the transport
		// vanish and sits on its approval wait, which is human-scale: the real device would spin for
		// minutes with no idea it had been refused. Telling it discloses nothing, since it can
		// already see it got no vault.
		await sendSecure(channel, opts.wasm, sess.sessionId, ENROLL_REJECTED);
		await awaitReceipt(opts, channel, sess, REJECT_ACK_TIMEOUT_MS);
		return;
	}
	opts.report("confirmed ✅, transferring vault…");
	await sendBundle(opts, channel, sess);
	opts.onEnrolled?.(JSON.stringify(entry));
	opts.report("device enrolled ✅");
	// Last, and never gating the roster add above: this only holds the transport open long enough
	// for the bundle to actually leave.
	await awaitReceipt(opts, channel, sess, VAULT_ACK_TIMEOUT_MS);
}

/**
 * Wait for the joiner to confirm it received what we just sent, so the transport isn't torn down
 * with that data still in flight.
 *
 * `sendSecure` resolving means the frames were handed to the channel, NOT that they were sent.
 * On the relay path `channel.send` only queues `void publish(...)`, which awaits two WebCrypto
 * ops before it reaches the socket, and `mesh.stop()` calls `client.close()` synchronously in the
 * same macrotask; on WebRTC, `pc.close()` discards whatever SCTP still has queued. With `stop()`
 * in the handler's `finally` right behind the send, the tail of a multi-frame bundle was being
 * dropped, and losing any one frame fails the whole message. Roughly 30 entries fit in a single
 * 32 KiB frame, so this only shows up on real vaults, and only sometimes: exactly the shape of a
 * flaky-pairing bug report.
 *
 * A failure here is not an enrollment failure. The joiner has the bundle by the time it would be
 * building the vault, so we swallow it and let the session close.
 */
async function awaitReceipt(
	opts: EnrollOptions,
	channel: Channel,
	sess: Session,
	timeoutMs: number,
): Promise<void> {
	try {
		await recvSecure(
			() => withTimeout(channel.recv(), timeoutMs, "acknowledgement"),
			opts.wasm,
			sess.sessionId,
		);
	} catch {
		// An older joiner sends its roster entry here instead, which lands as an ordinary frame and
		// satisfies the wait just as well. Anything else: the vault still went out.
		opts.report("note: the other device didn't confirm receipt");
	}
}

/**
 * Read the joiner's roster entry and bind it to the static key it proved in the handshake.
 *
 * Returns null (having reported why) rather than throwing, so a bad or absent introduction ends
 * the invite quietly instead of surfacing as a transport error. There is deliberately NO fallback
 * to the old order for a joiner that sends nothing: an attacker could otherwise stay silent to
 * force the legacy "send first, validate later" path. See docs/p2p-sync.md "Version skew".
 */
async function recvJoinerHello(
	opts: EnrollOptions,
	channel: Channel,
	sess: Session,
): Promise<RosterEntry | null> {
	let json: string;
	try {
		json =
			(await recvSecure(
				() => withTimeout(channel.recv(), ENROLL_TIMEOUT_MS, "device introduction"),
				opts.wasm,
				sess.sessionId,
			)) ?? "";
	} catch {
		opts.report("⚠ no response: update Bramble on your other device to pair with this one");
		opts.onEnrollFailed?.(
			"That device didn't respond. It's probably running an older version of Bramble: update it there, then generate a new code.",
		);
		return null;
	}
	let entry: RosterEntry | null = null;
	try {
		entry = RosterEntrySchema.parse(JSON.parse(json));
	} catch {
		entry = null;
	}
	// Pin the entry's key to the one the joiner actually proved, so it can't seat a key it doesn't
	// control (or a third party's) into the roster. This used to run AFTER the bundle was sent,
	// which made it a roster hygiene check rather than the access check it reads as.
	if (!entry || entry.publicKey !== sess.remoteStatic) {
		opts.report("⚠ the joining device sent an invalid introduction, not enrolling");
		opts.onEnrollFailed?.(
			"That device couldn't be verified, so nothing was sent. Generate a new code and try again.",
		);
		return null;
	}
	return entry;
}

// Exported for unit tests (the mesh/handshake wrapping is covered elsewhere); these
// are the two seams carrying the new provable-password-match logic.
export async function sendBundle(
	opts: EnrollOptions,
	channel: Channel,
	sess: Session,
): Promise<void> {
	// No ambient export_vek() fallback: it reads whatever key is loaded at THIS moment, so an
	// invite that outlived a vault switch would ship the wrong vault's key. Refusing is safe (the
	// user retries the invite); sending is not (the joiner rebuilds a vault nothing can open).
	if (!opts.vekB64) throw new Error("enroll: refusing to send a bundle without an explicit VEK");
	const bundle = encodeEnrollmentBundle({
		vek: opts.vekB64,
		roster: opts.roster ?? { devices: [], revoked: [] },
		entries: opts.entries ?? { entries: [], tombstones: [] },
		primaryPasswordCheck: opts.passwordCheck,
		recoverySlots: opts.recoverySlots,
	});
	// Send only: the joiner's roster entry arrived before this (recvJoinerHello), so nothing is
	// waited on here. The caller then waits for a receipt (waitForVaultAck) purely to flush the
	// transport. That wait is bounded and sits upstream of stop(), unlike the unbounded ack this
	// replaced, which is what held the invite open indefinitely.
	await sendSecure(channel, opts.wasm, sess.sessionId, bundle);
}

export async function receiveBundle(
	opts: EnrollOptions,
	peer: PeerSession,
	sess: Session,
): Promise<void> {
	const { channel } = peer;
	// The FIRST frame is the one the user's comparison sits in front of, so it gets the human-time
	// budget; once the bundle is flowing, a gap between frames is a stall and gets the short one.
	let awaitingApproval = true;
	const recvFrame = () => {
		const ms = awaitingApproval ? APPROVAL_WAIT_MS : ENROLL_TIMEOUT_MS;
		const label = awaitingApproval ? "confirmation on the other device" : "vault transfer";
		awaitingApproval = false;
		return withTimeout(channel.recv(), ms, label);
	};
	const first = (await recvSecure(recvFrame, opts.wasm, sess.sessionId)) ?? "";
	// The user said "not my device". Confirm so the inviter can flush before it tears the
	// transport down, then fail fast instead of sitting on the approval wait until it expires.
	if (first === ENROLL_REJECTED) {
		opts.report("⚠ the other device rejected this pairing");
		await sendSecure(channel, opts.wasm, sess.sessionId, RECEIPT);
		peer.close();
		opts.onJoinError?.(
			"Your other device didn't confirm this pairing. That code is now used up. Generate a new one there and try again.",
		);
		return;
	}
	const bundle = decodeEnrollmentBundle(first);
	// Provable same-password enforcement: when the inviter shipped its password-slot
	// verifier and this device is joining with a password, the typed password MUST
	// match the existing device's master password. An absent check (security-key
	// inviter or older build) falls back to the joiner-local confirm-password guard.
	if (bundle.primaryPasswordCheck && !opts.webauthn) {
		const ok = await opts.wasm.verify_password_slot(
			opts.password ?? "",
			bundle.primaryPasswordCheck.saltB64,
			bundle.primaryPasswordCheck.slotIdB64,
			bundle.primaryPasswordCheck.verifierB64,
			verifierPrefix(),
		);
		if (!ok) {
			opts.report("⚠ password doesn't match your existing device, aborting");
			peer.close();
			opts.onJoinError?.("That doesn't match your other device's master password.");
			return;
		}
	}
	await opts.wasm.unlock_with_vek(bundle.vek); // adopt the group VEK (stays in the wasm)
	const slotCrypto = wasmSlotCrypto(opts.wasm, bundle.vek);
	const slot = opts.webauthn
		? await wrapWebauthnSlot(slotCrypto, {
				hmacSecretB64: opts.webauthn.hmacSecretB64,
				credentialId: base64ToBytes(opts.webauthn.credentialIdB64),
				salt: base64ToBytes(opts.webauthn.saltB64),
			})
		: await wrapPasswordSlot(slotCrypto, opts.password ?? "");
	// Copy the inviter's recovery slot(s) verbatim: they wrap the same (group) VEK, so the group's
	// recovery code unlocks this device too. Without this the rebuilt vault would have no recovery
	// path (it's rebuilt with just the unlock slot above).
	const recoverySlots: RecoverySlot[] = (bundle.recoverySlots ?? []).map((s) => ({
		kind: SLOT_KIND_RECOVERY,
		slotId: base64ToBytes(s.slotIdB64),
		salt: base64ToBytes(s.saltB64),
		verifier: base64ToBytes(s.verifierB64),
		wrapIv: base64ToBytes(s.wrapIvB64),
		wrappedVek: base64ToBytes(s.wrappedVekB64),
	}));
	const bytes = await buildVaultBytes(slotCrypto, [slot, ...recoverySlots], bundle.entries);
	// Tell the inviter we have it all, so it doesn't tear the transport down mid-transfer (see
	// waitForVaultAck). Not our roster entry: that went up front, before the inviter released the
	// vault, and this carries no identity. An older inviter has already stopped by now and simply
	// never reads this; an unread frame costs nothing, whereas a truncated transfer costs the
	// pairing. Sent before onJoined, which writes the vault and can take a while.
	await sendSecure(channel, opts.wasm, sess.sessionId, RECEIPT);
	opts.report("vault received ✅, finishing setup");
	opts.onJoined?.({ vaultBlobB64: bytesToBase64(bytes), roster: bundle.roster });
}
