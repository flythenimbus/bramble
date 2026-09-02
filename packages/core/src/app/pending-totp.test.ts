import { beforeEach, describe, expect, it } from "vitest";
import {
	clearPendingTotp,
	setPendingTotp,
	setTotpForEntry,
	takePendingTotp,
	takeTotpForEntry,
} from "./pending-totp";

const URI = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

beforeEach(() => {
	clearPendingTotp();
	// Drain any key left parked for an entry by a previous test.
	takeTotpForEntry("a");
	takeTotpForEntry("b");
});

describe("the handed-over key", () => {
	it("is empty until one arrives", () => {
		expect(takePendingTotp()).toBeNull();
	});

	// One-shot: backing out of the setup screen must discard the seed rather than leave it
	// waiting for the next visit.
	it("is taken once", () => {
		setPendingTotp(URI);
		expect(takePendingTotp()).toBe(URI);
		expect(takePendingTotp()).toBeNull();
	});

	it("can be dropped without being used", () => {
		setPendingTotp(URI);
		clearPendingTotp();
		expect(takePendingTotp()).toBeNull();
	});

	it("keeps only the most recent arrival", () => {
		setPendingTotp("otpauth://totp/old?secret=JBSWY3DPEHPK3PXP");
		setPendingTotp(URI);
		expect(takePendingTotp()).toBe(URI);
	});
});

describe("the key handed on to an entry", () => {
	it("is returned to the entry it was addressed to", () => {
		setTotpForEntry("a", URI);
		expect(takeTotpForEntry("a")).toBe(URI);
	});

	// Keyed by id so a stray navigation can't drop someone else's 2FA code into the wrong
	// login's form.
	it("is withheld from a different entry, and stays for the right one", () => {
		setTotpForEntry("a", URI);
		expect(takeTotpForEntry("b")).toBeNull();
		expect(takeTotpForEntry("a")).toBe(URI);
	});

	it("is taken once", () => {
		setTotpForEntry("a", URI);
		expect(takeTotpForEntry("a")).toBe(URI);
		expect(takeTotpForEntry("a")).toBeNull();
	});
});
