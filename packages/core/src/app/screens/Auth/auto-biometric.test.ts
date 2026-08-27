import { describe, expect, it } from "vitest";
import { type AutoPromptState, shouldAutoPromptBiometric } from "./auto-biometric";

// Everything lined up for the prompt to fire; each case negates one thing.
const READY: AutoPromptState = {
	enabled: true,
	offered: true,
	lockedByUser: false,
	visible: true,
	appActive: true,
	attempted: false,
};

const not = (over: Partial<AutoPromptState>) => shouldAutoPromptBiometric({ ...READY, ...over });

describe("shouldAutoPromptBiometric", () => {
	it("fires when the user opted in and the gate is on screen", () => {
		expect(shouldAutoPromptBiometric(READY)).toBe(true);
	});

	it("stays quiet until the user opts in", () => {
		expect(not({ enabled: false })).toBe(false);
	});

	it("stays quiet when the gate isn't offered (no cache, or biometry turned off in Settings)", () => {
		expect(not({ offered: false })).toBe(false);
	});

	// Otherwise tapping Lock would re-open the vault the moment you looked at the phone.
	it("honors an explicit Lock", () => {
		expect(not({ lockedByUser: true })).toBe(false);
	});

	// Auto-lock fires as the app backgrounds, so the screen mounts hidden.
	it("waits for the screen to be on screen", () => {
		expect(not({ visible: false })).toBe(false);
	});

	// The gate iOS actually enforces: it refuses to present one until the app is active, which
	// lands over a second after the webview starts painting.
	it("waits for the OS to call the app active", () => {
		expect(not({ appActive: false })).toBe(false);
	});

	it("does not fire twice", () => {
		expect(not({ attempted: true })).toBe(false);
	});
});
