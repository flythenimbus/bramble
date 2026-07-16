import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import {
	applyRemotePayload,
	createEntriesBlobStore,
	createVaultSyncPort,
	DEVICE_ID_KEY,
	decodeEntriesPayload,
	decodeRoster,
	decodeVaultBlob,
	type EntriesPayload,
	encodeEntriesPayload,
	encodeRoster,
	ensureDeviceId,
	type HybridClock,
	makeClock,
	mergeRemoteRoster,
	type RosterEntry,
	type RosterPayload,
	SYNC_LAST_SYNCED_KEY,
	type SyncEvent,
	type WireRecoverySlot,
} from "@core/index";
import { startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { startRosterSync } from "@core/sync/transport/roster-sync";
import { mobileCrypto } from "../adapters/crypto";
import { mobileStorage } from "../adapters/storage";
import { notifyExternalChange, onVaultStateChange } from "../adapters/vault-session";
import { nativeSyncCrypto, type SyncCrypto } from "../native-crypto";
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

const DEVICE_KEYPAIR_KEY = "sync.deviceKeypair";

// Sync transport crypto (Noise handshake + Nostr + roster signing): native on device (iOS +
// Android), so it shares the one native module that holds the VEK (the vault already runs native
// there) and works under iOS Lockdown Mode where WASM is gone. The in-webview WASM module is only
// the dev-browser fallback; its VaultCrypto type covers only the crypto slice, so the sync ops are
// asserted onto SyncCrypto there. The transport awaits every call, so the async native / sync WASM
// split is transparent. Mirrors the vault dispatch in adapters/crypto.ts.
function loadSyncCrypto(): Promise<SyncCrypto> {
	return Capacitor.isNativePlatform()
		? Promise.resolve(nativeSyncCrypto)
		: loadWasm().then((w) => w as SyncCrypto);
}

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
	const wasm = await loadSyncCrypto();
	const kp = await wasm.handshake_generate_keypair();
	await secureStorage.set(DEVICE_KEYPAIR_KEY, kp);
	return kp;
}

// This device's Ed25519 roster-signing keypair (Item A), generated once and held in secure storage
// (Keychain/Keystore) like the Noise keypair. secretKey is the 32-byte seed; only the public key
// (the roster entry's sigKey) ever leaves the device. See docs/p2p-sync-revocation-hardening.md.
interface SigningKeypair {
	secretKey: string;
	publicKey: string;
}
const SIGNING_KEY_KEY = "sync.signingKey";

async function signingKeypair(): Promise<SigningKeypair> {
	const stored = await secureStorage.get<SigningKeypair>(SIGNING_KEY_KEY);
	if (stored?.secretKey && stored?.publicKey) return stored;
	const wasm = await loadSyncCrypto();
	const kp = await wasm.roster_sig_generate_key();
	await secureStorage.set(SIGNING_KEY_KEY, kp);
	return kp;
}

/** This device's Ed25519 roster-signing verify key (base64). Paired with signRoster. */
export async function syncSigningPublicKey(): Promise<string> {
	return (await signingKeypair()).publicKey;
}

/** Ed25519-sign a canonical roster-entry string with this device's signing seed. */
export async function signRoster(canonical: string): Promise<string> {
	const { secretKey } = await signingKeypair();
	const wasm = await loadSyncCrypto();
	return wasm.roster_sign(secretKey, canonical);
}

/** This device's admission verify key, derived transiently from the re-entered master password +
 * this device's password-slot salt (never stored). Published in the roster entry (Item A). */
export async function syncAdmissionPublicKey(password: string, saltB64: string): Promise<string> {
	const wasm = await loadSyncCrypto();
	return wasm.roster_admission_public_key(password, saltB64);
}

/** Admission-sign an admitted device's canonical entry with this device's password-derived key. */
export async function syncAdmissionSign(
	password: string,
	saltB64: string,
	canonical: string,
): Promise<string> {
	const wasm = await loadSyncCrypto();
	return wasm.roster_admission_sign(password, saltB64, canonical);
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
	passwordCheck?: { saltB64: string; slotIdB64: string; verifierB64: string };
	recoverySlots?: WireRecoverySlot[];
}): Promise<void> {
	const wasm = await loadSyncCrypto();
	const { privateKey } = await deviceKeypair();
	session?.stop();
	session = await startEnroll("inviter", {
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		roster: opts.roster,
		entries: opts.entries,
		passwordCheck: opts.passwordCheck,
		recoverySlots: opts.recoverySlots,
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
	const wasm = await loadSyncCrypto();
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
		onJoinError: (message) => emit({ kind: "join-error", message }),
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
// Throttle the "last synced" stamp: peers rebroadcast every few seconds, so update at most ~30s.
let lastSyncStampAt = 0;

async function startRoster(): Promise<void> {
	const group = await mobileStorage.getMeta<GroupConfig>(GROUP_KEY);
	if (!group?.groupKey) return; // not enrolled in a group yet
	const { privateKey, publicKey } = await deviceKeypair();
	const relay = (await mobileStorage.getMeta<string>(RELAY_KEY)) ?? DEFAULT_RELAY;
	const iceUrl = (await mobileStorage.getMeta<string>(ICE_KEY)) ?? "";
	const wasm = await loadSyncCrypto();
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
		fetchLocalRoster: async () => {
			const g = await mobileStorage.getMeta<GroupConfig>(GROUP_KEY);
			return g ? encodeRoster(g.roster) : "";
		},
		pushRemoteRoster: async (rosterJson) => {
			const g = await mobileStorage.getMeta<GroupConfig>(GROUP_KEY);
			if (!g) return;
			await mobileStorage.setMeta(GROUP_KEY, {
				...g,
				roster: mergeRemoteRoster(g.roster, decodeRoster(rosterJson)),
			});
			emit({ kind: "roster" });
		},
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
			// Every reconcile (changed or no-op) means "we're up to date with a peer". Throttle to
			// ~30s (peers rebroadcast every few seconds); persist + emit the live tick for the in-process
			// Sync UI (onSyncEvent "synced").
			const at = Date.now();
			if (at - lastSyncStampAt >= 30_000) {
				lastSyncStampAt = at;
				await mobileStorage.setMeta(SYNC_LAST_SYNCED_KEY, at);
				emit({ kind: "synced", at });
			}
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

/** Clear ALL of this device's local sync state, for new-vault creation. Tears down any live mesh,
 * then drops the group, relays, device id + cached clock, and the Noise + Ed25519 keys (secure
 * store). Sync identity belongs to the vault, not the device, so a fresh vault must not inherit the
 * old group/mesh. Mirrors the extension's shell.resetSyncState (core createVault calls it). */
export async function resetSyncState(): Promise<void> {
	await stopSync(); // stop syncing the old group before its keys are gone
	clockPromise = null; // next getClock() re-seeds from a fresh device id
	const ignore = () => {};
	await Promise.all([
		mobileStorage.removeMeta(GROUP_KEY),
		mobileStorage.removeMeta(RELAY_KEY),
		mobileStorage.removeMeta(ICE_KEY),
		mobileStorage.removeMeta(DEVICE_ID_KEY),
		mobileStorage.removeMeta(DEVICE_KEYPAIR_KEY), // legacy plaintext copy (pre-secureStorage)
		secureStorage.remove(DEVICE_KEYPAIR_KEY).catch(ignore), // absent-key removal may reject
		secureStorage.remove(SIGNING_KEY_KEY).catch(ignore),
	]);
}
