// An `otpauth://` key in flight, between the OS handing it over and the user saying where
// it should go. Two hops, each one-shot: the handoff itself, then the key handed on to the
// edit form once a target login is picked. Module-level (not React state) so both survive
// the navigation that delivers them. See docs/totp-uri-handler.md.
//
// Memory only, never persisted: the URI carries the shared TOTP seed.

let handoff: string | null = null;
let forEntry: { entryId: string; uri: string } | null = null;

/** Park a key the OS handed over, for the setup screen to pick up. */
export function setPendingTotp(uri: string): void {
	handoff = uri;
}

/** Take the handed-over key, if any. Consumed once, so backing out of setup discards it. */
export function takePendingTotp(): string | null {
	const u = handoff;
	handoff = null;
	return u;
}

/** Drop a parked key without using it. */
export function clearPendingTotp(): void {
	handoff = null;
}

/** Hand a key on to one login's edit form, keyed by id so it can't land on a different entry. */
export function setTotpForEntry(entryId: string, uri: string): void {
	forEntry = { entryId, uri };
}

/** Take the key handed on for this entry, if the pending one is for it. */
export function takeTotpForEntry(entryId: string): string | null {
	if (forEntry?.entryId !== entryId) return null;
	const { uri } = forEntry;
	forEntry = null;
	return uri;
}
