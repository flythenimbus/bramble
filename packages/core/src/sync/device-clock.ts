// This device's stable sync identity and its clock. The node id is persisted
// once (via the storage adapter's meta kv) so stamps stay attributable across
// sessions; the clock itself is fine to recreate per session because wall time
// gives cross-restart monotonicity. See docs/p2p-sync.md.

import { HybridClock } from "./hlc";

export const DEVICE_ID_KEY = "sync.deviceId";

type MetaGet = (key: string) => Promise<string | undefined>;
type MetaSet = (key: string, value: string) => Promise<void>;

/** Load this device's node id, generating and persisting one on first use. */
export async function ensureDeviceId(get: MetaGet, set: MetaSet): Promise<string> {
	const existing = await get(DEVICE_ID_KEY);
	if (existing) return existing;
	const id = globalThis.crypto.randomUUID();
	await set(DEVICE_ID_KEY, id);
	return id;
}

/** A clock for this device. */
export function makeClock(deviceId: string): HybridClock {
	return new HybridClock(deviceId);
}
