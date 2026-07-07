import { afterEach, describe, expect, it, vi } from "vitest";

// updateLoginBody -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
async function loadUpdateLoginBody() {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
	return (await import("./update-login-body")).updateLoginBody;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

const base = {
	title: "Update an existing login?",
	hostname: "github.com",
	primaryAction: "update",
	primaryLabel: "Update",
};

describe("updateLoginBody", () => {
	it("renders multiple candidates as real radio markup, not escaped text", async () => {
		const updateLoginBody = await loadUpdateLoginBody();
		const out = updateLoginBody({
			...base,
			candidates: [
				{ id: "a", name: "GitHub", username: "octocat" },
				{ id: "b", name: "github.com", username: "flythenimbus" },
			],
		});
		// Nested candidate markup must be real DOM, not escaped into literal text.
		expect(out).toContain('class="tp-candidates"');
		expect(out).toContain('<input type="radio" name="tp-update-target" value="a"');
		expect(out).toContain('<input type="radio" name="tp-update-target" value="b"');
		expect(out).not.toContain("&lt;div");
		expect(out).not.toContain("&lt;input");
	});

	it("renders a single candidate's hidden target as real markup", async () => {
		const updateLoginBody = await loadUpdateLoginBody();
		const out = updateLoginBody({
			...base,
			candidates: [{ id: "solo", name: "GitHub", username: "octocat" }],
		});
		expect(out).toContain('<input type="hidden" name="tp-update-target" value="solo"');
		expect(out).not.toContain("&lt;input");
	});
});
