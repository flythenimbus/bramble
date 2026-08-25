/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VaultSearchBar } from "./VaultSearchBar";
import { DEFAULT_SEARCH, type VaultSearch } from "./vault-search";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function renderBar(search: Partial<VaultSearch> = {}, archivedCount = 0) {
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<VaultSearchBar
				search={{ ...DEFAULT_SEARCH, ...search }}
				onChange={onChange}
				archivedCount={archivedCount}
			/>
		</I18nProvider>,
	);
	return onChange;
}

// Both filter controls are always in the DOM; which one shows is down to a
// breakpoint, which this environment doesn't apply. So each is addressed by
// role: the chips are buttons, the narrow-screen filter is a combobox.
const combobox = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });

describe("VaultSearchBar", () => {
	it("marks the active type filter chip", () => {
		renderBar({ type: "card" });
		expect(screen.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("reports a filter change from a chip", () => {
		const onChange = renderBar();
		fireEvent.click(screen.getByRole("button", { name: "Notes" }));
		expect(onChange).toHaveBeenCalledWith({ type: "note" });
	});

	it("reports a filter change from the select", () => {
		const onChange = renderBar();
		fireEvent.change(combobox("Filter by type"), { target: { value: "ssh-key" } });
		expect(onChange).toHaveBeenCalledWith({ type: "ssh-key" });
	});

	it("keeps the select and the chips on the same filter", () => {
		renderBar({ type: "note" });
		expect(combobox("Filter by type").value).toBe("note");
	});

	// A SelectPill paints its own label over a transparent native select, so the
	// two can drift apart in a way neither the select nor the styles reveal.
	it.each([
		["Filter by type", "note", "Notes"],
		["Sort", "recent-updated", "Recently updated"],
	])("shows the %s selection as its label", (name, value, label) => {
		renderBar({ type: "note", sort: "recent-updated" });
		const select = combobox(name);
		expect(select.value).toBe(value);
		expect(select.parentElement?.querySelector("span")?.textContent).toBe(label);
	});

	it("reports a sort change", () => {
		const onChange = renderBar();
		fireEvent.change(combobox("Sort"), { target: { value: "recent-used" } });
		expect(onChange).toHaveBeenCalledWith({ sort: "recent-used" });
	});
});
