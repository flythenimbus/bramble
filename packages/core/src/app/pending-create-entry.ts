import type { EntryData } from "../hooks/useVault";

// A one-shot prefill for the create-entry form. Used by the mobile autofill "save login"
// handoff: the native AutofillService captures a submitted credential and the app opens
// /vault/new/login seeded with it. Module-level (not React context) so the seed survives
// the post-unlock navigation that delivers the user to the form. Consumed once, then cleared.
let pending: EntryData | null = null;

export function setPendingCreateEntry(entry: EntryData): void {
	pending = entry;
}

export function takePendingCreateEntry(): EntryData | undefined {
	const e = pending ?? undefined;
	pending = null;
	return e;
}
