// Updating the app in place, over the Tauri updater.
//
// The only channel is a signed GitHub release, so this is how a fix reaches anyone running it. The
// plugin verifies the download against the public key compiled into this build before applying it,
// which is what makes fetching a binary from the internet and running it acceptable at all: a
// tampered or substituted asset fails the signature and is discarded.

import type { ShellAdapter } from "@core/adapters/shell";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

/** Held between check and install so the user is not made to wait for a second round trip. */
let pending: Awaited<ReturnType<typeof check>> | null = null;

/**
 * Download progress, shared rather than returned, because an install can start from the launch
 * prompt as well as from Settings and both want to show the same thing.
 */
let fraction: number | null | undefined;
const watchers = new Set<(value: number | null | undefined) => void>();

function report(value: number | null | undefined): void {
	fraction = value;
	for (const watcher of watchers) watcher(value);
}

export const desktopUpdates: NonNullable<ShellAdapter["updates"]> = {
	async check() {
		pending = await check();
		return pending ? { version: pending.version, notes: pending.body ?? undefined } : null;
	},

	onProgress(callback) {
		watchers.add(callback);
		// Replayed immediately: a screen opened mid-download should show it, not wait for the next
		// chunk to learn anything is happening.
		callback(fraction);
		return () => watchers.delete(callback);
	},

	async install() {
		// Re-check rather than trust a stale handle: the window may have sat open for days, and a
		// download URL from that far back is worth re-resolving.
		const update = pending ?? (await check());
		if (!update) return;
		let total = 0;
		let seen = 0;
		try {
			await update.downloadAndInstall((event) => {
				if (event.event === "Started") {
					total = event.data.contentLength ?? 0;
					// Null rather than 0 when the server sent no length: watchers show a spinner
					// instead of a bar that would sit at zero and look stuck.
					report(total ? 0 : null);
				} else if (event.event === "Progress") {
					seen += event.data.chunkLength;
					report(total ? Math.min(1, seen / total) : null);
				} else if (event.event === "Finished") {
					report(1);
				}
			});
		} catch (e) {
			// Back to idle, or a failed download would leave every watcher stuck at a percentage
			// that will never move.
			report(undefined);
			throw e;
		}
		pending = null;
		// Applied on relaunch, so this does not return.
		await relaunch();
	},
};
