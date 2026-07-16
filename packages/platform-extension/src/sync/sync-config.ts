/// <reference types="chrome" />

import type { RosterPayload } from "@core/sync";
import { syncKeyFor } from "@core/sync/sync-keys";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { api } from "../platform-api";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";

// Which vault the background is syncing: the active (unlocked) vault, resolved so its group and
// device-identity keys namespace correctly (the legacy vault keeps flat keys, others get `:<id>`).
// One vault is unlocked at a time, so a single ctx scopes the whole sync/enrollment path.
export interface SyncVaultCtx {
	vaultId: string;
	legacyBlobVaultId: string | null;
}

/** Resolve the vault to sync: the active vault the UI recorded in session, else the primary
 * (covers a service-worker resume before any UI ran). Null only when no vault exists yet. */
export async function resolveSyncVault(): Promise<SyncVaultCtx | null> {
	const reg = parseRegistry((await api.storage.local.get(VAULT_REGISTRY_KEY))[VAULT_REGISTRY_KEY]);
	let active: string | null = null;
	try {
		const s = await api.storage.session.get([ACTIVE_VAULT_SESSION_KEY]);
		if (typeof s[ACTIVE_VAULT_SESSION_KEY] === "string") active = s[ACTIVE_VAULT_SESSION_KEY];
	} catch {}
	const vaultId = active ?? reg.primaryId;
	if (!vaultId) return null;
	return { vaultId, legacyBlobVaultId: reg.legacyBlobVaultId };
}

/** The per-vault storage key for a flat sync key under this ctx. */
function keyFor(flat: string, ctx: SyncVaultCtx): string {
	return syncKeyFor(flat, ctx.vaultId, ctx.legacyBlobVaultId);
}

// Device-local sync identity storage. The device's Noise static keypair (used for
// roster-anchored channel auth and enrollment) is generated in the offscreen (it
// has the wasm) but PERSISTED here from the background, because the offscreen
// document can't access chrome.storage — only chrome.runtime. Only the PUBLIC key
// ever leaves the extension (it goes in the roster). See docs/p2p-sync.md.
//
// NOTE (hardening follow-up): the private key sits in chrome.storage.local in the
// clear. It should later be wrapped under the VEK like a slot; acceptable for the
// pre-release sync spike, called out so it isn't mistaken for the final shape.

const DEVICE_KEYPAIR_KEY = "sync.deviceKeypair";

export interface DeviceKeypair {
	privateKey: string;
	publicKey: string;
}

/** The wasm device-keypair export (camelCase result, see #[serde(rename_all)]). */
export interface KeypairWasm {
	handshake_generate_keypair(): DeviceKeypair;
}

/** This device's stored Noise static keypair for this vault, or null if not yet generated. */
export async function getStoredKeypair(ctx: SyncVaultCtx): Promise<DeviceKeypair | null> {
	const key = keyFor(DEVICE_KEYPAIR_KEY, ctx);
	const stored = (await api.storage.local.get(key))[key] as DeviceKeypair | undefined;
	return stored?.privateKey && stored?.publicKey ? stored : null;
}

/** Persist this device's Noise static keypair for this vault. */
export async function storeKeypair(kp: DeviceKeypair, ctx: SyncVaultCtx): Promise<void> {
	await api.storage.local.set({ [keyFor(DEVICE_KEYPAIR_KEY, ctx)]: kp });
}

const SIGNING_KEY_KEY = "sync.signingKey";

/** This device's Ed25519 roster-signing keypair (base64; secretKey is the 32-byte seed). Item A. */
export interface SigningKeypair {
	secretKey: string;
	publicKey: string;
}

/** The wasm roster-signing keygen export (camelCase result, see #[serde(rename_all)]). */
export interface RosterSigWasm {
	roster_sig_generate_key(): SigningKeypair;
}

/** This device's stored Ed25519 signing keypair for this vault, or null if not yet generated. */
export async function getStoredSigningKey(ctx: SyncVaultCtx): Promise<SigningKeypair | null> {
	const key = keyFor(SIGNING_KEY_KEY, ctx);
	const stored = (await api.storage.local.get(key))[key] as SigningKeypair | undefined;
	return stored?.secretKey && stored?.publicKey ? stored : null;
}

/** Persist this device's Ed25519 signing keypair for this vault. */
export async function storeSigningKey(kp: SigningKeypair, ctx: SyncVaultCtx): Promise<void> {
	await api.storage.local.set({ [keyFor(SIGNING_KEY_KEY, ctx)]: kp });
}

const GROUP_KEY = "sync.group";

/** True for any vault's group key: the flat legacy key or a namespaced `sync.group:<id>` key. The
 * blob-change watcher uses this to (re)start ongoing sync the moment a group is created (an invite)
 * or its roster changes (a device enrolled), instead of waiting for a blob change or the alarm. */
export function isSyncGroupKey(key: string): boolean {
	return key === GROUP_KEY || key.startsWith(`${GROUP_KEY}:`);
}

/** The group config written by useVault (createGroup/join): the shared key + roster. */
export interface GroupConfig {
	groupKey: string;
	roster: RosterPayload;
}

/** This vault's group config, or null if it isn't in a group yet. */
export async function getStoredGroup(ctx: SyncVaultCtx): Promise<GroupConfig | null> {
	const key = keyFor(GROUP_KEY, ctx);
	const g = (await api.storage.local.get(key))[key] as GroupConfig | undefined;
	return g?.groupKey ? g : null;
}

/** Persist this vault's group config (e.g. after merging a peer's roster). */
export async function storeGroup(group: GroupConfig, ctx: SyncVaultCtx): Promise<void> {
	await api.storage.local.set({ [keyFor(GROUP_KEY, ctx)]: group });
}

const RELAY_KEY = "sync.relay";
const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";

/** The signaling relay URL the background uses for ongoing sync. */
export async function getStoredRelay(): Promise<string> {
	const r = (await api.storage.local.get(RELAY_KEY))[RELAY_KEY];
	return typeof r === "string" && r.length > 0 ? r : DEFAULT_RELAY;
}

export async function storeRelay(url: string): Promise<void> {
	await api.storage.local.set({ [RELAY_KEY]: url });
}

const ICE_KEY = "sync.iceUrl";

/** ICE-servers endpoint for ongoing sync; empty = derive from the relay URL. */
export async function getStoredIceUrl(): Promise<string> {
	const r = (await api.storage.local.get(ICE_KEY))[ICE_KEY];
	return typeof r === "string" ? r : "";
}
