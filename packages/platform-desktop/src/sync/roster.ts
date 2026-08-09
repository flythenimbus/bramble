// Ongoing device sync: keeping this vault in step with its group after enrollment.
//
// Enrollment (../sync/transport) gets a second device in once. This is what runs afterwards:
// a roster-authenticated mesh session that exchanges entry payloads and merges them into the
// local blob. Runs while unlocked and enrolled, stops on lock, because the VEK lives in the
// Rust process and a merge cannot decrypt anything without it.
//
// Almost everything here is pinning of one kind or another, and all of it descends from issue
// #27: one process-global VEK plus several vaults means a merge that reads one vault and
// writes another produces a file whose slots wrap a key that cannot open it. Neither the master
// password nor the recovery code recovers from that. So a session is bound to a single vault
// id for its whole life, merges are serialised, and a merge that outlives its session is
// dropped rather than written.

import {
	applyRemotePayload,
	createEntriesBlobStore,
	createVaultSyncPort,
	decodeEntriesPayload,
	decodeRoster,
	decodeVaultBlob,
	encodeEntriesPayload,
	encodeRoster,
	ensureDeviceId,
	type HybridClock,
	makeClock,
	mergeRemoteRoster,
	type RosterEntry,
	type RosterPayload,
	type StorageAdapter,
	SYNC_LAST_SYNCED_KEY,
} from "@core/index";
import { addDevice } from "@core/sync/roster";
import { syncKeyFor } from "@core/sync/sync-keys";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { startRosterSync } from "@core/sync/transport/roster-sync";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { desktopCrypto } from "../adapters/crypto";
import { desktopStorage } from "../adapters/storage";
import { notifyExternalChange, onVaultStateChange } from "../adapters/vault-session";
import { desktopSyncCrypto } from "../sync-crypto";
import { emit, report } from "./bus";
import { deviceKeypair, publishSyncIdentity } from "./keys";
import { linkPeerSource } from "./link-peers";

const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";
const GROUP_KEY = "sync.group";
const RELAY_KEY = "sync.relay";
const ICE_KEY = "sync.iceUrl";
export const ACTIVE_VAULT_KEY = "active-vault";

interface GroupConfig {
	groupKey: string;
	roster: RosterPayload;
}

/**
 * The vault sync targets: the active one the app recorded, else the only one there is.
 *
 * With several vaults registered and no recorded active id there is no safe answer, so this
 * returns undefined rather than guessing the first: guessing points sync at a vault the user is
 * not in, which is how a merge sealed under one vault's key landed in another's file.
 */
async function activeVaultId(): Promise<string | undefined> {
	const active = await desktopStorage.getMeta<string>(ACTIVE_VAULT_KEY);
	if (active) return active;
	const registry = parseRegistry(await desktopStorage.getMeta(VAULT_REGISTRY_KEY));
	return registry.vaults.length === 1 ? registry.vaults[0]?.id : undefined;
}

/** The vault an enrollment should read and write, resolved once at invite time. */
export const syncTargetVaultId = activeVaultId;

/**
 * Merge a device into a vault's stored roster. Used by the enroll host to add a joiner it has
 * just admitted, so the write does not depend on the vault window still being open.
 *
 * A CRDT union, so it never revokes an existing device, and idempotent with the same write from
 * the UI: the entry is identical and the merge is order-independent.
 */
export async function addToLocalRoster(vaultId: string, device: RosterEntry): Promise<void> {
	const key = syncKeyFor(GROUP_KEY, vaultId);
	const group = await desktopStorage.getMeta<GroupConfig>(key);
	if (!group) return; // no group to add to; the invite was for a vault that has since gone
	await desktopStorage.setMeta(key, { ...group, roster: addDevice(group.roster, device) });
	emit({ kind: "roster" });
}

let clockCache: { vaultId: string; clock: Promise<HybridClock> } | null = null;

function getClock(vaultId: string): Promise<HybridClock> {
	if (clockCache?.vaultId !== vaultId) {
		clockCache = {
			vaultId,
			clock: (async () => {
				const ns = (k: string) => syncKeyFor(k, vaultId);
				const id = await ensureDeviceId(
					(k) => desktopStorage.getMeta<string>(ns(k)),
					(k, v) => desktopStorage.setMeta<string>(ns(k), v),
				);
				return makeClock(id);
			})(),
		};
	}
	return clockCache.clock;
}

