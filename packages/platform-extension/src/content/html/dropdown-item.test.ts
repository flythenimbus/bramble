import { beforeEach, describe, expect, it, vi } from "vitest";

// dropdownItem -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
});

async function render(over: { id?: string; name?: string; secondary?: string; carried?: boolean }) {
	const { dropdownItem } = await import("./dropdown-item");
	return dropdownItem({ id: "a", name: "My Visa", secondary: "•••• 1234", ...over });
}

describe("dropdownItem", () => {
	it("marks the card already filled elsewhere on this page", async () => {
		const html = await render({ carried: true });
		expect(html).toContain('class="tp-badge"');
		expect(html).toContain("cardUsedHere");
	});

	it("draws no badge for an ordinary row", async () => {
		const html = await render({});
		expect(html).not.toContain("tp-badge");
		expect(html).not.toContain("cardUsedHere");
	});

	it("still escapes the entry's own text", async () => {
		const html = await render({ name: '<img src=x onerror="alert(1)">', carried: true });
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});
});
