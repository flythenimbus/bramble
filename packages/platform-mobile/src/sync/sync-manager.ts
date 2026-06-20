import {
	applyRemotePayload,
	decodeEntriesPayload,
	decodeVaultBlob,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
	encodeVaultBlob,
	ensureDeviceId,
	type HybridClock,
	makeClock,
	type RosterEntry,
	type RosterPayload,
	type SyncEvent,
	type VaultBlob,
	type VaultSyncPort,
} from "@core/index";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { type RosterSyncWasm, startRosterSync } from "@core/sync/transport/roster-sync";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { mobileCrypto, notifyExternalChange, onVaultStateChange } from "../adapters/crypto";
import { mobileStorage } from "../adapters/storage";
import { loadWasm } from "../wasm-loader";

const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";
const GROUP_KEY = "sync.group";
const RELAY_KEY = "sync.relay";

interface GroupConfig {
	groupKey: string;
	roster: RosterPayload;
}

// Mobile sync session manager. The extension runs this in an offscreen document
// driven over chrome.runtime; on mobile the single webview has a DOM, so the same
// transport modules (now in @core/sync/transport) run in-process. WebRTC data
// channels + the WebSocket relay are standard Web APIs available in WKWebView.

interface DeviceKeypair {
	privateKey: string;
	publicKey: string;
}
// The wasm device-keypair export (camelCase result, see #[serde(rename_all)]).
type KeypairWasm = { handshake_generate_keypair(): DeviceKeypair };

const DEVICE_KEYPAIR_KEY = "sync.deviceKeypair";

// This device's Noise static keypair, generated once and persisted. Only the
// PUBLIC key ever leaves the device (it goes in the roster). NOTE: the private key
// sits in Preferences in the clear for the spike; hardening (wrap under VEK /
// Keychain) is the same follow-up as the extension's sync-config.
async function deviceKeypair(): Promise<DeviceKeypair> {
	const stored = await mobileStorage.getMeta<DeviceKeypair>(DEVICE_KEYPAIR_KEY);
	if (stored?.privateKey && stored?.publicKey) return stored;
	const wasm = (await loadWasm()) as unknown as KeypairWasm;
	const kp = wasm.handshake_generate_keypair();
	await mobileStorage.setMeta(DEVICE_KEYPAIR_KEY, kp);
	return kp;
}

const statusSubs = new Set<(s: string) => void>();
const eventSubs = new Set<(e: SyncEvent) => void>();
// Ring buffer of recent status so a panel that mounts after sync started (e.g. it
// starts on unlock, before Settings is opened) still shows the current state.
const statusHistory: string[] = [];
const report = (s: string) => {
	statusHistory.push(s);
	if (statusHistory.length > 50) statusHistory.shift();
	for (const cb of statusSubs) cb(s);
};
const emit = (e: SyncEvent) => {
	for (const cb of eventSubs) cb(e);
};

export function onSyncStatus(cb: (s: string) => void): () => void {
	statusSubs.add(cb);
	for (const s of statusHistory) cb(s); // replay recent lines to a fresh subscriber
	return () => statusSubs.delete(cb);
}
export function onSyncEvent(cb: (e: SyncEvent) => void): () => void {
	eventSubs.add(cb);
	return () => eventSubs.delete(cb);
}

export async function syncDevicePublicKey(): Promise<string> {
	return (await deviceKeypair()).publicKey;
}

let session: MeshSession | null = null;

export async function startEnrollInvite(opts: {
	relayUrl: string;
	groupKeyB64: string;
	psk: string;
	roster: RosterPayload;
	entries: EntriesPayload;
}): Promise<void> {
	const wasm = (await loadWasm()) as unknown as EnrollWasm;
	const { privateKey } = await deviceKeypair();
	session?.stop();
	session = await startEnroll("inviter", {
		relayUrl: opts.relayUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		roster: opts.roster,
		entries: opts.entries,
		devicePrivB64: privateKey,
		wasm,
		report,
		onEnrolled: (entryJson) => emit({ kind: "enrolled", entryJson }),
	});
}

