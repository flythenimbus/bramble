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
	writeOrQueueVault,
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

/** Start the offscreen roster-sync host if this device is enrolled. Caller ensures unlocked. */
export async function maybeStartSync(): Promise<void> {
	const group = await getStoredGroup();
	const kp = await getStoredKeypair();
	if (!group || !kp) return;
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
			await writeOrQueueVault(newBlob, merged.entries.length);
			await broadcastVaultChanged();
		},
	};
}

// The offscreen asks for our current payload to send to peers.
on("SYNC_LOCAL_PAYLOAD", async () => {
	const { payload } = await readLocalState();
	return { ok: true, data: encodeEntriesPayload(payload) };
});

// A peer's payload arrived: merge into the local vault and persist if it changed.
on("SYNC_APPLY_REMOTE", async (message) => {
	const { payloadJson } = ApplyRemoteMsgSchema.parse(message.payload);
	const remote = decodeEntriesPayload(payloadJson);
	const { changed } = await applyRemotePayload(makeVaultSyncPort(), remote);
	return { ok: true, data: changed };
});

// The offscreen asks for our roster to gossip alongside entries.
on("SYNC_LOCAL_ROSTER", async () => {
	const group = await getStoredGroup();
	return { ok: true, data: group ? encodeRoster(group.roster) : "" };
});

// A peer's roster arrived: merge revocations/additions, persist, and nudge the popup.
on("SYNC_APPLY_ROSTER", async (message) => {
	const { rosterJson } = ApplyRosterMsgSchema.parse(message.payload);
	const group = await getStoredGroup();
	if (!group) return { ok: true };
	await storeGroup({
		groupKey: group.groupKey,
		roster: mergeRosters(group.roster, decodeRoster(rosterJson)),
	});
	chrome.runtime
		.sendMessage({ type: "SYNC_EVENT", payload: { kind: "roster" } satisfies SyncEventMsg })
		.catch(() => {});
	return { ok: true };
});
