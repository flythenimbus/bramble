import { beforeEach, describe, expect, it } from "vitest";
import {
	BAKED,
	clearOverrides,
	flagValue,
	hydrateOverrides,
	OVERRIDABLE,
	setOverride,
	subscribeFlags,
} from "./dev-flags";
import { flags } from "./flags";

// The split between overridable and baked is the point of this module. Getting it wrong either
// makes the panel useless or lets a runtime toggle move a security rule that core-rust compiled in
// from the same file, leaving TS and Rust disagreeing about it.

beforeEach(() => {
	clearOverrides();
});

describe("what may be overridden", () => {
	it("excludes every flag the Rust core also compiles in", () => {
		for (const baked of BAKED) {
			expect(OVERRIDABLE).not.toContain(baked);
		}
	});

	it("falls back to the built value when nothing is overridden", () => {
		expect(flagValue("rotateVaultSecret")).toBe(flags.rotateVaultSecret);
	});

	it("takes the override once set, and gives it back on reset", () => {
		setOverride("rotateVaultSecret", !flags.rotateVaultSecret);
		expect(flagValue("rotateVaultSecret")).toBe(!flags.rotateVaultSecret);

		clearOverrides();
		expect(flagValue("rotateVaultSecret")).toBe(flags.rotateVaultSecret);
	});

	it("tells subscribers, so a gated screen re-renders instead of staying hidden", () => {
		let calls = 0;
		const off = subscribeFlags(() => calls++);
		setOverride("rotateVaultSecret", true);
		expect(calls).toBe(1);
		off();
		setOverride("rotateVaultSecret", false);
		expect(calls).toBe(1);
	});
});

describe("hydrating stored overrides", () => {
	it("ignores keys that are no longer overridable", () => {
		// A gate made permanent should not be resurrected by a value left in storage from before.
		hydrateOverrides({ rosterRequireAdmission: true, somethingRemoved: true });
		expect(flagValue("rotateVaultSecret")).toBe(flags.rotateVaultSecret);
	});

	it("ignores non-boolean values rather than coercing them", () => {
		hydrateOverrides({ rotateVaultSecret: "yes" });
		expect(flagValue("rotateVaultSecret")).toBe(flags.rotateVaultSecret);
	});

	it("survives junk", () => {
		hydrateOverrides(null);
		hydrateOverrides("nonsense");
		expect(flagValue("rotateVaultSecret")).toBe(flags.rotateVaultSecret);
	});
});
