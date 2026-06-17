/// <reference types="chrome" />
import { base64ToBytes } from "@core/util/bytes";
import {
	CryptoDecryptOuterSchema,
	CryptoDecryptSchema,
	CryptoEncryptOuterSchema,
	CryptoEncryptSchema,
	CryptoOpenKdbxSchema,
	CryptoUnlockWithVekSchema,
	CryptoUnwrapPasswordSlotSchema,
	CryptoUnwrapWebauthnSlotSchema,
	CryptoVerifyPasswordSlotSchema,
	CryptoVerifyWebauthnSlotSchema,
	CryptoWrapPasswordSlotSchema,
	CryptoWrapWebauthnSlotSchema,
} from "./crypto/messages";
import { type EnrollWasm, startEnroll } from "./sync/enroll-host";
import {
	type ApplyRemoteMsg,
	EnrollInviteMsgSchema,
	EnrollJoinMsgSchema,
	RosterSyncMsgSchema,
	type SyncEventMsg,
	type SyncStatusMsg,
} from "./sync/messages";
import type { MeshSession } from "./sync/peer-session";
import { type RosterSyncWasm, startRosterSync } from "./sync/roster-sync";
import type { KeypairWasm } from "./sync/sync-config";
import { loadWasm, type VaultCrypto } from "./wasm-loader";

// The single live enrollment / sync session. The session modules are now pure
// (no module-level singleton); this composition root holds the active handle.
let enrollSession: MeshSession | null = null;
let syncSession: MeshSession | null = null;

/** Broadcast a dev-sync status line; the Settings panel listens for SYNC_STATUS. */
function reportSyncStatus(status: string): void {
	const payload: SyncStatusMsg = { status };
	void chrome.runtime.sendMessage({ type: "SYNC_STATUS", payload }).catch(() => {});
}

/** Broadcast a structured enrollment event to the popup. */
function broadcastSyncEvent(payload: SyncEventMsg): void {
	void chrome.runtime.sendMessage({ type: "SYNC_EVENT", payload }).catch(() => {});
}

// Offscreen document: holds the WASM crypto module in a context that survives
// popup close and the service worker's idle-kill. Session state lives in the
// background SW; this page just does WASM.

let wasm: VaultCrypto | null = null;

async function getWasm(): Promise<VaultCrypto> {
	if (!wasm) wasm = await loadWasm();
	return wasm;
}

interface OffscreenMessage {
	target?: string;
	type?: string;
	payload?: any;
}

function dispatchCrypto(crypto: VaultCrypto, type: string, payload: unknown): unknown {
	switch (type) {
		case "CRYPTO_LOCK":
			crypto.lock();
			return null;
		case "CRYPTO_IS_LOCKED":
			return crypto.is_locked();

		case "CRYPTO_GENERATE_VEK":
			return crypto.generate_vek();
		case "CRYPTO_UNLOCK_WITH_VEK":
			crypto.unlock_with_vek(CryptoUnlockWithVekSchema.parse(payload).vekB64);
			return null;
		case "CRYPTO_EXPORT_VEK":
			return crypto.export_vek();
		case "CRYPTO_ROTATE_VEK":
			return crypto.rotate_vek();

		case "CRYPTO_GENERATE_SALT":
			return crypto.generate_salt();
		case "CRYPTO_GENERATE_SLOT_ID":
			return crypto.generate_slot_id();

		case "CRYPTO_WRAP_PASSWORD_SLOT": {
			const p = CryptoWrapPasswordSlotSchema.parse(payload);
			return crypto.wrap_vek_password(
				p.password,
				p.saltB64,
				p.slotIdB64,
				new Uint8Array(p.magicVersion),
			);
		}
		case "CRYPTO_UNWRAP_PASSWORD_SLOT": {
			const p = CryptoUnwrapPasswordSlotSchema.parse(payload);
			return crypto.unwrap_vek_password(
				p.password,
				p.saltB64,
				p.slotIdB64,
				p.verifierB64,
				p.wrapIvB64,
				p.wrappedVekB64,
				new Uint8Array(p.magicVersion),
			);
		}
		case "CRYPTO_VERIFY_PASSWORD_SLOT": {
			const p = CryptoVerifyPasswordSlotSchema.parse(payload);
			return crypto.verify_password_slot(
				p.password,
				p.saltB64,
				p.slotIdB64,
				p.verifierB64,
				new Uint8Array(p.magicVersion),
			);
		}

		case "CRYPTO_WRAP_WEBAUTHN_SLOT": {
			const p = CryptoWrapWebauthnSlotSchema.parse(payload);
			return crypto.wrap_vek_webauthn(p.hmacSecretB64, p.slotIdB64, new Uint8Array(p.magicVersion));
		}
		case "CRYPTO_UNWRAP_WEBAUTHN_SLOT": {
			const p = CryptoUnwrapWebauthnSlotSchema.parse(payload);
			return crypto.unwrap_vek_webauthn(
				p.hmacSecretB64,
				p.slotIdB64,
				p.verifierB64,
				p.wrapIvB64,
				p.wrappedVekB64,
				new Uint8Array(p.magicVersion),
			);
		}
		case "CRYPTO_VERIFY_WEBAUTHN_SLOT": {
			const p = CryptoVerifyWebauthnSlotSchema.parse(payload);
			return crypto.verify_webauthn_slot(
				p.hmacSecretB64,
				p.slotIdB64,
				p.verifierB64,
				new Uint8Array(p.magicVersion),
			);
		}

		case "CRYPTO_ENCRYPT":
			return crypto.encrypt_entry(CryptoEncryptSchema.parse(payload).plaintextJson);
		case "CRYPTO_DECRYPT": {
			const p = CryptoDecryptSchema.parse(payload);
			return crypto.decrypt_entry(p.ciphertext, p.iv, p.wrappedDek, p.dekIv);
		}
		case "CRYPTO_ENCRYPT_OUTER":
			return crypto.encrypt_with_vek(CryptoEncryptOuterSchema.parse(payload).plaintext);
		case "CRYPTO_DECRYPT_OUTER": {
			const p = CryptoDecryptOuterSchema.parse(payload);
			return crypto.decrypt_with_vek(p.iv, p.ciphertext);
		}

		case "CRYPTO_OPEN_KDBX": {
			// Foreign KeePass database decrypted entirely in WASM; only mapped
			// key/value pairs come back. Unrelated to the vault VEK.
			const p = CryptoOpenKdbxSchema.parse(payload);
			const file = base64ToBytes(p.fileB64);
			const keyfile = p.keyfileB64 ? base64ToBytes(p.keyfileB64) : undefined;
			return crypto.open_kdbx4(file, p.password, keyfile);
		}

		default:
			throw new Error(`unknown crypto message: ${type}`);
	}
}

