import { afterEach, describe, expect, it, vi } from "vitest";

// savePasskeyBody -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
async function loadSavePasskeyBody() {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
	return (await import("./save-passkey-body")).savePasskeyBody;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

const base = { rpId: "example.com", intent: "get" as const, primaryLabel: "Use" };

describe("savePasskeyBody: who is asking", () => {
	// The card renders on the focused page; a request from anywhere else must say where.
	it("names a requester that isn't the page the card is on", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			requester: "evil.example.com",
			pageHost: "www.example.com",
		});
		expect(out).toContain("passkeyRequestedBy");
		expect(out).toContain("evil.example.com");
	});

	it("adds nothing when the page itself is asking", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			requester: "www.example.com",
			pageHost: "www.example.com",
		});
		expect(out).not.toContain("passkeyRequestedBy");
	});
});
