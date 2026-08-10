// Runtime overrides for the UI-gating build flags, for testing a signed build without rebuilding
// it.
//
// Only some flags may be overridden, and the split is not arbitrary. `rosterRequireSignatures` and
// `rosterRequireAdmission` are compiled into core-rust from the same flags.json (see build.rs), so
// flipping them here would move the TS check while the Rust one stayed put — a disagreement about
// a security rule, which is precisely what one shared source exists to prevent. They are shown in
// the panel and cannot be changed.
//
// What is overridable is UI gating: whether a screen offers something. The gate is not the last
// line of defence for anything destructive — rotation still states its three consequences and
// demands the master password — so exposing it costs a rebuild, not a safety property.

import { type Flags, flags } from "./flags";

/** Flags a runtime override may touch. UI gates only; see the note above. */
export const OVERRIDABLE = ["rotateVaultSecret"] as const;

export type OverridableFlag = (typeof OVERRIDABLE)[number];

/** Flags shown for reference and not editable, because Rust holds the same value. */
export const BAKED: (keyof Flags)[] = ["rosterRequireSignatures", "rosterRequireAdmission"];

/** Where overrides live, so they survive a reload of the window that set them. */
export const DEV_FLAGS_KEY = "dev.flagOverrides";

type Overrides = Partial<Record<OverridableFlag, boolean>>;

let overrides: Overrides = {};
const listeners = new Set<() => void>();

function notify(): void {
	for (const fn of listeners) fn();
}

/** The value in force: an override if one is set, else what the build baked in. */
export function flagValue(name: OverridableFlag): boolean {
	return overrides[name] ?? flags[name];
}

export function setOverride(name: OverridableFlag, value: boolean): Overrides {
	overrides = { ...overrides, [name]: value };
	notify();
	return overrides;
}

/** Drop every override, back to the built-in values. */
export function clearOverrides(): Overrides {
	overrides = {};
	notify();
	return overrides;
}

/** Adopt persisted overrides, ignoring anything no longer overridable so a stale stored key
 * cannot resurrect a gate that has since been made permanent. */
export function hydrateOverrides(stored: unknown): void {
	if (!stored || typeof stored !== "object") return;
	const next: Overrides = {};
	for (const name of OVERRIDABLE) {
		const value = (stored as Record<string, unknown>)[name];
		if (typeof value === "boolean") next[name] = value;
	}
	overrides = next;
	notify();
}

export function currentOverrides(): Overrides {
	return overrides;
}

export function subscribeFlags(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}
