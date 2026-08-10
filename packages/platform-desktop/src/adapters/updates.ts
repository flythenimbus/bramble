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

export const desktopUpdates: NonNullable<ShellAdapter["updates"]> = {
	async check() {
		pending = await check();
		return pending ? { version: pending.version, notes: pending.body ?? undefined } : null;
	},

	async install(onProgress) {
		// Re-check rather than trust a stale handle: the window may have sat open for days, and a
		// download URL from that far back is worth re-resolving.
		const update = pending ?? (await check());
		if (!update) return;
		let total = 0;
		let seen = 0;
		await update.downloadAndInstall((event) => {
			if (event.event === "Started") {
				total = event.data.contentLength ?? 0;
				// Null rather than 0 when the server sent no length: the caller shows a spinner
				// instead of a bar that would sit at zero and look stuck.
				onProgress?.(total ? 0 : null);
			} else if (event.event === "Progress") {
				seen += event.data.chunkLength;
				onProgress?.(total ? Math.min(1, seen / total) : null);
			} else if (event.event === "Finished") {
				onProgress?.(1);
			}
		});
		pending = null;
		// Applied on relaunch, so this does not return.
		await relaunch();
	},
};
