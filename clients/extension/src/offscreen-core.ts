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
import { decodeEntriesPayload } from "@core/sync/entries-payload";
import { canonicalRosterEntry, encodeRoster, RosterEntrySchema } from "@core/sync/roster";
import { blobLinkDialer } from "@core/sync/transport/blob-link";
import {
	type BlobSyncSession,
	startBlobSync,
	wantedFromPayload,
} from "@core/sync/transport/blob-sync";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { type RosterSyncWasm, startRosterSync } from "@core/sync/transport/roster-sync";
import { base64ToBytes } from "@core/util/bytes";
import {
	CryptoDecryptBatchSchema,
	CryptoDecryptIndexSchema,
	CryptoDecryptOuterSchema,
	CryptoDecryptSchema,
	CryptoEncryptOuterSchema,
	CryptoEncryptSchema,
	CryptoFileMetaSchema,
	CryptoFileOpenSchema,
	CryptoFileResealMetaSchema,
	CryptoFileSealSchema,
	CryptoMailboxIdSchema,
	CryptoMailboxOpenSchema,
	CryptoMailboxSealSchema,
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
import {
	type FileWasm,
	type KdbxWasm,
	openToHandoff,
	saveKdbxToHandoff,
	sealFromHandoff,
} from "./files/host";
import { idbBlobStore, putHandoff, readHandoff } from "./files/idb";
import { type HttpJobRequest, pollHttpJob, startHttpJob } from "./http-host";
import { makeLinkPeerSource } from "./link-peer-source";
import { api } from "./platform-api";
import {
	AdmissionPubkeyMsgSchema,
	AdmissionSignHostMsgSchema,
	BlobStatusMsgSchema,
	EnrollApproveMsgSchema,
	type EnrollInviteMsg,
	EnrollInviteMsgSchema,
	EnrollJoinMsgSchema,
	type PendingEnrollApproval,
	RosterSignHostMsgSchema,
	RosterStopMsgSchema,
	type RosterSyncMsg,
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
	fetchLocalPayload: (vaultId: string) => Promise<string>;
	pushRemotePayload: (vaultId: string, payloadJson: string) => Promise<void>;
	fetchLocalRoster: (vaultId: string) => Promise<string>;
	pushRemoteRoster: (vaultId: string, rosterJson: string) => Promise<void>;
	/** An attachment arrived from a peer: a backup that was waiting for it can run now. */
	blobArrived?: () => void;
	/** Frames to the desktop app over the native link, which the background owns. Bridged rather
	 * than messaged, because on Firefox this host IS the background, and a page's own
	 * runtime.sendMessage never reaches its own listeners. False when the link is down. */
	linkSend?: (frame: string) => Promise<boolean>;
	linkBlobSend?: (stream: number, frame: string) => Promise<boolean>;
	/** Whether a link is up to an app that speaks files. */
	linkBlobUp?: () => Promise<boolean>;
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
 * The second sync session, over the native link to the desktop app on this machine.
 *
 * Separate from `syncSession` rather than a combined peer source, because they are different
 * transports with different failure modes: a relay outage should not take the local pipe down
 * with it, and the pipe works with no network at all. They need no coordination, since the merge
 * they both feed is serialised in the background.
 */
let linkSyncSession: MeshSession | null = null;
/**
 * The attachment session beside entry sync: WebRTC only (direct or TURN), never the signalling relay
 * (see @core/sync/transport/blob-sync). Absent on Firefox in effect, whose host has no WebRTC, so
 * its mesh finds no peer it may use; there the desktop app's local link is the only way in.
 */
let blobSession: BlobSyncSession | null = null;

/**
 * The config the live sync sessions were started with. A repeat SYNC_ROSTER_SYNC carrying the same
 * config keeps those sessions rather than replacing them.
 *
 * On Chrome the background is a service worker that suspends after seconds of idle and restarts on
 * any event — including the storage round-trips and status broadcasts sync itself sends it. Its
 * "already running" flag is worker-local, so every restart re-sent this message, and this handler
 * used to tear down healthy relay + WebRTC sessions and rebuild them. Peer discovery and the Noise
 * handshake both have to outlive a single worker lifetime, so they mostly didn't: peers went stale
 * mid-handshake and an edit made in the browser never reached the phone.
 *
 * The roster is deliberately not part of the key: it is read fresh per use (fetchLocalRoster), and
 * roster gossip rewrites it constantly, so keying on it would restart-loop the sessions doing the
 * gossiping. Nor is the device private key, since the public half already identifies the keypair
 * and there is no reason to keep a second copy of secret material in a module global.
 */
let syncConfigKey: string | null = null;
/** The vault the live sync sessions serve. */
let syncSessionVaultId: string | null = null;

/**
 * Serializes the start/stop of those sessions. Two SYNC_ROSTER_SYNCs arriving together (a service
 * worker waking twice in quick succession) would otherwise both pass the idempotence check while
 * the first was still awaiting the wasm, and leak a session neither of them holds. A SYNC_DISCONNECT
 * joins the same chain so it can't be overtaken by a start it was meant to cancel.
 */
let rosterSyncInFlight: Promise<void> = Promise.resolve();

function rosterSyncConfigKey(opts: RosterSyncMsg): string {
	return JSON.stringify([
		opts.vaultId,
		opts.relayUrl,
		opts.iceUrl ?? "",
		opts.groupKeyB64,
		opts.devicePubB64,
	]);
}

/** Tear down both sync sessions and forget their config. */
function stopSyncSessions(): void {
	syncSession?.stop();
	syncSession = null;
	linkSyncSession?.stop();
	linkSyncSession = null;
	blobSession?.stop();
	blobSession = null;
	syncConfigKey = null;
	syncSessionVaultId = null;
}

/**
 * Start the continuous sync sessions, or keep the running ones when they already match `opts`.
 * Idempotent by design; see syncConfigKey.
 */
async function startSyncSessions(opts: RosterSyncMsg, bridge: SyncBridge): Promise<void> {
	const key = rosterSyncConfigKey(opts);
	// Already syncing this group over this relay as this device: leave the live sessions alone.
	if (syncSession && linkSyncSession && syncConfigKey === key) return;
	const w = await getWasm();
	stopSyncSessions();
	const common = {
		...opts,
		wasm: w,
		report: reportSyncStatus,
		// Every callback names the vault this session was started for, never "the active one".
		fetchLocalPayload: () => bridge.fetchLocalPayload(opts.vaultId),
		// A merge can name attachments this device lacks, so the file session looks again after.
		pushRemotePayload: async (json: string) => {
			await bridge.pushRemotePayload(opts.vaultId, json);
			blobSession?.poke();
		},
		fetchLocalRoster: () => bridge.fetchLocalRoster(opts.vaultId),
		pushRemoteRoster: (json: string) => bridge.pushRemoteRoster(opts.vaultId, json),
	};
	syncSession = await startRosterSync(common);
	// The desktop app on this machine, over the pipe it already has. Started second so
	// a relay failure does not cost the local peer, which is the one that works offline.
	linkSyncSession = await startRosterSync({
		...common,
		peerSource: makeLinkPeerSource({
			send: (frame) => bridge.linkSend?.(frame) ?? Promise.resolve(false),
			subscribe: (onFrame) => {
				linkFrameSinks.add(onFrame);
				return () => linkFrameSinks.delete(onFrame);
			},
		}),
	});
	blobSession = await startBlobSync({
		...common,
		blobs: idbBlobStore(opts.vaultId),
		wanted: async () =>
			wantedFromPayload(decodeEntriesPayload(await bridge.fetchLocalPayload(opts.vaultId))),
		onReceived: () => bridge.blobArrived?.(),
		// Direct connections need WebRTC, which no Firefox extension context has. There the
		// desktop app's link is the only path a file has to this browser.
		relay: typeof RTCPeerConnection !== "undefined",
		localSources: [
			blobLinkDialer({
				up: () => bridge.linkBlobUp?.() ?? Promise.resolve(false),
				send: (stream, frame) => bridge.linkBlobSend?.(stream, frame) ?? Promise.resolve(false),
				subscribe: (handlers) => {
					linkBlobSinks.add(handlers);
					return () => linkBlobSinks.delete(handlers);
				},
			}),
		],
	});
	// Recorded only once all are up, so a half-started set is rebuilt rather than kept.
	syncConfigKey = key;
	syncSessionVaultId = opts.vaultId;
}

/** Sinks for frames the desktop app sends, delivered here by the background. */
const linkFrameSinks = new Set<(frame: string) => void>();
/** The same for its file frames and pokes. */
const linkBlobSinks = new Set<{ frame(stream: number, frame: string): void; poke(): void }>();

/**
 * The pairing approval the host is waiting on, if any. It lives here rather than in the popup
 * because the popup is disposable: it can be closed and reopened (or, on Firefox, be gone
 * entirely) while the joiner sits on an open channel with nothing sent yet. Held state lets a
 * reopened popup pick the prompt back up instead of stranding the joiner until the invite expires.
 */
let pendingApproval: {
	sas: string;
	sasEmoji: number[];
	label: string;
	settle: (approved: boolean) => void;
} | null = null;

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
	handshake_encrypt(sessionId: number, plaintext: string): string;
	handshake_decrypt(sessionId: number, ciphertextB64: string): string;
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
	/** One VEK section for many entries; a failed entry is null. */
	decrypt_entries(entries: EncryptedPayload[]): (string | null)[];
	encrypt_with_vek(plaintext: string): VekEncrypted;
	decrypt_with_vek(iv: string, ciphertext: string): string;
	mailbox_id(groupKeyB64: string): string;
	mailbox_seal(groupKeyB64: string, aad: string, plaintext: string): string;
	mailbox_open(groupKeyB64: string, aad: string, sealedB64: string): string;
	open_file_meta(wrappedFek: string, fekIv: string, metaBlob: string, metaIv: string): string;
	reseal_file_meta(wrappedFek: string, fekIv: string, metaJson: string): VekEncrypted;
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
				w.decrypt_entries(
					p.entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({
						ciphertext,
						iv,
						wrappedDek,
						dekIv,
					})),
				),
			);
		}
		case "CRYPTO_CHECK_ENTRIES": {
			// Verdicts only: plaintext never leaves this document for an admission check.
			const p = CryptoDecryptBatchSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w
					.decrypt_entries(
						p.entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({
							ciphertext,
							iv,
							wrappedDek,
							dekIv,
						})),
					)
					.map((pt) => pt != null),
			);
		}
		case "CRYPTO_DECRYPT_INDEX": {
			const p = CryptoDecryptIndexSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				p.entries.map((e) => {
					try {
						return {
							id: e.id,
							plaintext: w.decrypt_entry(e.ciphertext, e.iv, e.wrappedDek, e.dekIv),
						};
					} catch {
						return { id: e.id, plaintext: null };
					}
				}),
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
		case "CRYPTO_MAILBOX_ID": {
			const p = CryptoMailboxIdSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.mailbox_id(p.groupKeyB64));
		}
		case "CRYPTO_MAILBOX_SEAL": {
			const p = CryptoMailboxSealSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.mailbox_seal(p.groupKeyB64, p.aad, p.plaintext));
		}
		case "CRYPTO_MAILBOX_OPEN": {
			const p = CryptoMailboxOpenSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.mailbox_open(p.groupKeyB64, p.aad, p.sealedB64));
		}
		// File attachments: the bytes stay in IndexedDB (files/host.ts). The two streaming ops
		// take the vek only to construct, so they may await between chunks; the metadata ops are
		// one synchronous section like the rest.
		case "CRYPTO_FILE_SEAL": {
			const p = CryptoFileSealSchema.parse(payload);
			const sealed = await sealFromHandoff((await getWasm()) as unknown as FileWasm, p);
			blobSession?.poke();
			return sealed;
		}
		case "CRYPTO_FILE_OPEN": {
			const p = CryptoFileOpenSchema.parse(payload);
			return openToHandoff((await getWasm()) as unknown as FileWasm, p);
		}
		case "CRYPTO_FILE_META": {
			const p = CryptoFileMetaSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w.open_file_meta(p.wrappedFek, p.fekIv, p.metaBlob, p.metaIv),
			);
		}
		case "CRYPTO_FILE_RESEAL_META": {
			const p = CryptoFileResealMetaSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) => w.reseal_file_meta(p.wrappedFek, p.fekIv, p.metaJson));
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
			// Foreign KeePass database decrypted entirely in WASM. Unrelated to the vault VEK. The
			// entries come back in the reply; each attachment is parked in a handoff of its own,
			// which the view drops once the import has sealed it.
			const p = CryptoOpenKdbxSchema.parse(payload);
			const file = await readHandoff(p.handoff);
			if (!file) throw new Error("the database to import is no longer staged");
			const opened = await a.openKdbx({
				file: new Uint8Array(await file.arrayBuffer()),
				password: p.password,
				keyfile: p.keyfileB64 ? base64ToBytes(p.keyfileB64) : undefined,
			});
			const attachments: { token: string; size: number }[] = [];
			for (const { source, size } of opened.attachments) {
				if (source.kind !== "blob") throw new Error("expected the attachment as a Blob");
				attachments.push({ token: await putHandoff(source.blob), size });
			}
			return { entries: opened.entries, attachments };
		}

		case "CRYPTO_SAVE_KDBX": {
			// A foreign KeePass database, under an export password of the user's choosing: the
			// entries the caller decrypted, and each attachment opened here under the vault's key.
			// Written into a handoff a piece at a time, so its size is not this document's limit.
			const p = CryptoSaveKdbxSchema.parse(payload);
			return saveKdbxToHandoff((await getWasm()) as unknown as KdbxWasm, p);
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
			return a.passkeyGetAssertion(
				p.rpId,
				p.privateKeyB64,
				p.alg,
				p.clientDataHashB64,
				p.userVerified,
			);
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
	vaultId: string,
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
		await bridge.pushRemoteRoster(vaultId, encodeRoster({ devices: [admitted], revoked: [] }));
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
			// A long request the background cannot make itself (see http-host.ts). Not CRYPTO_*:
			// it carries no key, and the router still admits only extension contexts.
			case "HTTP_JOB_START":
				return { ok: true, data: await startHttpJob(payload as HttpJobRequest) };
			case "HTTP_JOB_POLL":
				return { ok: true, data: pollHttpJob(String((payload as { id?: unknown })?.id ?? "")) };
			case "QR_DECODE": {
				const dataUrl = (payload as { dataUrl?: unknown } | null)?.dataUrl;
				if (typeof dataUrl !== "string") throw new Error("QR_DECODE requires a dataUrl");
				return { ok: true, data: await decodeQrDataUrl(dataUrl) };
			}
			case "SYNC_DISCONNECT": {
				settleApproval(false);
				enrollSession?.stop();
				enrollSession = null;
				// Queued behind any start still in flight, so it can't leave one running. See rosterSyncInFlight.
				const stopping = rosterSyncInFlight.then(() => stopSyncSessions());
				rosterSyncInFlight = stopping.catch(() => {});
				await stopping;
				reportSyncStatus("disconnected");
				return { ok: true };
			}
			case "SYNC_ROSTER_STOP": {
				// A vault switch: stop roster sync for any other vault, and leave a pairing in progress alone.
				const { keepVaultId } = RosterStopMsgSchema.parse(payload);
				const stopping = rosterSyncInFlight.then(() => {
					if (syncSessionVaultId !== null && syncSessionVaultId !== keepVaultId) stopSyncSessions();
				});
				rosterSyncInFlight = stopping.catch(() => {});
				await stopping;
				return { ok: true };
			}
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
								sasEmoji: pendingApproval.sasEmoji,
								label: pendingApproval.label,
							} satisfies NonNullable<PendingEnrollApproval>)
						: null,
				};
			case "SYNC_BROADCAST_NOW":
				// A local vault write landed: push it to peers now instead of at the next tick.
				// Both transports, or an edit would reach the phone at once and the browser's own
				// desktop app only at its next tick.
				await syncSession?.broadcastNow?.();
				await linkSyncSession?.broadcastNow?.();
				// The write may have attached a file: say so to file peers now, too.
				blobSession?.poke();
				return { ok: true };
			case "BLOB_STATUS": {
				// For the attachment rows. Only the vault this session serves: another vault's
				// files can't be coming in, and saying why would be about the wrong vault.
				const { vaultId, hashes } = BlobStatusMsgSchema.parse(payload);
				if (!blobSession || syncSessionVaultId !== vaultId) return { ok: true, data: null };
				return { ok: true, data: await blobSession.status(hashes) };
			}
			case "LINK_SYNC_FRAME": {
				// A frame the desktop app pushed, relayed in by the background, which owns the port.
				const frame = (payload as { frame?: unknown } | null)?.frame;
				if (typeof frame !== "string") throw new Error("LINK_SYNC_FRAME requires a frame");
				for (const sink of linkFrameSinks) sink(frame);
				return { ok: true };
			}
			case "LINK_BLOB_FRAME": {
				const { stream, frame } = (payload ?? {}) as { stream?: unknown; frame?: unknown };
				if (typeof stream !== "number" || typeof frame !== "string") {
					throw new Error("LINK_BLOB_FRAME requires a stream and a frame");
				}
				for (const sink of linkBlobSinks) sink.frame(stream, frame);
				return { ok: true };
			}
			case "LINK_BLOB_POKE":
				for (const sink of linkBlobSinks) sink.poke();
				return { ok: true };
			case "SYNC_ROSTER_SYNC": {
				const opts = RosterSyncMsgSchema.parse(payload);
				const starting = rosterSyncInFlight.then(() => startSyncSessions(opts, bridge));
				rosterSyncInFlight = starting.catch(() => {});
				await starting;
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
			case "LINK_SEAL": {
				// Application traffic over the established session. The proxy relays these
				// without being able to read them, which is what keeps it an untrusted relay.
				const w = await getWasm();
				const { sessionId, plaintext } = payload as { sessionId: number; plaintext: string };
				return { ok: true, data: w.handshake_encrypt(sessionId, plaintext) };
			}
			case "LINK_OPEN": {
				const w = await getWasm();
				const { sessionId, sealed } = payload as { sessionId: number; sealed: string };
				return { ok: true, data: w.handshake_decrypt(sessionId, sealed) };
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
				const inviteVaultId = role === "inviter" ? (opts as EnrollInviteMsg).vaultId : undefined;
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
							pendingApproval = { sas: sas.digits, sasEmoji: sas.emoji, label, settle: resolve };
							broadcastSyncEvent({
								kind: "enroll-approval",
								sas: sas.digits,
								sasEmoji: sas.emoji,
								label,
							});
						}),
					onSas: (sas) => broadcastSyncEvent({ kind: "sas", sas: sas.digits, sasEmoji: sas.emoji }),
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
						if (inviteVaultId)
							void addEnrolledToLocalRoster(bridge, inviteVaultId, admission, entryJson);
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
