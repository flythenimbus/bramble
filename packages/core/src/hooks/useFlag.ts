import { useSyncExternalStore } from "react";
import { flagValue, type OverridableFlag, subscribeFlags } from "../dev-flags";

/**
 * A UI-gating flag, re-rendering when a runtime override changes it.
 *
 * Read through this rather than importing `flags` directly wherever the dev panel should be able
 * to flip it: a plain import is captured at module load and would leave a screen still hidden
 * after the box was ticked.
 */
export function useFlag(name: OverridableFlag): boolean {
	return useSyncExternalStore(
		subscribeFlags,
		() => flagValue(name),
		() => flagValue(name),
	);
}