// Clear the clipboard after the copy-timeout. We deliberately don't read it
// back to confirm it still holds our value: that would need the clipboardRead
// permission (a user-visible "read data you copy" grant we don't want on a
// password manager), so we clear unconditionally.
async function clearClipboard(): Promise<boolean> {
	try {
		await navigator.clipboard.writeText("");
		return true;
	} catch {
		return false;
	}
}

// Report the OS colour scheme so the background can pick the matching
// monochrome toolbar icon. The service worker can't read prefers-color-scheme;
// this offscreen document can, and it stays alive to catch later changes.
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
function reportColorScheme(): void {
	void chrome.runtime
		.sendMessage({ type: "THEME_ICON_SET", payload: { dark: colorScheme.matches } })
		.catch(() => {});
}
reportColorScheme();
colorScheme.addEventListener("change", reportColorScheme);

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;

	void (async () => {
		try {
			const msgType = message.type ?? "";
			if (msgType === "CLIPBOARD_CLEAR") {
				sendResponse({ ok: true, data: await clearClipboard() });
				return;
			}
			if (msgType === "SYNC_DISCONNECT") {
				enrollSession?.stop();
				enrollSession = null;
				syncSession?.stop();
				syncSession = null;
				reportSyncStatus("disconnected");
				sendResponse({ ok: true });
				return;
			}
			if (msgType === "SYNC_ROSTER_SYNC") {
				const opts = RosterSyncMsgSchema.parse(message.payload);
				const wasm = (await getWasm()) as unknown as RosterSyncWasm;
				syncSession?.stop();
				syncSession = await startRosterSync({
					...opts,
					wasm,
					report: reportSyncStatus,
					// Local read + merge + write happen in the background (it has storage).
					fetchLocalPayload: async () => {
						const r = await chrome.runtime.sendMessage({ type: "SYNC_LOCAL_PAYLOAD" });
						if (!r?.ok || typeof r.data !== "string") {
							throw new Error(r?.error ?? "local payload unavailable");
						}
						return r.data;
					},
					pushRemotePayload: async (payloadJson: string) => {
						const payload: ApplyRemoteMsg = { payloadJson };
						await chrome.runtime.sendMessage({ type: "SYNC_APPLY_REMOTE", payload });
					},
				});
				sendResponse({ ok: true });
				return;
			}
			if (msgType === "SYNC_GENERATE_KEYPAIR") {
				// Generate only — the background persists it (offscreen has no chrome.storage).
				const wasm = (await getWasm()) as unknown as KeypairWasm;
				sendResponse({ ok: true, data: wasm.handshake_generate_keypair() });
				return;
			}
			if (msgType === "SYNC_ENROLL_INVITE" || msgType === "SYNC_ENROLL_JOIN") {
				const wasm = (await getWasm()) as unknown as EnrollWasm;
				const role = msgType === "SYNC_ENROLL_INVITE" ? "inviter" : "joiner";
				const opts =
					role === "inviter"
						? EnrollInviteMsgSchema.parse(message.payload)
						: EnrollJoinMsgSchema.parse(message.payload);
				enrollSession?.stop();
				enrollSession = await startEnroll(role, {
					...opts,
					wasm,
					report: reportSyncStatus,
					onJoined: (result) => broadcastSyncEvent({ kind: "joined", ...result }),
					onEnrolled: (entryJson) => broadcastSyncEvent({ kind: "enrolled", entryJson }),
				});
				sendResponse({ ok: true });
				return;
			}
			if (!msgType.startsWith("CRYPTO_")) {
				throw new Error(`unknown message type: ${msgType}`);
			}
			const wasmCrypto = await getWasm();
			const data = dispatchCrypto(wasmCrypto, msgType, message.payload);
			sendResponse({ ok: true, data });
		} catch (err) {
			sendResponse({ ok: false, error: String(err) });
		}
	})();
	return true;
});
