import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { exchangeBlockedReason } from "./useExchangeAvailability";

// The real hook needs a React tree; the reason string is the part with logic in it, and it is
// what a user actually reads when the feature won't run. An empty catalog makes i18n._ fall
// back to each descriptor's source message, which is what we assert on.
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

describe("exchangeBlockedReason", () => {
	it("says nothing while the probe is still in flight", () => {
		expect(exchangeBlockedReason(null)).toBeNull();
	});

	it("says nothing when the device can transfer", () => {
		expect(
			exchangeBlockedReason({ available: true, providerEnabled: true, osVersion: "26.0" }),
		).toBeNull();
	});

	it("names the OS version, so an old device explains itself instead of hiding the feature", () => {
		expect(
			exchangeBlockedReason({ available: false, providerEnabled: false, osVersion: "18.5" }),
		).toBe("Transferring between apps needs iOS 26. This device is on iOS 18.5.");
	});

	it("falls back when the OS version is unknown", () => {
		expect(exchangeBlockedReason({ available: false, providerEnabled: false })).toBe(
			"Transferring between apps needs iOS 26.",
		);
	});

	it("distinguishes a failed native call from an old OS", () => {
		expect(
			exchangeBlockedReason({ available: false, providerEnabled: false, error: "not implemented" }),
		).toBe("Couldn't reach the transfer service on this device.");
	});

	it("does not block when only the provider toggle is off; that's a picker problem, not a device one", () => {
		expect(
			exchangeBlockedReason({ available: true, providerEnabled: false, osVersion: "26.0" }),
		).toBeNull();
	});
});
