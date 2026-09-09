import { describe, expect, it } from "vitest";
import { aliasHintValue } from "./config";

// The device-local hint that says "this vault has an alias provider". It is the only thing that
// can answer while the vault is LOCKED, because the configuration is a synced setting living
// inside the encrypted payload. See docs/synced-settings.md.

const KEY = "pref.aliasProvider";
const CONFIG = { provider: "addy", options: {}, apiKey: "sk-xxx" };
const withConfig = { [KEY]: { value: CONFIG } };

describe("aliasHintValue", () => {
	it("records a provider that is present", () => {
		expect(aliasHintValue(withConfig, false, KEY)).toBe(true);
	});

	it("records the absence of one", () => {
		expect(aliasHintValue({}, false, KEY)).toBe(false);
		expect(aliasHintValue({ [KEY]: { value: null } }, false, KEY)).toBe(false);
	});

	// The bug this function exists to prevent. Locking resets every synced pref to its default,
	// so the config reads as absent the moment the vault closes. Writing from that state erased
	// the hint at exactly the point it becomes the only thing that can answer, and the unlock row
	// on a signup form's email field stopped appearing.
	it("declines to write anything at all while locked", () => {
		expect(aliasHintValue(withConfig, true, KEY)).toBeNull();
		expect(aliasHintValue(undefined, true, KEY)).toBeNull();
	});

	// A vault that has never loaded reads as no-config rather than throwing, which is the safe
	// direction: one unlock row too few, never a crash on the unlock path.
	it("treats an unloaded vault as having none", () => {
		expect(aliasHintValue(undefined, false, KEY)).toBe(false);
	});

	// A peer on another build can put anything in the map; only something that still parses as a
	// config counts as one.
	it("ignores a value that no longer parses as a config", () => {
		expect(aliasHintValue({ [KEY]: { value: { junk: 1 } } }, false, KEY)).toBe(false);
	});
});
