// The one status/event stream both sync halves report on.
//
// Enrollment (./transport) and ongoing sync (./roster) both emit here, and the Settings panel
// subscribes once. Its own module because ./transport's full teardown has to stop the roster
// session too, which would otherwise make the two import each other.

import type { SyncEvent } from "@core/index";

const statusSubs = new Set<(s: string, at: number) => void>();
const eventSubs = new Set<(e: SyncEvent) => void>();

/** Recent status, replayed to a late subscriber. Sync starts on unlock, long before anyone opens
 * Settings, and a panel that mounted afterwards would otherwise show nothing at all. */
const statusHistory: { status: string; at: number }[] = [];

export function report(s: string): void {
	const at = Date.now();
	statusHistory.push({ status: s, at });
	if (statusHistory.length > 50) statusHistory.shift();
	for (const cb of statusSubs) cb(s, at);
}

export function emit(e: SyncEvent): void {
	for (const cb of eventSubs) cb(e);
}

/** Each line comes with the epoch ms it was logged at, replayed ones included. */
export function onSyncStatus(cb: (s: string, at: number) => void): () => void {
	statusSubs.add(cb);
	for (const line of statusHistory) cb(line.status, line.at);
	return () => statusSubs.delete(cb);
}

export function onSyncEvent(cb: (e: SyncEvent) => void): () => void {
	eventSubs.add(cb);
	return () => eventSubs.delete(cb);
}
