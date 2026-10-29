import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

// A put-away window keeps its React state (the desktop hides to the tray, mobile backgrounds), so
// it reopens on the same route. Revealed secrets must not come back with it.
const resets = new Set<() => void>();

/** Mask every revealed secret. InnerApp calls it from shell.onHide. */
export function concealSecrets(): void {
	for (const reset of resets) reset();
}

/** useState for a secret's show/hide toggle: snaps back to `initial` on concealSecrets(). */
export function useRevealState<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
	const [masked] = useState(initial);
	const [state, setState] = useState(masked);
	useEffect(() => {
		const reset = () => setState(masked);
		resets.add(reset);
		return () => {
			resets.delete(reset);
		};
	}, [masked]);
	return [state, setState];
}
