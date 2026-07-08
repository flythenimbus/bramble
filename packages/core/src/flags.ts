// Build-time feature flags. Single source of truth: `flags.json` in this directory, which is also
// read by core-rust (see packages/core-rust/build.rs), so TS and Rust never drift. Each flag
// defaults to the CONSERVATIVE value; flip it in a later release once the fleet is capable, then
// ship. Never a runtime/remote fetch - these are baked at build time. See
// docs/p2p-sync-revocation-hardening.md for the phase-1 -> phase-2 rollout.

import flagsJson from "./flags.json";

export interface Flags {
	/** Reject an unsigned roster entry for a not-yet-established id (phase-2). Default false =
	 * verify-if-present, so a not-yet-upgraded device is tolerated during rollout. */
	rosterRequireSignatures: boolean;
	/** Reject a brand-new roster id that carries no valid admission (phase-2) - this is what gives
	 * the rogue-injection close its teeth. Default false during rollout. */
	rosterRequireAdmission: boolean;
}

export const flags: Flags = flagsJson;
