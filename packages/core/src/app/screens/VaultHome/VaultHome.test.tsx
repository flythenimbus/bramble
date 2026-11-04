/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import type { Entry } from "../../../hooks/useVault";
import { VaultHome, type VaultListItem } from "./VaultHome";
import { DEFAULT_SEARCH } from "./vault-search";

// Bulk-action dialogs reach the vault themselves (that's what removed the prop-drilling),
// so the delete path is exercised against a stub rather than a mounted VaultProvider.
const { deleteEntries } = vi.hoisted(() => ({
	deleteEntries: vi.fn(async (_ids: string[]) => {}),
}));
vi.mock("../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../hooks/useVault")>()),
	useVault: () => ({ deleteEntries }),
}));

afterEach(() => {
	cleanup();
	deleteEntries.mockClear();
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

// shell/crypto are read by the registry's isAvailable predicates; empty means the export
// action is unavailable here, so these tests see delete only.
const platform = {
	target: "chromium",
	clipboard: { copy: vi.fn() },
	shell: {},
	crypto: {},
} as unknown as Platform;

const item = (id: string, overrides: Partial<VaultListItem> = {}): VaultListItem => ({
	id,
	type: "login",
	name: id,
	icon: KeyRound,
	secondary: "user",
	copyItems: [],
	searchText: id,
	archived: false,
	...overrides,
});

const entry = (id: string): Entry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "user",
	password: "pw",
});

// The virtualizer renders no rows in a zero-height jsdom container, which is fine here:
// every assertion is about the toolbar, and "Select all" acts on the filtered list rather
// than on the mounted rows.
function setup() {
	const ids = ["a", "b", "c"];
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultHome
					items={ids.map((id) => item(id))}
					entries={ids.map(entry)}
					search={DEFAULT_SEARCH}
					onSearchChange={() => {}}
					onCreate={() => {}}
					onSelectEntry={() => {}}
					onEditEntry={() => {}}
					onDeleteEntry={async () => {}}
					onUseEntry={() => {}}
					tags={[]}
					statsCollapsed
					onToggleStats={() => {}}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
	return { deleteEntries };
}

const enterSelectMode = () => fireEvent.click(screen.getByLabelText("Select items"));
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("VaultHome selection mode", () => {
	it("starts out of selection mode, behind the header button", () => {
		setup();
		expect(screen.getByText("Items (3)")).toBeTruthy();
		expect(screen.queryByText("0 selected")).toBeNull();
	});

	it("enters selection mode from the header button", () => {
		setup();
		enterSelectMode();
		expect(screen.getByText("0 selected")).toBeTruthy();
		expect(screen.queryByText("Items (3)")).toBeNull();
	});

	it("selects and deselects every filtered entry", () => {
		setup();
		enterSelectMode();
		click("Select all");
		expect(screen.getByText("3 selected")).toBeTruthy();
		click("Deselect all");
		expect(screen.getByText("0 selected")).toBeTruthy();
	});

	// Emptying the selection is a normal mid-edit step. Deriving the mode from the
	// selection size dumped the user back to the plain list on every "Deselect all".
	it("stays in selection mode after deselecting everything", () => {
		setup();
		enterSelectMode();
		click("Select all");
		click("Deselect all");
		expect(screen.queryByText("Items (3)")).toBeNull();
		expect(screen.getByText("0 selected")).toBeTruthy();
	});

	it("leaves selection mode only through the exit button", () => {
		setup();
		enterSelectMode();
		click("Done selecting");
		expect(screen.getByText("Items (3)")).toBeTruthy();
	});
});

describe("VaultHome bulk actions", () => {
	it("keeps the actions menu shut while nothing is selected", () => {
		setup();
		enterSelectMode();
		click("Actions");
		expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
	});

	it("deletes the whole selection in one call", async () => {
		setup();
		enterSelectMode();
		click("Select all");
		click("Actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

		// Destructive and multi-entry, so it confirms first.
		expect(screen.getByText("Delete 3 entries?")).toBeTruthy();
		click("Delete");
		await vi.waitFor(() => expect(deleteEntries).toHaveBeenCalledTimes(1));
		expect(deleteEntries.mock.calls[0]?.[0]).toEqual(["a", "b", "c"]);
	});

	// Registered actions the platform can't perform are hidden, not shown broken: this
	// platform has no shell.exportBytes / crypto.saveKdbx.
	it("hides an action the platform can't perform", () => {
		setup();
		enterSelectMode();
		click("Select all");
		click("Actions");
		expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: /KeePass/ })).toBeNull();
	});

	// A bulk delete is usually one step of a cleanup pass, so it empties the selection
	// and stays put rather than dropping the user back to the plain list.
	it("stays in selection mode after an action finishes", async () => {
		setup();
		enterSelectMode();
		click("Select all");
		click("Actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		click("Delete");
		await vi.waitFor(() => expect(screen.getByText("0 selected")).toBeTruthy());
		expect(screen.queryByText("Items (3)")).toBeNull();
	});
});

// The Overview cards filter the list by what they count, and a collapsed Overview lifts the filter.
describe("VaultHome overview cards", () => {
	function overview(
		search: Partial<typeof DEFAULT_SEARCH> = {},
		statsCollapsed = false,
		items = [item("bank", { leaked: true }), item("mail"), item("wifi", { type: "note" })],
	) {
		const onSearchChange = vi.fn();
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<VaultHome
						items={items}
						entries={[]}
						search={{ ...DEFAULT_SEARCH, ...search }}
						onSearchChange={onSearchChange}
						onCreate={() => {}}
						onSelectEntry={() => {}}
						onEditEntry={() => {}}
						onDeleteEntry={async () => {}}
						onUseEntry={() => {}}
						tags={[]}
						statsCollapsed={statsCollapsed}
						onToggleStats={() => {}}
					/>
				</PlatformProvider>
			</I18nProvider>,
		);
		return onSearchChange;
	}
	const card = (name: RegExp) => screen.getByRole("button", { name });

	it("filters to a card's items, and Total Items goes back to all of them", () => {
		const onSearchChange = overview();
		fireEvent.click(card(/At Risk/));
		expect(onSearchChange).toHaveBeenLastCalledWith({ health: "atRisk" });
		fireEvent.click(card(/Strong/));
		expect(onSearchChange).toHaveBeenLastCalledWith({ health: "strong" });
		fireEvent.click(card(/Total Items/));
		expect(onSearchChange).toHaveBeenLastCalledWith({ health: "all" });
	});

	it("marks the selected card, with Total Items selected when nothing is filtered", () => {
		overview();
		expect(card(/Total Items/).getAttribute("aria-pressed")).toBe("true");
		expect(card(/At Risk/).getAttribute("aria-pressed")).toBe("false");
		cleanup();
		overview({ health: "atRisk" });
		expect(card(/At Risk/).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Items (1)")).toBeTruthy();
	});

	it("disables a card with nothing to show, unless it is the one selected", () => {
		overview({}, false, [item("mail")]);
		expect((card(/At Risk/) as HTMLButtonElement).disabled).toBe(true);
		cleanup();
		overview({ health: "atRisk" }, false, [item("mail")]);
		expect((card(/At Risk/) as HTMLButtonElement).disabled).toBe(false);
	});

	it("lifts the filter while the Overview is collapsed", () => {
		overview({ health: "atRisk" }, true);
		expect(screen.getByText("Items (3)")).toBeTruthy();
	});
});
