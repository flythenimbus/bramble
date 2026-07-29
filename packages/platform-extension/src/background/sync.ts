/// <reference types="chrome" />

// Sync wiring in the background. Enrollment forwards to the offscreen (which owns
// the channel + wasm) with the device key injected. Ongoing sync is background-
// driven: started on unlock, it runs the offscreen roster-sync host continuously
// and serves it the local payload + applies peers' payloads here (the background
// has storage; the offscreen does not). See docs/p2p-sync.md.

import {
	applyRemotePayload,
	decodeEntriesPayload,
	decodeRoster,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
	encodeRoster,
	mergeRemoteRoster,
	SYNC_LAST_SYNCED_KEY,
	type VaultSyncPort,
} from "@core/sync";
import { syncKeyFor } from "@core/sync/sync-keys";
import { encodeVaultBlob, type VaultBlob } from "@core/vault-format";
import { setSyncBridge } from "../offscreen-core";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import {
	AdmissionPubkeyMsgSchema,
	AdmissionSignEntryMsgSchema,
	ApplyRemoteMsgSchema,
	ApplyRosterMsgSchema,
	RosterSignEntryMsgSchema,
	type RosterSyncMsg,
	type SyncEventMsg,
} from "../sync/messages";
import {
	type DeviceKeypair,
	getStoredGroup,
	getStoredIceUrl,
	getStoredKeypair,
	getStoredRelay,
	getStoredSigningKey,
	resolveSyncVault,
	type SigningKeypair,
	type SyncVaultCtx,
	storeGroup,
	storeKeypair,
	storeSigningKey,
} from "../sync/sync-config";
import { keepEventPageAlive, releaseEventPage } from "./event-page-keepalive";
import { sendToOffscreen } from "./offscreen-client";
import { extensionOnly, type MessageEnvelope, on } from "./router";
import { witnessStamps } from "./sync-clock";
import {
	base64ToBytes,
	broadcastVaultChanged,
	bytesToBase64,
	readAndDecodeVault,
	writeVault,
} from "./vault-io";
import * as vekStore from "./vek-store";

// Mirror sync status into the background console too, so it's visible in the easy-to-reach
// service-worker console (Chrome) - the offscreen broadcasts SYNC_STATUS here. On Firefox the host
// runs in this same event page, so reportSyncStatus already logs there. Diagnostic only; doesn't
// consume the message (the popup panel still receives it).
api.runtime.onMessage.addListener((msg: { type?: string; payload?: { status?: string } }) => {
	if (msg?.type === "SYNC_STATUS") console.log("[bramble:sync]", msg.payload?.status ?? "");
	return false;
});

// --- enrollment (forwarded to the offscreen) ---

on(
	"SYNC_DISCONNECT",
	extensionOnly((message) => {
		// Enroll/sync is ending; let the Firefox event page suspend again.
		releaseEventPage();
		return sendToOffscreen(message);
	}),
);

on(
	"SYNC_ENROLL_STOP",
	extensionOnly((message) => {
		// Only the invite is ending. The keepalive was taken for the enroll, so give it back;
		// ongoing sync takes its own (via the alarm) and is unaffected.
		releaseEventPage();
		return sendToOffscreen(message);
	}),
);

// Per-vault sync identity: which vault this device is enrolling/syncing (the active one).
async function requireSyncVault(): Promise<SyncVaultCtx> {
	const ctx = await resolveSyncVault();
	if (!ctx) throw new Error("no active vault");
	return ctx;
}

// Device identity lives here (chrome.storage); the offscreen only generates the keypair. Keyed
// to the active vault so each vault gets its own device identity in its own group.
on(
	"SYNC_DEVICE_PUBKEY",
	extensionOnly(async () => {
		const ctx = await requireSyncVault();
		let kp = await getStoredKeypair(ctx);
		if (!kp) {
			const res = await sendToOffscreen({ type: "SYNC_GENERATE_KEYPAIR" });
			if (!res.ok || !res.data)
				return { ok: false, error: res.error ?? "keypair generation failed" };
			kp = res.data as DeviceKeypair;
			await storeKeypair(kp, ctx);
		}
		return { ok: true, data: kp.publicKey };
	}),
);