/**
 * The reader/writer of the on-disk entries format for ONE vault, so a remote merge writes
 * exactly what a local edit does, into the file it read from.
 *
 * Pinned to `vaultId` rather than re-resolving the active vault per call, so a vault switch
 * between a merge's read and its write cannot move the target mid-flight.
 */
function makeBlobStore(vaultId: string) {
	const pinned: StorageAdapter = {
		...desktopStorage,
		// Ignore any id the caller omits AND any it passes: this store serves one vault.
		writeVaultBlob: async (blob) => desktopStorage.writeVaultBlob(blob, vaultId),
	};
	return createEntriesBlobStore({
		crypto: desktopCrypto,
		storage: pinned,
		readDecodedBlob: async () => ({
			blob: decodeVaultBlob(await desktopStorage.readVaultBlob(vaultId)),
		}),
		// The backstop behind the pinning above: merges are the one writer that can be holding a
		// key belonging to a different vault, because the VEK is process-global.
		verifyVekBeforeWrite: true,
	});
}

/**
 * The live sessions: one over the relay, reaching phones and browsers anywhere, and one over the
 * native link, reaching browsers on this machine.
 *
 * Two sessions rather than one combined source, because they are genuinely different transports
 * with different failure modes, and a relay outage should not take the local pipe down with it.
 * They need no coordination beyond what is already here: both merge through the same serialised
 * chain below, so a browser's payload and a phone's cannot interleave their read-modify-write of
 * one blob.
 */
let rosterSessions: MeshSession[] = [];
/** The vault the live sessions sync. Null when nothing is running. */
let sessionVaultId: string | null = null;
/** Bumped on every teardown or retarget. A merge captures it on entry and refuses to write if
 * it has moved, so an apply that began before a vault switch cannot land after it. */
let sessionGen = 0;
/** Serialises merges, so two applies cannot interleave their read-modify-write of one blob. */
let applyInFlight: Promise<unknown> = Promise.resolve();
/** Peers rebroadcast every few seconds; stamp "last synced" at most every 30s. */
let lastSyncStampAt = 0;

