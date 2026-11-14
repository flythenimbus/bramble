import { useEffect, useRef } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import {
	type AvailableUpdate,
	fetchLatest,
	installedVersion,
	isCheckDue,
	pendingUpdate,
	UPDATE_MANIFEST_URL,
} from "../app-update";

export interface AppUpdateNotice extends AvailableUpdate {
	onDismiss(): void;
}

/** One attempt per app session: the vault list remounts on every visit, and a failed check
 * (offline) waits for the next launch rather than retrying on each one. */
let attempted = false;

/** Test-only. */
export function resetAppUpdateSession(): void {
	attempted = false;
}

/**
 * The mobile update notice: checks bramble.sh at most once a day while `updateCheck` is on, and
 * returns the newer version until it is taken or dismissed. Null everywhere else, including the
 * desktop, which has its own updater.
 */
export function useAppUpdate(): AppUpdateNotice | null {
	const { target, shell } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const current = installedVersion(shell.version);
	const enabled = loaded && prefs.updateCheck && !!UPDATE_MANIFEST_URL[target] && !!current;

	// Read at completion, not at start: a dismissal while the request is out must survive it.
	const state = useRef(prefs.appUpdate);
	state.current = prefs.appUpdate;

	useEffect(() => {
		if (!enabled || attempted || !isCheckDue(state.current, Date.now())) return;
		attempted = true;
		void fetchLatest(target).then(
			(latest) => update("appUpdate", { ...state.current, checkedAt: Date.now(), latest }),
			() => {},
		);
	}, [enabled, target, update]);

	const found = enabled && current ? pendingUpdate(prefs.appUpdate, current) : null;
	if (!found) return null;
	return {
		...found,
		onDismiss: () => void update("appUpdate", { ...state.current, dismissed: found.version }),
	};
}
