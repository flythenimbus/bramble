// The crypto surface the sync host runs on, routed to the Rust side.
//
// Sync runs in this webview, not in a separate host: macOS WKWebView exposes
// RTCPeerConnection, RTCDataChannel and WebSocket, so @core's transport, relay client and
// merge engine all run unchanged. What cannot run here is the crypto, because the VEK lives in
// the Rust process and never crosses into the webview. So this mirrors mobile's
// `nativeSyncCrypto`: the same snake_case names @core/sync calls, each one an invoke.
//
// Named to match the wasm exports rather than the repo's usual camelCase on purpose. @core's
// sync layer was written against the wasm module's own names, and renaming here would mean a
// mapping layer whose only job is to undo a rename. See docs/desktop-port.md.

import { invoke } from "@tauri-apps/api/core";
import { desktopCrypto } from "./adapters/crypto";

interface Keypair {
	privateKey: string;
	publicKey: string;
}

interface StartResult {
	sessionId: number;
	message: string;
}

interface ReadResult {
	message?: string;
	done: boolean;
}

/**
 * The vault-crypto slice @core/sync needs, in the wasm module's positional shape.
 *
 * The desktop crypto adapter already wraps every one of these, but with named-object arguments
 * and camelCase, because that is what @core/adapters/crypto declares. @core/sync was written
 * against the wasm exports instead, so this translates rather than duplicating: one call each,
 * no second path to the same command that could drift from the first.
 */
const cryptoSlice = {
	export_vek: () => desktopCrypto.exportVek(),
	unlock_with_vek: (vekB64: string) => desktopCrypto.unlockWithVek(vekB64),
	generate_salt: () => desktopCrypto.generateSalt(),
	generate_slot_id: () => desktopCrypto.generateSlotId(),
	wrap_vek_password: (
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	) => desktopCrypto.wrapVekPassword({ password, saltB64, slotIdB64, magicVersion }),
	wrap_vek_webauthn: (hmacSecretB64: string, slotIdB64: string, magicVersion: Uint8Array) =>
		desktopCrypto.wrapVekWebauthn({ hmacSecretB64, slotIdB64, magicVersion }),
	encrypt_with_vek: (plaintext: string) => desktopCrypto.encryptWithVek(plaintext),
	verify_password_slot: (
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	) =>
		desktopCrypto.verifyPasswordSlot({
			password,
			saltB64,
			slotIdB64,
			verifierB64,
			magicVersion,
		}),
};

export const desktopSyncCrypto = {
	...cryptoSlice,

	// --- Noise: XXpsk3 to enroll a new device, KK once both statics are known ---
	handshake_generate_keypair: (): Promise<Keypair> => invoke("sync_handshake_generate_keypair"),
	handshake_start_initiator: (privB64: string, remotePubB64: string): Promise<StartResult> =>
		invoke("sync_handshake_start_initiator", {
			localPrivB64: privB64,
			remotePubB64,
		}),
	handshake_start_responder: (privB64: string, remotePubB64: string): Promise<number> =>
		invoke("sync_handshake_start_responder", {
			localPrivB64: privB64,
			remotePubB64,
		}),
	handshake_enroll_initiator: (privB64: string, pskB64: string): Promise<StartResult> =>
		invoke("sync_handshake_enroll_initiator", { localPrivB64: privB64, pskB64 }),
	handshake_enroll_responder: (privB64: string, pskB64: string): Promise<number> =>
		invoke("sync_handshake_enroll_responder", { localPrivB64: privB64, pskB64 }),
	handshake_read: (sessionId: number, messageB64: string): Promise<ReadResult> =>
		invoke("sync_handshake_read", { sessionId, messageB64 }),
	handshake_encrypt: (sessionId: number, plaintext: string): Promise<string> =>
		invoke("sync_handshake_encrypt", { sessionId, plaintext }),
	handshake_decrypt: (sessionId: number, ciphertextB64: string): Promise<string> =>
		invoke("sync_handshake_decrypt", { sessionId, ciphertextB64 }),
	handshake_remote_static: (sessionId: number): Promise<string> =>
		invoke("sync_handshake_remote_static", { sessionId }),
	handshake_close: (sessionId: number): Promise<void> =>
		invoke("sync_handshake_close", { sessionId }),

	// --- Nostr event signing, for the relay used as signaling ---
	nostr_generate_key: (): Promise<{ secretKey: string; publicKey: string }> =>
		invoke("sync_nostr_generate_key"),
	nostr_public_key: (secretB64: string): Promise<string> =>
		invoke("sync_nostr_public_key", { secretB64 }),
	nostr_sign: (secretB64: string, messageHex: string): Promise<string> =>
		invoke("sync_nostr_sign", { secretB64, messageHex }),
	nostr_verify: (
		publicKeyHex: string,
		messageHex: string,
		signatureHex: string,
	): Promise<boolean> => invoke("sync_nostr_verify", { publicKeyHex, messageHex, signatureHex }),

	// --- Ed25519 roster signing, and the password-derived admission key ---
	roster_sig_generate_key: (): Promise<{ secretKey: string; publicKey: string }> =>
		invoke("sync_roster_sig_generate_key"),
	roster_sig_public_key: (secretB64: string): Promise<string> =>
		invoke("sync_roster_sig_public_key", { secretB64 }),
	roster_sign: (secretB64: string, message: string): Promise<string> =>
		invoke("sync_roster_sign", { secretB64, message }),
	roster_verify: (publicKeyB64: string, message: string, signatureB64: string): Promise<boolean> =>
		invoke("sync_roster_verify", { publicKeyB64, message, signatureB64 }),
	roster_admission_public_key: (password: string, saltB64: string): Promise<string> =>
		invoke("sync_roster_admission_public_key", { password, saltB64 }),
	roster_admission_sign: (password: string, saltB64: string, message: string): Promise<string> =>
		invoke("sync_roster_admission_sign", { password, saltB64, message }),
};

export type DesktopSyncCrypto = typeof desktopSyncCrypto;
