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
import {
	decodeEnrollmentBundle,
	type EntriesPayload,
	encodeEnrollmentBundle,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
} from "..";
import type { Channel } from "./channel";
import { type PumpWasm, runInitiator, runResponder, type Session } from "./handshake";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { type MeshSession, startMeshSession } from "./peer-session";

/** The XXpsk3 enrollment handshake exports. */
interface EnrollHandshakeWasm extends PumpWasm {
	handshake_enroll_initiator(
		privB64: string,
		pskB64: string,
	): { sessionId: number; message: string };
	handshake_enroll_responder(privB64: string, pskB64: string): number;
	handshake_encrypt(sessionId: number, plaintext: string): string;
	handshake_decrypt(sessionId: number, ciphertextB64: string): string;
}

/** The vault-crypto slice enrollment needs (the VEK is loaded in the wasm). */
interface CryptoWasm {
	export_vek(): string;
	unlock_with_vek(vekB64: string): void;
	generate_salt(): string;
	generate_slot_id(): string;
	wrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): { verifier: string; wrapIv: string; wrappedVek: string };
	wrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): { verifier: string; wrapIv: string; wrappedVek: string };
	encrypt_with_vek(plaintext: string): { iv: string; ciphertext: string };
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
	groupKeyB64: string;
	psk: string;
	devicePrivB64: string;
	wasm: EnrollWasm;
	report: Report;
	/** Inviter: the bundle's non-secret parts (the VEK is added from the wasm here). */
	roster?: RosterPayload;
	entries?: EntriesPayload;
	/** Joiner: pin the inviter's static key, the unlock material for the rebuilt vault
	 * (a password OR a security-key slot), and this device's roster entry to hand the
	 * inviter so both rosters end up symmetric. */
	inviterPub?: string;
	password?: string;
	webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
	ownEntry?: RosterEntry;
	/** Joiner: deliver the rebuilt (VEK-wrapped) vault blob to the host for writing. */
	onJoined?: (result: JoinResult) => void;
	/** Inviter: the joiner's roster entry (JSON), to add to our roster. */
	onEnrolled?: (entryJson: string) => void;
}

export async function startEnroll(role: EnrollRole, opts: EnrollOptions): Promise<MeshSession> {
	let session: MeshSession | null = null;
	session = await startMeshSession({
		relayUrl: opts.relayUrl,
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
		await receiveBundle(opts, channel, sess);
	}
}

async function sendBundle(opts: EnrollOptions, channel: Channel, sess: Session): Promise<void> {
	const bundle = encodeEnrollmentBundle({
		vek: opts.wasm.export_vek(),
		roster: opts.roster ?? { devices: [], revoked: [] },
		entries: opts.entries ?? { entries: [], tombstones: [] },
	});
	channel.send(opts.wasm.handshake_encrypt(sess.sessionId, bundle));
	// The joiner acks with its roster entry, so our roster learns it (symmetric).
	const entryJson = opts.wasm.handshake_decrypt(sess.sessionId, await channel.recv());
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

async function receiveBundle(opts: EnrollOptions, channel: Channel, sess: Session): Promise<void> {
	const bundle = decodeEnrollmentBundle(
		opts.wasm.handshake_decrypt(sess.sessionId, await channel.recv()),
	);
	opts.wasm.unlock_with_vek(bundle.vek); // adopt the group VEK (stays in the wasm)
	const slotCrypto = wasmSlotCrypto(opts.wasm);
	const slot = opts.webauthn
		? await wrapWebauthnSlot(slotCrypto, {
				hmacSecretB64: opts.webauthn.hmacSecretB64,
				credentialId: base64ToBytes(opts.webauthn.credentialIdB64),
				salt: base64ToBytes(opts.webauthn.saltB64),
			})
		: await wrapPasswordSlot(slotCrypto, opts.password ?? "");
	const bytes = await buildVaultBytes(slotCrypto, [slot], bundle.entries);
	// Ack with our roster entry so the inviter's roster learns this device.
	channel.send(opts.wasm.handshake_encrypt(sess.sessionId, JSON.stringify(opts.ownEntry)));
	opts.report("vault received ✅ — finishing setup");
	opts.onJoined?.({ vaultBlobB64: bytesToBase64(bytes), roster: bundle.roster });
}
