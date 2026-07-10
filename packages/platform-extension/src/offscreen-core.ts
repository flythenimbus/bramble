/// <reference types="chrome" />

// Transport-free crypto + sync host. Runs in the Chrome offscreen document (driven
// by offscreen.ts) or, on Firefox where there is no chrome.offscreen, in the
// background event page (driven by offscreen-client.ts). Touches no DOM and loads no
// WASM at import time so a background service worker can import it safely; the WASM
// module loads lazily on the first crypto op.

// Import from the specific adapter modules, not the @core/index barrel: the barrel
// re-exports the React UI (App/OptionsApp) which pulls in Lingui macros that vitest
// does not compile, and would also bloat the background bundle.
import type { CryptoAdapter } from "@core/adapters/crypto";
import { buildCryptoAdapter } from "@core/adapters/crypto-wasm";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { type RosterSyncWasm, startRosterSync } from "@core/sync/transport/roster-sync";
import {
	CryptoDecryptOuterSchema,
	CryptoDecryptSchema,
	CryptoEncryptOuterSchema,
	CryptoEncryptSchema,
	CryptoOpenKdbxSchema,
	CryptoPasskeyGetSchema,
	CryptoPasskeyMakeSchema,
	CryptoUnlockWithVekSchema,
	CryptoUnwrapPasswordSlotSchema,
	CryptoUnwrapWebauthnSlotSchema,
	CryptoVerifyPasswordSlotSchema,
	CryptoVerifyWebauthnSlotSchema,
	CryptoWrapPasswordSlotSchema,
	CryptoWrapWebauthnSlotSchema,
} from "./crypto/messages";
import { api } from "./platform-api";
import {
	AdmissionPubkeyMsgSchema,
	AdmissionSignHostMsgSchema,
	EnrollInviteMsgSchema,
	EnrollJoinMsgSchema,
	RosterSignHostMsgSchema,
	RosterSyncMsgSchema,
	type SyncEventMsg,
	type SyncStatusMsg,
} from "./sync/messages";
import type { KeypairWasm, RosterSigWasm } from "./sync/sync-config";
import { loadWasm, type VaultCrypto } from "./wasm-loader";

/**
 * The storage round-trips the roster-sync host needs. Local read + merge + write
 * happen where chrome.storage lives (the background): provided as runtime-message
 * round-trips on Chrome (the offscreen document has no storage) and as in-process
 * calls on Firefox (the host already runs in the background event page).
 */
export interface SyncBridge {
	fetchLocalPayload: () => Promise<string>;
	pushRemotePayload: (payloadJson: string) => Promise<void>;
	fetchLocalRoster: () => Promise<string>;
	pushRemoteRoster: (rosterJson: string) => Promise<void>;
}

export interface HostResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
}

// The active sync storage bridge for this host context, registered by whichever
// transport owns storage: offscreen.ts (Chrome, round-trips to the background) or
// sync.ts (Firefox, in-process). Kept here (a leaf module) rather than in
// offscreen-client so sync.ts can register it without the sync<->offscreen-client
// import cycle hitting a temporal-dead-zone on a not-yet-initialized binding.
let syncBridge: SyncBridge | null = null;
export function setSyncBridge(bridge: SyncBridge): void {
	syncBridge = bridge;
}
const unregisteredBridge: SyncBridge = {
	fetchLocalPayload: async () => {
		throw new Error("sync bridge not registered");
	},
	pushRemotePayload: async () => {},
	fetchLocalRoster: async () => "",
	pushRemoteRoster: async () => {},
};

// The single live enrollment / sync session for this host context.
let enrollSession: MeshSession | null = null;
let syncSession: MeshSession | null = null;

/** Broadcast a dev-sync status line; the Settings panel listens for SYNC_STATUS. Also logged to the
 * host console (offscreen on Chrome / event page on Firefox), which persists across popup closes -
 * unlike the panel log, which the popup drops when it closes during cross-browser enrollment. */
