// Lets the mobile host's Android back listener (outside the router tree, where the memory-history
// router is unreachable) drive it: InnerApp registers a router-bound handler; the host calls tryAppBack.
let handler: (() => boolean) | null = null;

/** Register (null to clear) the router-back handler; it returns true if it navigated, false at the root. */
export function setAppBackHandler(fn: (() => boolean) | null): void {
	handler = fn;
}

/** Run the handler: true if it went back, false (or unset) means the caller does its default (minimize). */
export function tryAppBack(): boolean {
	return handler?.() ?? false;
}
