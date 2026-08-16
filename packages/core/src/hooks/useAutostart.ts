import { useCallback, useEffect, useState } from "react";
import { usePlatform } from "../context/PlatformContext";

/**
 * Whether the app starts when the user signs in, read from the OS rather than stored as a pref.
 *
 * A login item is user-visible and removable outside the app, so a stored copy would drift; this
 * asks, and asks again after every write rather than trusting it. `null` means "we do not know",
 * either because the read has not landed or because it failed, and callers show a disabled control
 * rather than guessing "off" and inviting a second write of an entry that already exists.
 *
 * The state is shared between hook instances. Two sections of Settings offer this at once (the
 * General toggle and the prompt in Backups), and per-instance state would leave one of them
 * asserting the opposite of the other until a remount.
 */

type Listener = (value: boolean | null) => void;

const listeners = new Set<Listener>();
let shared: boolean | null = null;

function publish(value: boolean | null) {
	shared = value;
	for (const listener of listeners) listener(value);
}

/** Test seam: module state outlives a test file otherwise. */
export function resetAutostartCache() {
	shared = null;
	listeners.clear();
}

export interface UseAutostart {
	/** False where the platform has no such concept, which is everything but the desktop app. */
	available: boolean;
	/** True on, false off, null unknown (still reading, or the read failed). */
	enabled: boolean | null;
	/** The last write's failure, cleared by the next attempt. */
	error: string | null;
	setEnabled(on: boolean): Promise<void>;
}

export function useAutostart(): UseAutostart {
	const { shell } = usePlatform();
	const autostart = shell.autostart;
	const [enabled, setEnabled] = useState<boolean | null>(shared);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		listeners.add(setEnabled);
		return () => {
			listeners.delete(setEnabled);
		};
	}, []);

	useEffect(() => {
		if (!autostart) return;
		let cancelled = false;
		void autostart.isEnabled().then(
			(on) => !cancelled && publish(on),
			() => !cancelled && publish(null),
		);
		return () => {
			cancelled = true;
		};
	}, [autostart]);

	const write = useCallback(
		async (on: boolean) => {
			if (!autostart) return;
			const previous = shared;
			publish(on); // optimistic: writing a login item is quick, but not instant
			setError(null);
			try {
				await autostart.setEnabled(on);
				// Read back rather than trust the write. This is OS state, and a write that silently
				// did nothing would otherwise leave the UI asserting something untrue.
				publish(await autostart.isEnabled());
			} catch (e) {
				publish(previous);
				setError((e as Error).message);
			}
		},
		[autostart],
	);

	return { available: autostart !== undefined, enabled, error, setEnabled: write };
}