export async function startEnrollJoin(opts: {
	relayUrl: string;
	groupKeyB64: string;
	psk: string;
	inviterPub: string;
	ownEntry: RosterEntry;
	password?: string;
	webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
}): Promise<void> {
	const wasm = (await loadWasm()) as unknown as EnrollWasm;
	const { privateKey } = await deviceKeypair();
	session?.stop();
	session = await startEnroll("joiner", {
		relayUrl: opts.relayUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		inviterPub: opts.inviterPub,
		ownEntry: opts.ownEntry,
		password: opts.password,
		webauthn: opts.webauthn,
		devicePrivB64: privateKey,
		wasm,
		report,
		onJoined: (r) => emit({ kind: "joined", vaultBlobB64: r.vaultBlobB64, roster: r.roster }),
	});
}

export async function stopSync(): Promise<void> {
	session?.stop();
	session = null;
	report("disconnected");
}

// --- ongoing roster sync (continuous merge after enrollment) ---

// This device's HLC clock (own instance, seeded from the persisted device id, like
// the extension's background clock). witnessRemote advances it past peers' stamps.
let clockPromise: Promise<HybridClock> | null = null;
function getClock(): Promise<HybridClock> {
	if (!clockPromise) {
		clockPromise = (async () => {
			const id = await ensureDeviceId(
				(k) => mobileStorage.getMeta<string>(k),
				(k, v) => mobileStorage.setMeta<string>(k, v),
			);
			return makeClock(id);
		})();
	}
	return clockPromise;
}

// Read + decrypt the local outer blob: the blob (for its slots, carried forward on
// write) plus the decrypted entries payload (empty for a fresh vault).
async function readLocalState(): Promise<{ blob: VaultBlob; payload: EntriesPayload }> {
	const blob = decodeVaultBlob(await mobileStorage.readVaultBlob());
	if (blob.entriesCiphertext.length === 0) return { blob, payload: emptyEntriesPayload() };
	const json = await mobileCrypto.decryptWithVek(
		bytesToBase64(blob.entriesIv),
		bytesToBase64(blob.entriesCiphertext),
	);
	return { blob, payload: decodeEntriesPayload(json) };
}

// Host side of the merge seam (runs in-process here, unlike the extension where it
// straddles offscreen + background). readLocal runs before writeMerged, so the
// captured slots are current; sealed per-entry envelopes are carried verbatim.
function makeVaultSyncPort(): VaultSyncPort {
	let slots: VaultBlob["slots"] = [];
	return {
		async readLocal() {
			const { blob, payload } = await readLocalState();
			slots = blob.slots;
			return payload;
		},
		async witnessRemote(stamps) {
			const clock = await getClock();
			for (const hlc of stamps) clock.witness(hlc);
		},
		async writeMerged(merged) {
			const { iv, ciphertext } = await mobileCrypto.encryptWithVek(encodeEntriesPayload(merged));
			const newBlob = encodeVaultBlob({
				slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			});
			await mobileStorage.writeVaultBlob(newBlob);
			notifyExternalChange(); // refresh the in-app list with the peer's edits
		},
	};
}

let rosterSession: MeshSession | null = null;

async function startRoster(): Promise<void> {
	const group = await mobileStorage.getMeta<GroupConfig>(GROUP_KEY);
	if (!group?.groupKey) return; // not enrolled in a group yet
	const { privateKey, publicKey } = await deviceKeypair();
	const relay = (await mobileStorage.getMeta<string>(RELAY_KEY)) ?? DEFAULT_RELAY;
	const wasm = (await loadWasm()) as unknown as RosterSyncWasm;
	rosterSession?.stop();
	rosterSession = await startRosterSync({
		relayUrl: relay,
		groupKeyB64: group.groupKey,
		devicePrivB64: privateKey,
		devicePubB64: publicKey,
		roster: group.roster,
		wasm,
		report,
		fetchLocalPayload: async () => encodeEntriesPayload((await readLocalState()).payload),
		pushRemotePayload: async (json) => {
			await applyRemotePayload(makeVaultSyncPort(), decodeEntriesPayload(json));
		},
	});
}

async function maybeStartRosterSync(): Promise<void> {
	if (rosterSession) return; // already running
	try {
		await startRoster();
	} catch (e) {
		report(`sync error: ${(e as Error).message}`);
	}
}

function stopRosterSync(): void {
	rosterSession?.stop();
	rosterSession = null;
}

/** Wire ongoing roster sync to the vault lock state: run while unlocked + enrolled,
 * stop on lock (the VEK is gone, so merges can't decrypt). Call once at boot;
 * returns an unsubscribe. */
export function initRosterSync(): () => void {
	return onVaultStateChange((locked) => {
		if (locked) stopRosterSync();
		else void maybeStartRosterSync();
	});
}
