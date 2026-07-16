/// <reference types="chrome" />

// Firefox has no persistent offscreen document, so its enrollment/sync host runs in the background
// EVENT PAGE, which the browser suspends after ~30s idle. That kills an in-progress enroll: the
// inviter blocks waiting for the joiner's roster-entry ack (enroll-host sendBundle), the page
// suspends, and the ack is dropped — so the inviter never learns the joiner and ongoing sync can't
// bootstrap (docs/firefox-port.md). A keepalive alarm only WAKES the page (losing the in-memory
// enroll session); to keep the enroll alive we must PREVENT suspension. Repeatedly resolving a
// cheap extension API resets the idle timer, the standard MV3 event-page/service-worker keepalive.
//
// Chrome runs the enroll host in a persistent offscreen document, so the SW may suspend without
// losing it — hence this is a no-op unless the host suspends (Firefox).

import { api } from "../platform-api";

// Ping well under the ~30s idle window; bounded overall so a missed release can't keep the event
// page awake indefinitely (an interactive enroll completes in seconds to a couple of minutes).
const PING_MS = 20_000;
const DEFAULT_MAX_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let deadline = 0;

/**
 * Keep the background event page from suspending (Firefox) for up to `maxMs`. No-op when the host
 * doesn't suspend (Chrome's persistent offscreen). Idempotent: calling again while active just
 * extends the deadline. Pair with `releaseEventPage()` when the work finishes.
 */
export function keepEventPageAlive(suspends: boolean, maxMs = DEFAULT_MAX_MS): void {
	if (!suspends) return;
	deadline = Date.now() + maxMs;
	if (timer) return; // already pinging; the extended deadline above is enough
	timer = setInterval(() => {
		if (Date.now() >= deadline) {
			releaseEventPage();
			return;
		}
		// Any resolved API call counts as activity and resets the idle timer.
		void api.runtime.getPlatformInfo?.().catch(() => {});
	}, PING_MS);
}

/** Stop keeping the event page alive; lets it suspend normally again. Safe to call when inactive. */
export function releaseEventPage(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
