// Tell the user about a new version when the app opens, in a native dialog.
//
// Distribution is a signed GitHub release, so nothing prompts anyone otherwise: a fix would reach
// only the people who thought to look in Settings. This is the one nudge, and it is deliberately
// a decision rather than an action — accepting downloads and RESTARTS the app, so it has to be
// asked rather than assumed.
//
// The decision is native, the progress is not. A system dialog cannot show a download, so
// accepting opens Settings on the Updates section and starts from there, where the percentage
// already has a home.

import { updatePromptCopy, upToDateCopy } from "@core/app/update-prompt-copy";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { desktopStorage } from "./adapters/storage";
import { canSelfUpdate, desktopUpdates } from "./adapters/updates";

/** Long enough to be out of the way of launching and unlocking, short enough to still be this
 * session rather than a surprise ten minutes in. */
const DELAY_MS = 5000;

/** The version the user said "later" to, so the same one is not offered every launch. */
const DISMISSED_KEY = "updates.dismissedVersion";

export function promptForUpdateOnLaunch(): () => void {
	const timer = setTimeout(() => {
		// Nothing to nudge about where a package manager owns this install: apt already keeps it
		// current, and the updater could not apply what the prompt offered.
		if (!canSelfUpdate()) return;
		void offer().catch(() => {
			// Offline, GitHub down, a malformed manifest: none of it is worth a dialog on launch.
			// Settings still has a Check button that reports the reason.
		});
	}, DELAY_MS);
	return () => clearTimeout(timer);
}

/**
 * The menu's "Check for Updates…".
 *
 * Unlike the launch prompt this always answers, including when there is nothing: a check someone
 * asked for that says nothing is a check that looks broken. It also ignores the dismissal, since
 * asking again IS the point.
 */
export function listenForMenuUpdateCheck(): () => void {
	const stop = listen("check-for-updates", () => {
		void offer({ force: true }).catch(async (e) => {
			// Reported here, unlike on launch: they asked, so the answer cannot be silence.
			await message(e instanceof Error ? e.message : String(e), {
				title: "Update check failed",
				kind: "error",
			}).catch(() => {});
		});
	});
	return () => {
		void stop.then((off) => off());
	};
}

async function offer({ force = false }: { force?: boolean } = {}): Promise<void> {
	const update = await desktopUpdates.check();
	if (!update) {
		if (!force) return;
		const copy = upToDateCopy(await getVersion());
		await message(copy.body, { title: copy.title, kind: "info" });
		return;
	}

	const dismissed = await desktopStorage.getMeta<string>(DISMISSED_KEY);
	// Asked once per version. Re-asking every launch for something already declined is how a
	// prompt teaches people to dismiss it without reading.
	if (!force && dismissed === update.version) return;

	// Localised from core, where the extractor can see it. The delay above outlasts the boot, so
	// the catalogs are loaded by now; updatePromptCopy answers in English if they somehow are not.
	const copy = updatePromptCopy(update.version);
	const accepted = await ask(copy.body, {
		title: copy.title,
		kind: "info",
		okLabel: copy.ok,
		cancelLabel: copy.cancel,
	});
	if (!accepted) {
		await desktopStorage.setMeta(DISMISSED_KEY, update.version);
		return;
	}

	// Somewhere to watch it happen. The same event the quick-access panel uses to open an entry,
	// so there is one way into this window's router rather than two.
	await emit("navigate", { href: "/settings?tab=about" });
	await desktopUpdates.install();
}