const withDeviceKey = async (message: {
	type: string;
	payload?: Record<string, unknown>;
}): Promise<MessageEnvelope> => {
	const ctx = await requireSyncVault();
	const kp = await getStoredKeypair(ctx);
	if (!kp) return { ok: false, error: "no device key — create a group first" };
	// The inviter ships ITS vault's VEK in the bundle; take it from the per-vault map (the scratch
	// slot can't be trusted to export the right one) and refuse if the vault is locked. The joiner
	// doesn't need it (it adopts bundle.vek). See docs/multiple-vaults.md "Enrollment".
	let vekB64: string | undefined;
	if (message.type === "SYNC_ENROLL_INVITE") {
		vekB64 = vekStore.getVek(ctx.vaultId) ?? undefined;
		if (vekB64 === undefined) return { ok: false, error: "unlock this vault first" };
	}
	// Starting an enroll (invite or join): keep Firefox's event page awake so the inviter doesn't
	// suspend while waiting for the joiner's ack (and drop it). No-op on Chrome (persistent offscreen).
	keepEventPageAlive(syncHostSuspends);
	return sendToOffscreen({
		...message,
		payload: {
			...message.payload,
			devicePrivB64: kp.privateKey,
			// The public half too: the inviter needs its own static key to derive the pairing SAS,
			// and it can't recover it from the private key. Harmless on the join path.
			devicePubB64: kp.publicKey,
			...(vekB64 ? { vekB64 } : {}),
		},
	});
};
on("SYNC_ENROLL_INVITE", extensionOnly(withDeviceKey));
on("SYNC_ENROLL_JOIN", extensionOnly(withDeviceKey));

// The user's answer to the pairing prompt, and a read-back for a popup that was closed and
// reopened while the host was still holding a joiner. Pure forwarding: the pending approval
// lives with the enrollment session in the offscreen.
on(
	"SYNC_ENROLL_APPROVE",
	extensionOnly((message) => sendToOffscreen(message)),
);
on(
	"SYNC_ENROLL_PENDING",
	extensionOnly((message) => sendToOffscreen(message)),
);

// Ed25519 roster-signing identity (Item A). The key is generated in the offscreen (has the wasm)
// and persisted here (has chrome.storage), mirroring the Noise keypair. See docs/p2p-sync-revocation-hardening.md.
on(
	"SYNC_SIGNING_PUBKEY",
	extensionOnly(async () => {
		const ctx = await requireSyncVault();
		let kp = await getStoredSigningKey(ctx);
		if (!kp) {
			const res = await sendToOffscreen({ type: "SYNC_GENERATE_SIGNING_KEY" });
			if (!res.ok || !res.data)
				return { ok: false, error: res.error ?? "signing key generation failed" };
			kp = res.data as SigningKeypair;
			await storeSigningKey(kp, ctx);
		}
		return { ok: true, data: kp.publicKey };
	}),
);
on(
	"SYNC_SIGN_ENTRY",
	extensionOnly(async (message) => {
		const kp = await getStoredSigningKey(await requireSyncVault());
		if (!kp) return { ok: false, error: "no signing key — create or join a group first" };
		const { canonical } = RosterSignEntryMsgSchema.parse(message.payload);
		return sendToOffscreen({
			type: "SYNC_ROSTER_SIGN",
			payload: { secretB64: kp.secretKey, message: canonical },
		});
	}),
);

// Password-authority admission (Item A rogue-injection close): the admission key is derived in the
// offscreen (has the wasm) from the re-entered master password + the device's password-slot salt,
// and is NEVER persisted — unlike the Ed25519 signing key above. The background only forwards.
on(
	"SYNC_ADMISSION_PUBKEY",
	extensionOnly(async (message) => {
		const { password, saltB64 } = AdmissionPubkeyMsgSchema.parse(message.payload);
		return sendToOffscreen({
			type: "SYNC_ROSTER_ADMISSION_PUBKEY",
			payload: { password, saltB64 },
		});
	}),
);
on(
	"SYNC_ADMISSION_SIGN",
	extensionOnly(async (message) => {
		const { password, saltB64, canonical } = AdmissionSignEntryMsgSchema.parse(message.payload);
		return sendToOffscreen({
			type: "SYNC_ROSTER_ADMISSION_SIGN",
			payload: { password, saltB64, message: canonical },
		});
	}),
);