async function startRoster(): Promise<void> {
	const vaultId = await activeVaultId();
	if (!vaultId) return;
	const groupMetaKey = syncKeyFor(GROUP_KEY, vaultId);
	const group = await desktopStorage.getMeta<GroupConfig>(groupMetaKey);
	if (!group?.groupKey) return; // not enrolled in a group yet

	const { privateKey, publicKey } = await deviceKeypair();
	const relay = (await desktopStorage.getMeta<string>(RELAY_KEY)) ?? DEFAULT_RELAY;
	const iceUrl = (await desktopStorage.getMeta<string>(ICE_KEY)) ?? "";

	for (const session of rosterSessions) session.stop();
	rosterSessions = [];
	// Everything below is pinned to THIS vaultId for the life of the session. A retarget stops
	// the session and bumps the gen rather than letting a running one follow the active vault.
	const blobStore = makeBlobStore(vaultId);
	const gen = sessionGen;
	sessionVaultId = vaultId;

	const common = {
		relayUrl: relay,
		iceUrl,
		groupKeyB64: group.groupKey,
		devicePrivB64: privateKey,
		devicePubB64: publicKey,
		roster: group.roster,
		wasm: desktopSyncCrypto,
		report,
		fetchLocalRoster: async () => {
			const g = await desktopStorage.getMeta<GroupConfig>(groupMetaKey);
			return g ? encodeRoster(g.roster) : "";
		},
		pushRemoteRoster: async (rosterJson) => {
			const g = await desktopStorage.getMeta<GroupConfig>(groupMetaKey);
			if (!g) return;
			await desktopStorage.setMeta(groupMetaKey, {
				...g,
				roster: mergeRemoteRoster(g.roster, decodeRoster(rosterJson)),
			});
			emit({ kind: "roster" });
		},
		fetchLocalPayload: async () => encodeEntriesPayload(await blobStore.readEntriesPayload()),
		pushRemotePayload: async (json) => {
			// Queue behind any merge already running: applyRemotePayload is a read-modify-write
			// of the whole blob, so two in parallel would race and the loser's edits vanish.
			const run = applyInFlight.then(async () => {
				// This merge's session was torn down or retargeted while it waited. Its blobStore
				// still points at the old vault and the global VEK may now be another vault's, so
				// writing here is precisely the corruption described at the top of this file. Drop
				// it: the peer rebroadcasts, and the new session merges it against the right vault.
				if (gen !== sessionGen) {
					report("sync: dropped a merge for a vault we've since left");
					return;
				}
				const port = createVaultSyncPort({
					store: blobStore,
					witnessRemote: async (stamps) => {
						const clock = await getClock(vaultId);
						for (const hlc of stamps) clock.witness(hlc);
					},
					// Refresh the open list with the peer's edits, rather than leaving the window
					// showing entries the file no longer matches.
					onChanged: notifyExternalChange,
				});
				await applyRemotePayload(port, decodeEntriesPayload(json));

				// Every reconcile, changed or not, means "up to date with a peer".
				const at = Date.now();
				if (at - lastSyncStampAt >= 30_000) {
					lastSyncStampAt = at;
					await desktopStorage.setMeta(syncKeyFor(SYNC_LAST_SYNCED_KEY, vaultId), at);
					emit({ kind: "synced", at });
				}
			});
			// Keep the chain alive after a failed merge, while still surfacing the failure here.
			applyInFlight = run.catch(() => {});
			await run;
		},
	} satisfies Parameters<typeof startRosterSync>[0];

	rosterSessions = [
		await startRosterSync(common),
		// Browsers paired to this app, over the pipe they already have. Started second so a relay
		// failure does not cost the local peers, which are the ones that work offline.
		await startRosterSync({ ...common, peerSource: linkPeerSource }),
	];
}

async function maybeStartRosterSync(): Promise<void> {
	if (rosterSessions.length > 0) return;
	try {
		await startRoster();
	} catch (e) {
		report(`sync error: ${(e as Error).message}`);
	}
}

export function stopRosterSync(): void {
	for (const session of rosterSessions) session.stop();
	rosterSessions = [];
	sessionVaultId = null;
	// Invalidate any merge still queued: it captured the old gen and must not write.
	sessionGen++;
}

/**
 * Point sync at a different vault, or none. Stops the live session, invalidates queued merges,
 * and waits for any in-flight one to settle, so the caller can record the new active vault
 * knowing nothing is still writing against the old one.
 *
 * Called BEFORE the new active id is persisted. Ordering matters: a merge that resolves the
 * active vault after the id moved but while the old session still runs is exactly how a write
 * lands in the wrong vault's file.
 */
export async function retargetActiveVault(next: string | null): Promise<void> {
	if (sessionVaultId === next) return;
	stopRosterSync();
	// Drain. The write side is gen-gated, but let it settle so we do not return while a merge is
	// still touching the vault we are leaving.
	await applyInFlight.catch(() => {});
	// The next getClock re-seeds from the new vault's own device id rather than carrying the old.
	clockCache = null;
}

/**
 * Tie ongoing sync to the lock state: run while unlocked and enrolled, stop on lock. Call once
 * at boot; returns an unsubscribe.
 */
export function initRosterSync(): () => void {
	return onVaultStateChange((locked) => {
		if (locked) stopRosterSync();
		else {
			void publishSyncIdentity();
			void maybeStartRosterSync();
		}
	});
}

/**
 * Drop this device's group membership, for a vault being replaced. The identity keys go with it,
 * in ../sync/transport's resetSyncState, which is the only caller.
 *
 * The relay and ICE endpoints are device-global rather than per-vault, so they are cleared flat.
 * `sync.group` and `sync.deviceId` are namespaced per vault and belong to vaults that still
 * exist, so they are left where they are; a newly created vault has none of its own yet.
 */
export async function clearGroupState(): Promise<void> {
	clockCache = null;
	await Promise.all([desktopStorage.removeMeta(RELAY_KEY), desktopStorage.removeMeta(ICE_KEY)]);
}
