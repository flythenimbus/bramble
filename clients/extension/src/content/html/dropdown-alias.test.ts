import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AliasRowState } from "./dropdown-alias";

// dropdownAlias -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
});

async function render(row: AliasRowState): Promise<string> {
	const { dropdownAlias } = await import("./dropdown-alias");
	return dropdownAlias(row);
}

describe("dropdownAlias", () => {
	it("invites a click when idle", async () => {
		const html = await render({ state: "idle" });
		expect(html).toContain('data-tp-alias="1"');
		expect(html).toContain("aliasUse");
	});

	// A second request while one is in flight makes two aliases and spends two of the user's
	// allowance for one gesture, so the busy row must not be clickable.
	it("takes no click while in flight", async () => {
		const html = await render({ state: "busy" });
		expect(html).not.toContain("data-tp-alias");
		expect(html).toContain("aliasWorking");
		expect(html).toContain("tp-alias-busy");
	});

	// Failure has to stay actionable: a wrong key or a spent allowance is fixed and retried.
	it("stays clickable after a failure, so the retry is one click", async () => {
		const html = await render({ state: "error", message: "Quota exhausted" });
		expect(html).toContain('data-tp-alias="1"');
		expect(html).toContain("Quota exhausted");
	});

	it("falls back to its own words when the provider gave none", async () => {
		const html = await render({ state: "error" });
		expect(html).toContain("aliasRetry");
	});

	// The provider's message is remote-controlled text arriving in a page-adjacent surface. It
	// is the reason this template interpolates nothing but strings.
	it("escapes a hostile provider message", async () => {
		const html = await render({
			state: "error",
			message: '<img src=x onerror="alert(1)">',
		});
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("escapes a message that tries to break out of the row's markup", async () => {
		const html = await render({ state: "error", message: '"><script>alert(1)</script>' });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
