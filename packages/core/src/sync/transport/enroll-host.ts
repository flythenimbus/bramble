// Enrollment orchestration over the mesh. On a peer channel: run the XXpsk3
// handshake (joiner=initiator, inviter=responder), the joiner pins the inviter's
// static key against the pairing code, then the inviter seals {vek, roster,
// entries} over the Noise session and the joiner rebuilds its vault from it —
// inside the offscreen, so the VEK never leaves it (only the wrapped blob does).
// See docs/p2p-sync.md.

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
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	type WireRecoverySlot,
} from "..";
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
import { type MeshSession, startMeshSession } from "./peer-session";
import { recvSecure, sendSecure } from "./secure-channel";

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

export interface JoinResult {
	vaultBlobB64: string;
	roster: RosterPayload;
}

export interface EnrollOptions {
	relayUrl: string;
	iceUrl?: string;
	groupKeyB64: string;
	psk: string;
	devicePrivB64: string;
	wasm: EnrollWasm;
	report: Report;
	/** Inviter: the bundle's non-secret parts (the VEK is added from the wasm here). */
	roster?: RosterPayload;
	entries?: EntriesPayload;
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
}

export async function startEnroll(role: EnrollRole, opts: EnrollOptions): Promise<MeshSession> {
	let session: MeshSession | null = null;
	session = await startMeshSession({
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		roomLabel: "bramble/enroll",
		wasm: opts.wasm,
		report: opts.report,
		// The inviter serves one device then stops itself; the joiner is stopped by the host.
		onPeer: (peer) => handlePeer(role, opts, peer, () => session?.stop()),
	});
	opts.report(role === "inviter" ? "waiting for a device to join…" : "connecting to inviter…");
	return session;
}

function wasmSlotCrypto(wasm: CryptoWasm): VaultBuildCrypto {
	return {
		generateSalt: () => Promise.resolve(wasm.generate_salt()),
		generateSlotId: () => Promise.resolve(wasm.generate_slot_id()),
		wrapVekPassword: (i) =>
			Promise.resolve(wasm.wrap_vek_password(i.password, i.saltB64, i.slotIdB64, i.magicVersion)),
		wrapVekWebauthn: (i) =>
			Promise.resolve(wasm.wrap_vek_webauthn(i.hmacSecretB64, i.slotIdB64, i.magicVersion)),
		encryptWithVek: (p) => Promise.resolve(wasm.encrypt_with_vek(p)),
	};
}

async function handlePeer(
	role: EnrollRole,
	opts: EnrollOptions,
	peer: PeerSession,
	stop: () => void,
): Promise<void> {
	const { channel, remotePubkey } = peer;
	opts.report(`channel open with ${remotePubkey.slice(0, 8)} — authenticating…`);
	const { wasm, devicePrivB64: priv, psk } = opts;
	const sess =
		role === "inviter"
			? await runResponder(wasm, channel, () => wasm.handshake_enroll_responder(priv, psk))
			: await runInitiator(wasm, channel, () => wasm.handshake_enroll_initiator(priv, psk));

	if (role === "joiner" && opts.inviterPub && sess.remoteStatic !== opts.inviterPub) {
		opts.report("⚠ inviter key mismatch — aborting (possible MITM)");
		peer.close();
		stop();
		return;
	}
	opts.report("authenticated ✅ — transferring vault…");
	if (role === "inviter") {
		await sendBundle(opts, channel, sess);
		stop();
	} else {
		await receiveBundle(opts, peer, sess);
	}
}

// Exported for unit tests (the mesh/handshake wrapping is covered elsewhere); these
// are the two seams carrying the new provable-password-match logic.
export async function sendBundle(
	opts: EnrollOptions,
	channel: Channel,
	sess: Session,
): Promise<void> {
	const bundle = encodeEnrollmentBundle({
		vek: await opts.wasm.export_vek(),
		roster: opts.roster ?? { devices: [], revoked: [] },
		entries: opts.entries ?? { entries: [], tombstones: [] },
		primaryPasswordCheck: opts.passwordCheck,
		recoverySlots: opts.recoverySlots,
	});
	await sendSecure(channel, opts.wasm, sess.sessionId, bundle);
	// The joiner acks with its roster entry, so our roster learns it (symmetric).
	const entryJson = (await recvSecure(() => channel.recv(), opts.wasm, sess.sessionId)) ?? "";
	// Validate the entry and pin its publicKey to the static key the joiner actually
	// proved in the handshake, so it can't seat a key it doesn't control (or a third
	// party's) into the roster.
	let entry: RosterEntry | null = null;
	try {
		entry = RosterEntrySchema.parse(JSON.parse(entryJson));
	} catch {
		entry = null;
	}
	if (!entry || entry.publicKey !== sess.remoteStatic) {
		opts.report("⚠ joiner sent an invalid roster entry — not enrolling");
		return;
	}
	opts.onEnrolled?.(entryJson);
	opts.report("device enrolled ✅");
}

export async function receiveBundle(
	opts: EnrollOptions,
	peer: PeerSession,
	sess: Session,
): Promise<void> {
	const { channel } = peer;
	const bundle = decodeEnrollmentBundle(
		(await recvSecure(() => channel.recv(), opts.wasm, sess.sessionId)) ?? "",
	);
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
			opts.report("⚠ password doesn't match your existing device — aborting");
			peer.close();
			opts.onJoinError?.("That doesn't match your other device's master password.");
			return;
		}
	}
	await opts.wasm.unlock_with_vek(bundle.vek); // adopt the group VEK (stays in the wasm)
	const slotCrypto = wasmSlotCrypto(opts.wasm);
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
	// Ack with our roster entry so the inviter's roster learns this device.
	await sendSecure(channel, opts.wasm, sess.sessionId, JSON.stringify(opts.ownEntry));
	opts.report("vault received ✅ — finishing setup");
	opts.onJoined?.({ vaultBlobB64: bytesToBase64(bytes), roster: bundle.roster });
}