function reportSyncStatus(status: string): void {
	console.log("[bramble:sync]", status);
	const payload: SyncStatusMsg = { status };
	void api.runtime.sendMessage({ type: "SYNC_STATUS", payload }).catch(() => {});
}

/** Broadcast a structured enrollment event to the popup. */
function broadcastSyncEvent(payload: SyncEventMsg): void {
	void api.runtime.sendMessage({ type: "SYNC_EVENT", payload }).catch(() => {});
}

/** The roster-signing + password-authority admission wasm exports the host calls directly (Item A). */
interface RosterSignWasm {
	roster_sign(secretB64: string, message: string): string;
	roster_admission_public_key(password: string, saltB64: string): string;
	roster_admission_sign(password: string, saltB64: string, message: string): string;
}

/** Everything the offscreen host drives off the one wasm module: the vault-crypto surface plus the
 * sync-transport views (handshake / nostr / roster). The module exports them all; VaultCrypto is
 * intentionally crypto-only (see @core/wasm), so the host composes the full view here — this is why
 * getWasm can hand every case a fully typed module without per-call casts. */
type HostWasm = VaultCrypto &
	RosterSyncWasm &
	EnrollWasm &
	KeypairWasm &
	RosterSigWasm &
	RosterSignWasm;

let wasm: HostWasm | null = null;

async function getWasm(): Promise<HostWasm> {
	// The single module implements every surface above; loadWasm types it as the crypto slice only.
	if (!wasm) wasm = (await loadWasm()) as HostWasm;
	return wasm;
}

// The method->wasm mapping is shared with mobile (@core buildCryptoAdapter); this
// host only owns the IPC concern. No session hooks here — the background owns lock
// state. buildCryptoAdapter is lazy (it only calls getWasm inside its methods), so
// constructing it at import time touches no WASM.
const cryptoAdapter: CryptoAdapter = buildCryptoAdapter(getWasm);

