/// <reference types="chrome" />

import type { RosterPayload } from "@core/sync";
import { api } from "../platform-api";

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

/** This device's stored Noise static keypair, or null if not yet generated. */
export async function getStoredKeypair(): Promise<DeviceKeypair | null> {
	const stored = (await api.storage.local.get(DEVICE_KEYPAIR_KEY))[DEVICE_KEYPAIR_KEY] as
		| DeviceKeypair
		| undefined;
	return stored?.privateKey && stored?.publicKey ? stored : null;
}

/** Persist this device's Noise static keypair. */
export async function storeKeypair(kp: DeviceKeypair): Promise<void> {
	await api.storage.local.set({ [DEVICE_KEYPAIR_KEY]: kp });
}

const GROUP_KEY = "sync.group";

/** The group config written by useVault (createGroup/join): the shared key + roster. */
export interface GroupConfig {
	groupKey: string;
	roster: RosterPayload;
}

/** This device's group config, or null if it isn't in a group yet. */
export async function getStoredGroup(): Promise<GroupConfig | null> {
	const g = (await api.storage.local.get(GROUP_KEY))[GROUP_KEY] as GroupConfig | undefined;
	return g?.groupKey ? g : null;
}

/** Persist the group config (e.g. after merging a peer's roster). */
export async function storeGroup(group: GroupConfig): Promise<void> {
	await api.storage.local.set({ [GROUP_KEY]: group });
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