// --- ongoing sync (background-driven) ---

// Firefox has no persistent offscreen document; its background event page suspends when
// idle, which kills the relay-forward receive loop (the relay stores nothing, so a peer's
// broadcasts are lost while we're suspended). A repeating alarm wakes the event page so the
// background re-runs and reconnects, catching up on peers' changes. Chrome runs sync in the
// offscreen document (persistent), so it doesn't need this. See docs/firefox-port.md.
export const SYNC_KEEPALIVE_ALARM = "sync-keepalive";
const syncHostSuspends = typeof api.offscreen === "undefined";
// Guards against re-starting an already-running session within one event-page/SW lifetime
// (top-level resume, unlock, and the keepalive alarm can all fire in one lifetime). A fresh
// lifetime (after a suspend) resets it, so a woken event page reconnects.
let syncRunning = false;

/** Start the roster-sync host if the active vault is enrolled. Caller ensures unlocked. */
export async function maybeStartSync(): Promise<void> {
	const ctx = await resolveSyncVault();
	if (!ctx) return;
	const group = await getStoredGroup(ctx);
	const kp = await getStoredKeypair(ctx);
	if (!group || !kp) return;
	if (syncRunning) return;
	syncRunning = true;
	if (syncHostSuspends) api.alarms.create(SYNC_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
	const payload: RosterSyncMsg = {
		relayUrl: await getStoredRelay(),
		iceUrl: await getStoredIceUrl(),
		groupKeyB64: group.groupKey,
		roster: group.roster,
		devicePrivB64: kp.privateKey,
		devicePubB64: kp.publicKey,
	};
	await sendToOffscreen({ type: "SYNC_ROSTER_SYNC", payload });
}

export async function stopSync(): Promise<void> {
	syncRunning = false;
	if (syncHostSuspends) await api.alarms.clear(SYNC_KEEPALIVE_ALARM);
	await sendToOffscreen({ type: "SYNC_DISCONNECT" }).catch(() => {});
}

// Read + decrypt the active vault's outer blob. Returns the blob (for its slots, carried
// forward on write) alongside the decrypted payload (empty for a fresh vault).
async function readLocalState(
	ctx: SyncVaultCtx,
): Promise<{ blob: VaultBlob; payload: EntriesPayload }> {
	const blob = await readAndDecodeVault(ctx.vaultId);
	if (blob.entriesCiphertext.length === 0) return { blob, payload: emptyEntriesPayload() };
	const dec = await sendToOffscreen({
		type: "CRYPTO_DECRYPT_OUTER",
		vaultId: ctx.vaultId,
		payload: {
			iv: bytesToBase64(blob.entriesIv),
			ciphertext: bytesToBase64(blob.entriesCiphertext),
		},
	});
	if (!dec.ok || typeof dec.data !== "string") throw new Error(dec.error ?? "outer decrypt failed");
	return { blob, payload: decodeEntriesPayload(dec.data) };
}

// The host side of the merge seam: read/witness/re-seal happen here (storage + the
// offscreen's VEK); applyRemotePayload owns the order. readLocal runs before
// writeMerged, so the slots captured there are current.
function makeVaultSyncPort(ctx: SyncVaultCtx): VaultSyncPort {
	let slots: VaultBlob["slots"] = [];
	return {
		async readLocal() {
			const { blob, payload } = await readLocalState(ctx);
			slots = blob.slots;
			return payload;
		},
		witnessRemote: (stamps) => witnessStamps(stamps),
		async writeMerged(merged) {
			const enc = await sendToOffscreen({
				type: "CRYPTO_ENCRYPT_OUTER",
				vaultId: ctx.vaultId,
				payload: { plaintext: encodeEntriesPayload(merged) },
			});
			if (!enc.ok || !enc.data) throw new Error(enc.error ?? "outer encrypt failed");
			const { iv, ciphertext } = enc.data as { iv: string; ciphertext: string };
			const newBlob = encodeVaultBlob({
				slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			});
			await writeVault(newBlob, ctx.vaultId);
			await broadcastVaultChanged();
		},
	};
}

// The four storage round-trips the roster-sync host needs. Defined as plain
// functions so they can be both registered on the router (Chrome: the offscreen
// document messages the background) and handed to the in-process bridge (Firefox:
// the host runs in this event page). See offscreen-core SyncBridge.

/** The active vault's current payload, to send to peers. */
async function syncLocalPayload(): Promise<string> {
	const ctx = await resolveSyncVault();
	if (!ctx) return encodeEntriesPayload(emptyEntriesPayload());
	const { payload } = await readLocalState(ctx);
	return encodeEntriesPayload(payload);
}

let lastSyncStampAt = 0;

/** A peer's payload arrived: merge into the active vault. Returns whether it changed. */
async function syncApplyRemote(payloadJson: string): Promise<boolean> {
	const ctx = await resolveSyncVault();
	if (!ctx) return false;
	const remote = decodeEntriesPayload(payloadJson);
	const { changed } = await applyRemotePayload(makeVaultSyncPort(ctx), remote);
	// Every reconcile (changed or no-op) means "we're up to date with a peer". Peers rebroadcast
	// every few seconds, so throttle the stamp to ~30s to avoid churn (each write wakes the Sync
	// UI via storage.onChanged). The UI live-reads this via subscribeMeta. Per-vault so each vault's
	// "last synced" is its own.
	const now = Date.now();
	if (now - lastSyncStampAt >= 30_000) {
		lastSyncStampAt = now;
		await extensionStorage.setMeta(syncKeyFor(SYNC_LAST_SYNCED_KEY, ctx.vaultId), now);
	}
	return changed;
}

/** The active vault's roster, to gossip alongside entries. */
async function syncLocalRoster(): Promise<string> {
	const ctx = await resolveSyncVault();
	if (!ctx) return "";
	const group = await getStoredGroup(ctx);
	return group ? encodeRoster(group.roster) : "";
}

/** A peer's roster arrived: merge revocations/additions, persist, and nudge the popup. */
async function syncApplyRoster(rosterJson: string): Promise<void> {
	const ctx = await resolveSyncVault();
	if (!ctx) return;
	const group = await getStoredGroup(ctx);
	if (!group) return;
	await storeGroup(
		{
			groupKey: group.groupKey,
			roster: mergeRemoteRoster(group.roster, decodeRoster(rosterJson)),
		},
		ctx,
	);
	api.runtime
		.sendMessage({ type: "SYNC_EVENT", payload: { kind: "roster" } satisfies SyncEventMsg })
		.catch(() => {});
}

on(
	"SYNC_LOCAL_PAYLOAD",
	extensionOnly(async () => ({ ok: true, data: await syncLocalPayload() })),
);
on(
	"SYNC_APPLY_REMOTE",
	extensionOnly(async (message) => ({
		ok: true,
		data: await syncApplyRemote(ApplyRemoteMsgSchema.parse(message.payload).payloadJson),
	})),
);
on(
	"SYNC_LOCAL_ROSTER",
	extensionOnly(async () => ({ ok: true, data: await syncLocalRoster() })),
);
on(
	"SYNC_APPLY_ROSTER",
	extensionOnly(async (message) => {
		await syncApplyRoster(ApplyRosterMsgSchema.parse(message.payload).rosterJson);
		return { ok: true };
	}),
);

// Firefox: no offscreen document, so the roster-sync host runs in this event page
// and calls these directly instead of round-tripping through runtime messaging.
setSyncBridge({
	fetchLocalPayload: syncLocalPayload,
	pushRemotePayload: (payloadJson) => syncApplyRemote(payloadJson).then(() => {}),
	fetchLocalRoster: syncLocalRoster,
	pushRemoteRoster: syncApplyRoster,
});
