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

function renderBar(
	search: Partial<VaultSearch> = {},
	archivedCount = 0,
	tags: string[] = [],
	attachedCount = 0,
) {
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<VaultSearchBar
				search={{ ...DEFAULT_SEARCH, ...search }}
				onChange={onChange}
				archivedCount={archivedCount}
				attachedCount={attachedCount}
				tags={tags}
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
		expect(screen.getByRole("button", { name: "Payment card" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("reports a filter change from a chip", () => {
		const onChange = renderBar();
		fireEvent.click(screen.getByRole("button", { name: "Secure note" }));
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
		["Filter by type", "note", "Secure note"],
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

const searchInput = () => screen.getByLabelText("Search vault");
const menuItems = () => screen.queryAllByRole("menuitem");

describe("VaultSearchBar tag menu", () => {
	it("stays closed until the query has a # token", () => {
		renderBar({ q: "git" }, 0, ["work"]);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("opens on a # token, one item per tag", () => {
		renderBar({ q: "#" }, 0, ["work", "banking"]);
		expect(menuItems().map((i) => i.textContent)).toEqual(["work", "banking"]);
	});

	it("narrows to tags extending the fragment", () => {
		renderBar({ q: "#wo" }, 0, ["work", "banking"]);
		expect(menuItems().map((i) => i.textContent)).toEqual(["work"]);
	});

	// A trailing space closes the token, so the menu must not linger over the filters.
	it("closes once the token is committed", () => {
		renderBar({ q: "#work " }, 0, ["work"]);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("completes the token in place when an item is picked", () => {
		const onChange = renderBar({ q: "github #wo" }, 0, ["work"]);
		fireEvent.click(menuItems()[0] as Element);
		expect(onChange).toHaveBeenCalledWith({ q: "github #work " });
	});

	it("walks the items with the arrow keys and comes back to the input", () => {
		renderBar({ q: "#" }, 0, ["work", "banking"]);
		fireEvent.keyDown(searchInput(), { key: "ArrowDown" });
		expect(document.activeElement).toBe(menuItems()[0]);

		fireEvent.keyDown(menuItems()[0] as Element, { key: "ArrowDown" });
		expect(document.activeElement).toBe(menuItems()[1]);

		fireEvent.keyDown(menuItems()[1] as Element, { key: "ArrowUp" });
		expect(document.activeElement).toBe(menuItems()[0]);

		// Up from the first item returns to the query rather than wrapping to the bottom.
		fireEvent.keyDown(menuItems()[0] as Element, { key: "ArrowUp" });
		expect(document.activeElement).toBe(searchInput());
	});

	// Someone typing "#wo" as literal text should not have to fight a panel.
	it("dismisses on Escape without touching the query", () => {
		const onChange = renderBar({ q: "#wo" }, 0, ["work"]);
		fireEvent.keyDown(searchInput(), { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("comes back when typing resumes, since that is a fresh intent", () => {
		renderBar({ q: "#wo" }, 0, ["work"]);
		fireEvent.keyDown(searchInput(), { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.change(searchInput(), { target: { value: "#wor" } });
		expect(screen.queryByRole("menu")).toBeTruthy();
	});

	it("dismisses on an outside click", () => {
		renderBar({ q: "#wo" }, 0, ["work"]);
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("tells assistive tech the menu is open", () => {
		renderBar({ q: "#wo" }, 0, ["work"]);
		expect(searchInput().getAttribute("aria-expanded")).toBe("true");
		expect(searchInput().getAttribute("aria-controls")).toBeTruthy();
	});
});

// #157: like the archive toggle, the attachments toggle only shows when there is something to find.
describe("VaultSearchBar attachments toggle", () => {
	const toggle = () => screen.queryByRole("button", { name: "Show items with attachments" });

	it("stays out of a vault with no attachments", () => {
		renderBar();
		expect(toggle()).toBeNull();
	});

	it("shows the count and switches the filter on", () => {
		const onChange = renderBar({}, 0, [], 3);
		const button = toggle();
		expect(button?.textContent).toBe("3");
		expect(button?.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(button as HTMLElement);
		expect(onChange).toHaveBeenCalledWith({ attachments: true });
	});

	it("stays while on, so the filter can always be switched off", () => {
		const onChange = renderBar({ attachments: true }, 0, [], 0);
		expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(toggle() as HTMLElement);
		expect(onChange).toHaveBeenCalledWith({ attachments: false });
	});
});

// #201
describe("VaultSearchBar clear button", () => {
	const clear = () => screen.queryByRole("button", { name: "Clear search" });

	it("stays out of an empty search", () => {
		renderBar();
		expect(clear()).toBeNull();
	});

	it("empties the query and keeps focus in the field", () => {
		const onChange = renderBar({ q: "bank" });
		fireEvent.click(clear() as HTMLElement);
		expect(onChange).toHaveBeenCalledWith({ q: "" });
		expect(document.activeElement).toBe(screen.getByLabelText("Search vault"));
	});
});
