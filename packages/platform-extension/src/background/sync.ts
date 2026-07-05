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
	mergeRosters,
	type VaultSyncPort,
} from "@core/sync";
import { encodeVaultBlob, type VaultBlob } from "@core/vault-format";
import { setSyncBridge } from "../offscreen-core";
import { api } from "../platform-api";
import {
	ApplyRemoteMsgSchema,
	ApplyRosterMsgSchema,
	type RosterSyncMsg,
	type SyncEventMsg,
} from "../sync/messages";
import {
	type DeviceKeypair,
	getStoredGroup,
	getStoredIceUrl,
	getStoredKeypair,
	getStoredRelay,
	storeGroup,
	storeKeypair,
} from "../sync/sync-config";
import { sendToOffscreen } from "./offscreen-client";
import { type MessageEnvelope, on } from "./router";
import { witnessStamps } from "./sync-clock";
import {
	base64ToBytes,
	broadcastVaultChanged,
	bytesToBase64,
	readAndDecodeVault,
	writeVault,
} from "./vault-io";

// --- enrollment (forwarded to the offscreen) ---

on("SYNC_DISCONNECT", (message) => sendToOffscreen(message));

// Device identity lives here (chrome.storage); the offscreen only generates the keypair.
on("SYNC_DEVICE_PUBKEY", async () => {
	let kp = await getStoredKeypair();
	if (!kp) {
		const res = await sendToOffscreen({ type: "SYNC_GENERATE_KEYPAIR" });
		if (!res.ok || !res.data) return { ok: false, error: res.error ?? "keypair generation failed" };
		kp = res.data as DeviceKeypair;
		await storeKeypair(kp);
	}
	return { ok: true, data: kp.publicKey };
});

const withDeviceKey = async (message: {
	type: string;
	payload?: Record<string, unknown>;
}): Promise<MessageEnvelope> => {
	const kp = await getStoredKeypair();
	if (!kp) return { ok: false, error: "no device key — create a group first" };
	return sendToOffscreen({
		...message,
		payload: { ...message.payload, devicePrivB64: kp.privateKey },
	});
};
on("SYNC_ENROLL_INVITE", withDeviceKey);
on("SYNC_ENROLL_JOIN", withDeviceKey);

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

/** Start the roster-sync host if this device is enrolled. Caller ensures unlocked. */
export async function maybeStartSync(): Promise<void> {
	const group = await getStoredGroup();
	const kp = await getStoredKeypair();
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

// Read + decrypt the local outer blob. Returns the blob (for its slots, carried
// forward on write) alongside the decrypted payload (empty for a fresh vault).
async function readLocalState(): Promise<{ blob: VaultBlob; payload: EntriesPayload }> {
	const blob = await readAndDecodeVault();
	if (blob.entriesCiphertext.length === 0) return { blob, payload: emptyEntriesPayload() };
	const dec = await sendToOffscreen({
		type: "CRYPTO_DECRYPT_OUTER",
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
function makeVaultSyncPort(): VaultSyncPort {
	let slots: VaultBlob["slots"] = [];
	return {
		async readLocal() {
			const { blob, payload } = await readLocalState();
			slots = blob.slots;
			return payload;
		},
		witnessRemote: (stamps) => witnessStamps(stamps),
		async writeMerged(merged) {
			const enc = await sendToOffscreen({
				type: "CRYPTO_ENCRYPT_OUTER",
				payload: { plaintext: encodeEntriesPayload(merged) },
			});
			if (!enc.ok || !enc.data) throw new Error(enc.error ?? "outer encrypt failed");
			const { iv, ciphertext } = enc.data as { iv: string; ciphertext: string };
			const newBlob = encodeVaultBlob({
				slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			});
			await writeVault(newBlob);
			await broadcastVaultChanged();
		},
	};
}

// The four storage round-trips the roster-sync host needs. Defined as plain
// functions so they can be both registered on the router (Chrome: the offscreen
// document messages the background) and handed to the in-process bridge (Firefox:
// the host runs in this event page). See offscreen-core SyncBridge.

/** Our current payload, to send to peers. */
async function syncLocalPayload(): Promise<string> {
	const { payload } = await readLocalState();
	return encodeEntriesPayload(payload);
}

/** A peer's payload arrived: merge into the local vault. Returns whether it changed. */
async function syncApplyRemote(payloadJson: string): Promise<boolean> {
	const remote = decodeEntriesPayload(payloadJson);
	const { changed } = await applyRemotePayload(makeVaultSyncPort(), remote);
	return changed;
}

/** Our roster, to gossip alongside entries. */
async function syncLocalRoster(): Promise<string> {
	const group = await getStoredGroup();
	return group ? encodeRoster(group.roster) : "";
}

/** A peer's roster arrived: merge revocations/additions, persist, and nudge the popup. */
async function syncApplyRoster(rosterJson: string): Promise<void> {
	const group = await getStoredGroup();
	if (!group) return;
	await storeGroup({
		groupKey: group.groupKey,
		roster: mergeRosters(group.roster, decodeRoster(rosterJson)),
	});
	api.runtime
		.sendMessage({ type: "SYNC_EVENT", payload: { kind: "roster" } satisfies SyncEventMsg })
		.catch(() => {});
}

on("SYNC_LOCAL_PAYLOAD", async () => ({ ok: true, data: await syncLocalPayload() }));
on("SYNC_APPLY_REMOTE", async (message) => ({
	ok: true,
	data: await syncApplyRemote(ApplyRemoteMsgSchema.parse(message.payload).payloadJson),
}));
on("SYNC_LOCAL_ROSTER", async () => ({ ok: true, data: await syncLocalRoster() }));
on("SYNC_APPLY_ROSTER", async (message) => {
	await syncApplyRoster(ApplyRosterMsgSchema.parse(message.payload).rosterJson);
	return { ok: true };
});

// Firefox: no offscreen document, so the roster-sync host runs in this event page
// and calls these directly instead of round-tripping through runtime messaging.
setSyncBridge({
	fetchLocalPayload: syncLocalPayload,
	pushRemotePayload: (payloadJson) => syncApplyRemote(payloadJson).then(() => {}),
	fetchLocalRoster: syncLocalRoster,
	pushRemoteRoster: syncApplyRoster,
});
