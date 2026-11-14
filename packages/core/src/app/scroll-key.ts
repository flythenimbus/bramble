import type { ParsedLocation } from "@tanstack/react-router";

/**
 * Scroll is remembered per history entry, as by default. A lock replaces the entry twice (to
 * the unlock screen and back), so those redirects carry the original key in history state.
 */
export function scrollKey(location: ParsedLocation): string {
	const carried = (location.state as { scrollKey?: unknown }).scrollKey;
	if (typeof carried === "string") return carried;
	return location.state.__TSR_key ?? location.href;
}

/** History state for a lock's redirects. */
export function carryScroll(location: ParsedLocation) {
	const key = scrollKey(location);
	return (prev: ParsedLocation["state"]) => ({ ...prev, scrollKey: key });
}
