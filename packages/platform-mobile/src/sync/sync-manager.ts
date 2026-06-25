import { Preferences } from "@capacitor/preferences";
import {
	applyRemotePayload,
	createEntriesBlobStore,
	createVaultSyncPort,
	decodeEntriesPayload,
	decodeVaultBlob,
	type EntriesPayload,
	encodeEntriesPayload,
	ensureDeviceId,
	type HybridClock,
	makeClock,
	type RosterEntry,
	type RosterPayload,
	type SyncEvent,
} from "@core/index";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { type RosterSyncWasm, startRosterSync } from "@core/sync/transport/roster-sync";
import { mobileCrypto } from "../adapters/crypto";
import { mobileStorage } from "../adapters/storage";
import { notifyExternalChange, onVaultStateChange } from "../adapters/vault-session";
import { secureStorage } from "../secure-storage";
import { loadWasm } from "../wasm-loader";

const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";
const GROUP_KEY = "sync.group";
const RELAY_KEY = "sync.relay";
const ICE_KEY = "sync.iceUrl";

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

// This device's Noise static keypair, generated once and held in secure storage
// (Keychain/Keystore). Only the PUBLIC key ever leaves the device (it goes in the
// roster). The Noise private key authenticates this device in the group, so it
// belongs in the secure store, not plaintext Preferences.
async function deviceKeypair(): Promise<DeviceKeypair> {
	const stored = await secureStorage.get<DeviceKeypair>(DEVICE_KEYPAIR_KEY);
	if (stored?.privateKey && stored?.publicKey) return stored;
	// Migrate an earlier keypair out of plaintext Preferences, preserving identity
	// so an existing pairing keeps working, then purge the insecure copy.
	const legacy = await mobileStorage.getMeta<DeviceKeypair>(DEVICE_KEYPAIR_KEY);
	if (legacy?.privateKey && legacy?.publicKey) {
		await secureStorage.set(DEVICE_KEYPAIR_KEY, legacy);
		await Preferences.remove({ key: `meta:${DEVICE_KEYPAIR_KEY}` });
		return legacy;
	}
	const wasm = (await loadWasm()) as unknown as KeypairWasm;
	const kp = wasm.handshake_generate_keypair();
	await secureStorage.set(DEVICE_KEYPAIR_KEY, kp);
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
	iceUrl?: string;
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
		iceUrl: opts.iceUrl,
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
	iceUrl?: string;
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
		iceUrl: opts.iceUrl,
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
	stopRosterSync(); // full teardown: halt ongoing roster sync too, not just enrollment
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

// The one reader/writer of the on-disk entries format (shared with EntryMutations
// and the enrollment path), so a remote merge writes exactly what a local edit does.
const blobStore = createEntriesBlobStore({
	crypto: mobileCrypto,
	storage: mobileStorage,
	readDecodedBlob: async () => ({ blob: decodeVaultBlob(await mobileStorage.readVaultBlob()) }),
});

let rosterSession: MeshSession | null = null;

async function startRoster(): Promise<void> {
	const group = await mobileStorage.getMeta<GroupConfig>(GROUP_KEY);
	if (!group?.groupKey) return; // not enrolled in a group yet
	const { privateKey, publicKey } = await deviceKeypair();
	const relay = (await mobileStorage.getMeta<string>(RELAY_KEY)) ?? DEFAULT_RELAY;
	const iceUrl = (await mobileStorage.getMeta<string>(ICE_KEY)) ?? "";
	const wasm = (await loadWasm()) as unknown as RosterSyncWasm;
	rosterSession?.stop();
	rosterSession = await startRosterSync({
		relayUrl: relay,
		iceUrl,
		groupKeyB64: group.groupKey,
		devicePrivB64: privateKey,
		devicePubB64: publicKey,
		roster: group.roster,
		wasm,
		report,
		fetchLocalPayload: async () => encodeEntriesPayload(await blobStore.readEntriesPayload()),
		pushRemotePayload: async (json) => {
			const port = createVaultSyncPort({
				store: blobStore,
				witnessRemote: async (stamps) => {
					const clock = await getClock();
					for (const hlc of stamps) clock.witness(hlc);
				},
				onChanged: notifyExternalChange, // refresh the in-app list with the peer's edits
			});
			await applyRemotePayload(port, decodeEntriesPayload(json));
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
