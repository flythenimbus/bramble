/// <reference types="chrome" />

// Transport-free crypto + sync host. Runs in the Chrome offscreen document (driven
// by offscreen.ts) or, on Firefox where there is no chrome.offscreen, in the
// background event page (driven by offscreen-client.ts). Touches no DOM and loads no
// WASM at import time so a background service worker can import it safely; the WASM
// module loads lazily on the first crypto op.

// Import from the specific adapter modules, not the @core/index barrel: the barrel
// re-exports the React UI (App/OptionsApp) which pulls in Lingui macros that vitest
// does not compile, and would also bloat the background bundle.
import type {
	CryptoAdapter,
	EncryptedPayload,
	PasswordSlotBlob,
	VekEncrypted,
} from "@core/adapters/crypto";
import { buildCryptoAdapter } from "@core/adapters/crypto-wasm";
import { canonicalRosterEntry, encodeRoster, RosterEntrySchema } from "@core/sync/roster";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { type RosterSyncWasm, startRosterSync } from "@core/sync/transport/roster-sync";
import {
	CryptoDecryptBatchSchema,
	CryptoDecryptOuterSchema,
	CryptoDecryptSchema,
	CryptoEncryptOuterSchema,
	CryptoEncryptSchema,
	CryptoOpenKdbxSchema,
	CryptoOpenPortableVaultSchema,
	CryptoPasskeyGetSchema,
	CryptoPasskeyImportPkcs8Schema,
	CryptoPasskeyMakeSchema,
	CryptoSaveKdbxSchema,
	CryptoSealPortableVaultSchema,
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
	EnrollApproveMsgSchema,
	type EnrollInviteMsg,
	EnrollInviteMsgSchema,
	EnrollJoinMsgSchema,
	type PendingEnrollApproval,
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

/**
 * The pairing approval the host is waiting on, if any. It lives here rather than in the popup
 * because the popup is disposable: it can be closed and reopened (or, on Firefox, be gone
 * entirely) while the joiner sits on an open channel with nothing sent yet. Held state lets a
 * reopened popup pick the prompt back up instead of stranding the joiner until the invite expires.
 */
let pendingApproval: { sas: string; label: string; settle: (approved: boolean) => void } | null =
	null;

/** Answer (and clear) the pending approval. A no-op when there isn't one, which is what a stale
 * click from a popup that reopened after the invite already ended looks like. */
function settleApproval(approved: boolean): void {
	const pending = pendingApproval;
	pendingApproval = null;
	pending?.settle(approved);
}

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
/** The one handshake export the sync transport never needed: it keeps its sessions for the
 * life of the connection, whereas a desktop pairing is a few round trips and then done, so the
 * session has to be released. Declared here rather than widening the shared sync types. */
interface LinkWasm {
	handshake_close(sessionId: number): void;
}

type HostWasm = LinkWasm &
	VaultCrypto &
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

// On the extension the wasm resolves in-process (Awaitable<T> -> T), so "load the vek then
// run the op" is one synchronous section that nothing can interleave — the whole per-vault
// fix. Cast the module to this synchronous view inside those sections and NEVER await between
// the load and the op. See docs/multiple-vaults.md "The atomicity rule".
type SyncVek = {
	unlock_with_vek(vekB64: string): void;
	export_vek(): string;
	wrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): PasswordSlotBlob;
	wrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): PasswordSlotBlob;
	unwrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): boolean;
	unwrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): boolean;
	encrypt_entry(plaintextJson: string): EncryptedPayload;
	decrypt_entry(ciphertext: string, iv: string, wrappedDek: string, dekIv: string): string;
	encrypt_with_vek(plaintext: string): VekEncrypted;
	decrypt_with_vek(iv: string, ciphertext: string): string;
};

/** Load the injected vek (when present) into the scratch slot, then run `op`, as one
 * synchronous section. `vekB64` is absent only for un-tagged legacy callers (removed in
 * increment 6); then the op falls back to whatever the slot holds. */
function withVek<T>(w: SyncVek, vekB64: string | undefined, op: (w: SyncVek) => T): T {
	if (vekB64 !== undefined) w.unlock_with_vek(vekB64);
	return op(w);
}