function dispatchCrypto(a: CryptoAdapter, type: string, payload: unknown): Promise<unknown> {
	switch (type) {
		case "CRYPTO_LOCK":
			return a.lock().then(() => null);
		case "CRYPTO_IS_LOCKED":
			return a.isLocked();

		case "CRYPTO_GENERATE_VEK":
			return a.generateVek();
		case "CRYPTO_UNLOCK_WITH_VEK":
			return a.unlockWithVek(CryptoUnlockWithVekSchema.parse(payload).vekB64).then(() => null);
		case "CRYPTO_EXPORT_VEK":
			return a.exportVek();
		case "CRYPTO_ROTATE_VEK":
			return a.rotateVek();

		case "CRYPTO_GENERATE_SALT":
			return a.generateSalt();
		case "CRYPTO_GENERATE_SLOT_ID":
			return a.generateSlotId();

		case "CRYPTO_WRAP_PASSWORD_SLOT": {
			const p = CryptoWrapPasswordSlotSchema.parse(payload);
			return a.wrapVekPassword({
				password: p.password,
				saltB64: p.saltB64,
				slotIdB64: p.slotIdB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}
		case "CRYPTO_UNWRAP_PASSWORD_SLOT": {
			const p = CryptoUnwrapPasswordSlotSchema.parse(payload);
			return a.unwrapVekPassword({
				password: p.password,
				saltB64: p.saltB64,
				slotIdB64: p.slotIdB64,
				verifierB64: p.verifierB64,
				wrapIvB64: p.wrapIvB64,
				wrappedVekB64: p.wrappedVekB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}
		case "CRYPTO_VERIFY_PASSWORD_SLOT": {
			const p = CryptoVerifyPasswordSlotSchema.parse(payload);
			return a.verifyPasswordSlot({
				password: p.password,
				saltB64: p.saltB64,
				slotIdB64: p.slotIdB64,
				verifierB64: p.verifierB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}

		case "CRYPTO_WRAP_WEBAUTHN_SLOT": {
			const p = CryptoWrapWebauthnSlotSchema.parse(payload);
			return a.wrapVekWebauthn({
				hmacSecretB64: p.hmacSecretB64,
				slotIdB64: p.slotIdB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}
		case "CRYPTO_UNWRAP_WEBAUTHN_SLOT": {
			const p = CryptoUnwrapWebauthnSlotSchema.parse(payload);
			return a.unwrapVekWebauthn({
				hmacSecretB64: p.hmacSecretB64,
				slotIdB64: p.slotIdB64,
				verifierB64: p.verifierB64,
				wrapIvB64: p.wrapIvB64,
				wrappedVekB64: p.wrappedVekB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}
		case "CRYPTO_VERIFY_WEBAUTHN_SLOT": {
			const p = CryptoVerifyWebauthnSlotSchema.parse(payload);
			return a.verifyWebauthnSlot({
				hmacSecretB64: p.hmacSecretB64,
				slotIdB64: p.slotIdB64,
				verifierB64: p.verifierB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}

		case "CRYPTO_ENCRYPT":
			return a.encryptEntry(CryptoEncryptSchema.parse(payload).plaintextJson);
		case "CRYPTO_DECRYPT": {
			const p = CryptoDecryptSchema.parse(payload);
			return a.decryptEntry({
				ciphertext: p.ciphertext,
				iv: p.iv,
				wrappedDek: p.wrappedDek,
				dekIv: p.dekIv,
			});
		}
		case "CRYPTO_ENCRYPT_OUTER":
			return a.encryptWithVek(CryptoEncryptOuterSchema.parse(payload).plaintext);
		case "CRYPTO_DECRYPT_OUTER": {
			const p = CryptoDecryptOuterSchema.parse(payload);
			return a.decryptWithVek(p.iv, p.ciphertext);
		}

		case "CRYPTO_OPEN_KDBX": {
			// Foreign KeePass database decrypted entirely in WASM; only mapped
			// key/value pairs come back. Unrelated to the vault VEK.
			const p = CryptoOpenKdbxSchema.parse(payload);
			return a.openKdbx({ fileB64: p.fileB64, password: p.password, keyfileB64: p.keyfileB64 });
		}

		case "CRYPTO_PASSKEY_MAKE": {
			const p = CryptoPasskeyMakeSchema.parse(payload);
			return a.passkeyMakeCredential(p.rpId, p.userVerified);
		}
		case "CRYPTO_PASSKEY_GET": {
			const p = CryptoPasskeyGetSchema.parse(payload);
			return a.passkeyGetAssertion(p.rpId, p.privateKeyB64, p.clientDataHashB64, p.userVerified);
		}

		default:
			throw new Error(`unknown crypto message: ${type}`);
	}
}

// Clear the clipboard after the copy-timeout. We deliberately don't read it back to
// confirm it still holds our value: that would need the clipboardRead permission (a
// user-visible "read data you copy" grant we don't want on a password manager), so
// we clear unconditionally.
export async function clearClipboard(): Promise<boolean> {
	try {
		await navigator.clipboard.writeText("");
		return true;
	} catch {
		return false;
	}
}

/**
 * Decode a single QR code from a PNG data URL via OffscreenCanvas; null if none found.
 * Lives in the host (offscreen document on Chrome, event page on Firefox) rather than
 * the background: jsqr loads via a lazy `import()`, which is reliable in a real document
 * but not from an idle MV3 service worker that has been suspended and restarted.
 */
async function decodeQrDataUrl(dataUrl: string): Promise<string | null> {
	// jsqr is large and only the QR-scan path needs it; keep it lazy so it stays out of
	// the host bundle that re-parses on every cold wake.
	const { default: jsQR } = await import("jsqr");
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return jsQR(data, width, height)?.data ?? null;
}

/**
 * Handle one host message (clipboard / sync / crypto / QR) and return the host response.
 * Sync messages use the registered SyncBridge for their storage round-trips. Never
 * throws — failures come back as `{ ok: false, error }`.
 */
export async function handleHostMessage(type: string, payload: unknown): Promise<HostResponse> {
	const bridge = syncBridge ?? unregisteredBridge;
	try {
		switch (type) {
			case "CLIPBOARD_CLEAR":
				return { ok: true, data: await clearClipboard() };
			case "QR_DECODE": {
				const dataUrl = (payload as { dataUrl?: unknown } | null)?.dataUrl;
				if (typeof dataUrl !== "string") throw new Error("QR_DECODE requires a dataUrl");
				return { ok: true, data: await decodeQrDataUrl(dataUrl) };
			}
			case "SYNC_DISCONNECT":
				enrollSession?.stop();
				enrollSession = null;
				syncSession?.stop();
				syncSession = null;
				reportSyncStatus("disconnected");
				return { ok: true };
			case "SYNC_ROSTER_SYNC": {
				const opts = RosterSyncMsgSchema.parse(payload);
				const w = await getWasm();
				syncSession?.stop();
				syncSession = await startRosterSync({
					...opts,
					wasm: w,
					report: reportSyncStatus,
					fetchLocalPayload: bridge.fetchLocalPayload,
					pushRemotePayload: bridge.pushRemotePayload,
					fetchLocalRoster: bridge.fetchLocalRoster,
					pushRemoteRoster: bridge.pushRemoteRoster,
				});
				return { ok: true };
			}
			case "SYNC_GENERATE_KEYPAIR": {
				// Generate only — the background persists it (the host has no chrome.storage).
				const w = await getWasm();
				return { ok: true, data: w.handshake_generate_keypair() };
			}
			case "SYNC_GENERATE_SIGNING_KEY": {
				// Ed25519 roster-signing keypair (Item A). Generate only; the background persists it.
				const w = await getWasm();
				return { ok: true, data: w.roster_sig_generate_key() };
			}
			case "SYNC_ROSTER_SIGN": {
				// Ed25519-sign a canonical roster-entry string with this device's seed (from the background).
				const w = await getWasm();
				const { secretB64, message } = RosterSignHostMsgSchema.parse(payload);
				return { ok: true, data: w.roster_sign(secretB64, message) };
			}
			case "SYNC_ROSTER_ADMISSION_PUBKEY": {
				// Derive this device's admission verify key from the re-entered master password + slot salt
				// (Item A). Argon2 -> KEK -> HKDF -> Ed25519; the signing key is derived and dropped, never stored.
				const w = await getWasm();
				const { password, saltB64 } = AdmissionPubkeyMsgSchema.parse(payload);
				return { ok: true, data: w.roster_admission_public_key(password, saltB64) };
			}
			case "SYNC_ROSTER_ADMISSION_SIGN": {
				// Admission-sign an admitted device's canonical entry with the password-derived admission key.
				const w = await getWasm();
				const { password, saltB64, message } = AdmissionSignHostMsgSchema.parse(payload);
				return { ok: true, data: w.roster_admission_sign(password, saltB64, message) };
			}
			case "SYNC_ENROLL_INVITE":
			case "SYNC_ENROLL_JOIN": {
				const w = await getWasm();
				const role = type === "SYNC_ENROLL_INVITE" ? "inviter" : "joiner";
				const opts =
					role === "inviter"
						? EnrollInviteMsgSchema.parse(payload)
						: EnrollJoinMsgSchema.parse(payload);
				enrollSession?.stop();
				enrollSession = await startEnroll(role, {
					...opts,
					wasm: w,
					report: reportSyncStatus,
					onJoined: (result) => broadcastSyncEvent({ kind: "joined", ...result }),
					onJoinError: (msg) => broadcastSyncEvent({ kind: "join-error", message: msg }),
					onEnrolled: (entryJson) => broadcastSyncEvent({ kind: "enrolled", entryJson }),
				});
				return { ok: true };
			}
			default: {
				// Everything else is a CRYPTO_* message for the shared adapter; anything else is unknown.
				if (!type.startsWith("CRYPTO_")) {
					throw new Error(`unknown message type: ${type}`);
				}
				const data = await dispatchCrypto(cryptoAdapter, type, payload);
				return { ok: true, data };
			}
		}
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}
