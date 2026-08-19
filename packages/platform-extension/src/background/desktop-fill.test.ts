import { describe, expect, it, vi } from "vitest";
import { loadBackground } from "../test/test-harness";

// What the desktop app pushes is the authenticator KEY, because it holds the same index this
// browser does and has no TOTP implementation of its own. Filling that verbatim would type the
// seed into the page's one-time-code field: the wrong value, and the one secret a page must
// never see. The code is computed on this side, exactly as it is for a local fill.

const h = vi.hoisted(() => ({
	/** The handler the autofill side registers for a fill the app pushes. */
	onFill: null as null | ((fill: Record<string, unknown>) => void),
}));

// Only this seam is under test. Reaching the handler through a real native port would re-test
// the link's routing, which desktop-link.test.ts already covers.
vi.mock("./desktop-link", () => ({
	onDesktopFillRequest: (handler: (fill: Record<string, unknown>) => void) => {
		h.onFill = handler;
	},
	linkIsHeld: () => false,
	reportActiveTab: async () => {},
	openDesktopLink: async () => false,
	openSyncLink: async () => false,
	closeSyncLink: async () => {},
}));

/** RFC 6238's SHA1 secret, whose 6-digit code at T=59s is a published vector. */
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CODE_AT_59S = "287082";

/** Push one fill from the app and return the payload the page was sent. */
async function fillFromApp(totpKey: string | null): Promise<Record<string, unknown> | undefined> {
	const bg = await loadBackground({ openTabs: [{ id: 11, url: "https://example.com/login" }] });
	expect(h.onFill).toBeTypeOf("function");
	// Pinned so the assertion is a fixed vector rather than whatever the clock says.
	const clock = vi.spyOn(Date, "now").mockReturnValue(59_000);
	h.onFill?.({ username: "octocat", password: "hunter2", totpKey });
	await bg.flush();
	clock.mockRestore();
	const sent = bg.state.tabMessages.find((m) => m.message.type === "DESKTOP_FILL");
	return sent?.message.payload as Record<string, unknown> | undefined;
}

describe("a fill pushed by the desktop app", () => {
	it("fills the live code for an otpauth key, and never the key", async () => {
		const payload = await fillFromApp(
			`otpauth://totp/Example:octocat?secret=${SEED}&issuer=Example`,
		);
		expect(payload).toEqual({ username: "octocat", password: "hunter2", totp: CODE_AT_59S });
		expect(JSON.stringify(payload)).not.toContain(SEED);
	});

	it("fills the live code for a bare base32 seed", async () => {
		// The index carries whichever form the entry was saved with; both are keys, not codes.
		const payload = await fillFromApp(SEED);
		expect(payload?.totp).toBe(CODE_AT_59S);
	});

	it("drops a key it cannot parse rather than filling it", async () => {
		const payload = await fillFromApp("not a key!!");
		expect(payload?.totp).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain("not a key");
	});

	it("fills a login with no authenticator key at all", async () => {
		const payload = await fillFromApp(null);
		expect(payload).toEqual({ username: "octocat", password: "hunter2" });
	});
});