async function dispatchCrypto(a: CryptoAdapter, type: string, payload: unknown): Promise<unknown> {
	// VEK-scoped ops (USE-VEK + the unwraps) call the wasm module DIRECTLY, not through the
	// shared adapter (whose methods each await getWasm internally, which would let another op's
	// load slip between load and op — the original race reborn). getWasm is awaited up front;
	// everything below it in each case is synchronous.
	switch (type) {
		case "CRYPTO_WRAP_PASSWORD_SLOT": {
			const p = CryptoWrapPasswordSlotSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w.wrap_vek_password(p.password, p.saltB64, p.slotIdB64, new Uint8Array(p.magicVersion)),
			);
		}
		case "CRYPTO_WRAP_WEBAUTHN_SLOT": {
			const p = CryptoWrapWebauthnSlotSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w.wrap_vek_webauthn(p.hmacSecretB64, p.slotIdB64, new Uint8Array(p.magicVersion)),
			);
		}
		case "CRYPTO_ENCRYPT": {
			const p = CryptoEncryptSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.encrypt_entry(p.plaintextJson));
		}
		case "CRYPTO_DECRYPT": {
			const p = CryptoDecryptSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w.decrypt_entry(p.ciphertext, p.iv, p.wrappedDek, p.dekIv),
			);
		}
		case "CRYPTO_DECRYPT_BATCH": {
			// The whole array decrypts inside one withVek section: load the vek once,
			// decrypt every entry, clear once. One offscreen round-trip for the vault.
			const p = CryptoDecryptBatchSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				p.entries.map((e) => w.decrypt_entry(e.ciphertext, e.iv, e.wrappedDek, e.dekIv)),
			);
		}
		case "CRYPTO_ENCRYPT_OUTER": {
			const p = CryptoEncryptOuterSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.encrypt_with_vek(p.plaintext));
		}
		case "CRYPTO_DECRYPT_OUTER": {
			const p = CryptoDecryptOuterSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.decrypt_with_vek(p.iv, p.ciphertext));
		}
		// SET-VEK unwraps: unwrap leaves the recovered vek in the slot and returns only a
		// boolean, so unwrap + export_vek MUST be one synchronous section or the exported vek
		// could be another op's. The background caches vekB64 and strips it back to the boolean.
		case "CRYPTO_UNWRAP_PASSWORD_SLOT": {
			const p = CryptoUnwrapPasswordSlotSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			const ok = w.unwrap_vek_password(
				p.password,
				p.saltB64,
				p.slotIdB64,
				p.verifierB64,
				p.wrapIvB64,
				p.wrappedVekB64,
				new Uint8Array(p.magicVersion),
			);
			return ok ? { ok: true, vekB64: w.export_vek() } : { ok: false };
		}
		case "CRYPTO_UNWRAP_WEBAUTHN_SLOT": {
			const p = CryptoUnwrapWebauthnSlotSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			const ok = w.unwrap_vek_webauthn(
				p.hmacSecretB64,
				p.slotIdB64,
				p.verifierB64,
				p.wrapIvB64,
				p.wrappedVekB64,
				new Uint8Array(p.magicVersion),
			);
			return ok ? { ok: true, vekB64: w.export_vek() } : { ok: false };
		}
	}

	// VEK-independent ops, plus generate/rotate (which return a fresh vek the background caches)
	// and lock/is-locked/unlock (which the background mostly answers off the map). These stay on
	// the shared adapter, unchanged, and match mobile.
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
		case "CRYPTO_VERIFY_WEBAUTHN_SLOT": {
			const p = CryptoVerifyWebauthnSlotSchema.parse(payload);
			return a.verifyWebauthnSlot({
				hmacSecretB64: p.hmacSecretB64,
				slotIdB64: p.slotIdB64,
				verifierB64: p.verifierB64,
				magicVersion: new Uint8Array(p.magicVersion),
			});
		}

		case "CRYPTO_OPEN_KDBX": {
			// Foreign KeePass database decrypted entirely in WASM; only mapped
			// key/value pairs come back. Unrelated to the vault VEK.
			const p = CryptoOpenKdbxSchema.parse(payload);
			return a.openKdbx({ fileB64: p.fileB64, password: p.password, keyfileB64: p.keyfileB64 });
		}

		case "CRYPTO_SAVE_KDBX": {
			// Builds a foreign KeePass database in WASM from already-decrypted entries the
			// caller passed in, under an export password of the user's choosing. Nothing
			// here touches the vault VEK.
			const p = CryptoSaveKdbxSchema.parse(payload);
			if (!a.saveKdbx) throw new Error("KDBX export isn't available here.");
			return a.saveKdbx({ entries: p.entries, password: p.password });
		}

		case "CRYPTO_SEAL_PORTABLE_VAULT": {
			// Seals entries the caller passed in under a key the core generates for that
			// file. Like CRYPTO_SAVE_KDBX it never touches the vault VEK, so no vaultId.
			const p = CryptoSealPortableVaultSchema.parse(payload);
			if (!a.sealPortableVault) throw new Error("Exporting a .bramble isn't available here.");
			return a.sealPortableVault({
				entriesJson: p.entriesJson,
				password: p.password,
				magicVersion: Uint8Array.from(p.magicVersion),
			});
		}

		case "CRYPTO_OPEN_PORTABLE_VAULT": {
			const p = CryptoOpenPortableVaultSchema.parse(payload);
			if (!a.openPortableVault) throw new Error("Opening a .bramble isn't available here.");
			// null (a wrong password) is a normal reply, not an error.
			return a.openPortableVault({
				password: p.password,
				file: p.file,
				magicVersion: Uint8Array.from(p.magicVersion),
			});
		}

		case "CRYPTO_PASSKEY_MAKE": {
			const p = CryptoPasskeyMakeSchema.parse(payload);
			return a.passkeyMakeCredential(p.rpId, p.userVerified);
		}
		case "CRYPTO_PASSKEY_GET": {
			const p = CryptoPasskeyGetSchema.parse(payload);
			return a.passkeyGetAssertion(p.rpId, p.privateKeyB64, p.clientDataHashB64, p.userVerified);
		}
		case "CRYPTO_PASSKEY_IMPORT_PKCS8": {
			const p = CryptoPasskeyImportPkcs8Schema.parse(payload);
			return a.passkeyImportPkcs8(p.pkcs8B64);
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
 * Inviter, host-side: admission-sign a freshly-joined device's entry and add it to the LOCAL roster,
 * in the same host that runs the ongoing sync. The popup does this too (useSyncEnrollment), but on
 * Firefox the event page is kept alive through the enroll while the popup can be gone when enrollment
 * finishes — so its add is lost and the joiner is rejected ("not in roster") when it reconnects for
 * ongoing sync. Doing it here makes the roster write reliable and popup-independent. Idempotent with
 * the UI write (deterministic Ed25519, same canonical entry). Merges as a CRDT union, so it never
 * revokes existing devices. See docs/multiple-vaults.md and docs/p2p-sync-revocation-hardening.md.
 * Exported for tests.
 */
export async function addEnrolledToLocalRoster(
	bridge: SyncBridge,
	admission: { password: string; saltB64: string; adminId: string } | undefined,
	entryJson: string,
): Promise<void> {
	try {
		const entry = RosterEntrySchema.parse(JSON.parse(entryJson));
		let admitted = entry;
		if (admission) {
			const w = await getWasm();
			const sig = w.roster_admission_sign(
				admission.password,
				admission.saltB64,
				canonicalRosterEntry(entry),
			);
			admitted = { ...entry, admission: { by: admission.adminId, sig } };
		}
		await bridge.pushRemoteRoster(encodeRoster({ devices: [admitted], revoked: [] }));
	} catch (err) {
		console.warn("[offscreen] host-side roster add failed", err);
	}
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
				settleApproval(false);
				enrollSession?.stop();
				enrollSession = null;
				syncSession?.stop();
				syncSession = null;
				reportSyncStatus("disconnected");
				return { ok: true };
			case "SYNC_ENROLL_STOP":
				// The pairing window closed: stop listening for a joiner, but leave ongoing sync up.
				// Dismissing the UI is not approval, so any prompt still parked here is a refusal.
				settleApproval(false);
				enrollSession?.stop();
				enrollSession = null;
				reportSyncStatus("invite closed");
				return { ok: true };
			case "SYNC_ENROLL_APPROVE":
				settleApproval(EnrollApproveMsgSchema.parse(payload).approved);
				return { ok: true };
			case "SYNC_ENROLL_PENDING":
				// A reopened popup asking whether a prompt is still outstanding.
				return {
					ok: true,
					data: pendingApproval
						? ({
								sas: pendingApproval.sas,
								label: pendingApproval.label,
							} satisfies NonNullable<PendingEnrollApproval>)
						: null,
				};
			case "SYNC_BROADCAST_NOW":
				// A local vault write landed: push it to peers now instead of at the next tick.
				await syncSession?.broadcastNow?.();
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
			case "LINK_ENROLL_INITIATOR": {
				// Pairing with the desktop app: XXpsk3 keyed on the code the user typed. The
				// background holds the native port but has no WASM, so the handshake runs here
				// and it relays the messages. See background/desktop-link.ts.
				const w = await getWasm();
				const { privateKey, psk } = payload as { privateKey: string; psk: string };
				return { ok: true, data: w.handshake_enroll_initiator(privateKey, psk) };
			}
			case "LINK_START_INITIATOR": {
				// Reconnecting to an already-paired desktop app: KK against its known static key.
				const w = await getWasm();
				const { privateKey, remotePublicKey } = payload as {
					privateKey: string;
					remotePublicKey: string;
				};
				return { ok: true, data: w.handshake_start_initiator(privateKey, remotePublicKey) };
			}
			case "LINK_READ": {
				const w = await getWasm();
				const { sessionId, message } = payload as { sessionId: number; message: string };
				return { ok: true, data: w.handshake_read(sessionId, message) };
			}
			case "LINK_REMOTE_STATIC": {
				// The desktop app's static key, learned during pairing so later KK handshakes
				// have something to authenticate against.
				const w = await getWasm();
				const { sessionId } = payload as { sessionId: number };
				return { ok: true, data: w.handshake_remote_static(sessionId) };
			}
			case "LINK_CLOSE": {
				const w = await getWasm();
				const { sessionId } = payload as { sessionId: number };
				w.handshake_close(sessionId);
				return { ok: true };
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
				// Inviter-only: the material for the host to admission-sign + roster the joiner itself.
				const admission = role === "inviter" ? (opts as EnrollInviteMsg).admission : undefined;
				enrollSession?.stop();
				settleApproval(false); // a new enroll supersedes any prompt left over from the last one
				enrollSession = await startEnroll(role, {
					...opts,
					wasm: w,
					report: reportSyncStatus,
					// Inviter: park the transfer on the user's answer. The joiner is connected and
					// authenticated at this point, but nothing has been sent, and nothing will be
					// unless this resolves true. See docs/p2p-sync.md "Pairing code".
					approve: (sas, label) =>
						new Promise<boolean>((resolve) => {
							pendingApproval = { sas, label, settle: resolve };
							broadcastSyncEvent({ kind: "enroll-approval", sas, label });
						}),
					onSas: (sas) => broadcastSyncEvent({ kind: "sas", sas }),
					// The window closed. Refuse any prompt still parked here (nothing can be sent
					// after this) and tell the UI, which may have lost its own countdown when the
					// popup closed and reopened.
					onInviteExpired: () => {
						settleApproval(false);
						broadcastSyncEvent({ kind: "enroll-expired" });
					},
					onEnrollFailed: (msg) => broadcastSyncEvent({ kind: "enroll-failed", message: msg }),
					onEnrollAttemptFailed: (msg) =>
						broadcastSyncEvent({ kind: "enroll-attempt-failed", message: msg }),
					onJoined: (result) => broadcastSyncEvent({ kind: "joined", ...result }),
					onJoinError: (msg) => broadcastSyncEvent({ kind: "join-error", message: msg }),
					onEnrolled: (entryJson) => {
						// Add to the roster in the host (reliable) AND notify the popup (updates its UI +
						// upgrades the same entry). See addEnrolledToLocalRoster.
						void addEnrolledToLocalRoster(bridge, admission, entryJson);
						broadcastSyncEvent({ kind: "enrolled", entryJson });
					},
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
