/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Target } from "../../flags";
import { EntryRow } from "./EntryRow";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const platformFor = (target: Target) =>
	({ target, clipboard: { copy: vi.fn(async () => {}) } }) as unknown as Platform;

type RowOverrides = Partial<React.ComponentProps<typeof EntryRow>> & { target?: Target };

function renderRow({ target = "chromium", ...props }: RowOverrides = {}) {
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platformFor(target)}>
				<EntryRow
					name="GitHub"
					secondary="octocat"
					icon={KeyRound}
					copyItems={[]}
					onSelect={() => {}}
					onEdit={() => {}}
					onDelete={async () => {}}
					{...props}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
}

function row(passkeys?: number) {
	renderRow({ passkeys });
}

/** The row-wide tap target. Unnamed in selection mode, so it's reached structurally. */
function rowButton(): HTMLElement {
	const el = document.querySelector<HTMLElement>("[data-entry-row] > button");
	if (!el) throw new Error("row button not found");
	return el;
}

// Deleting a login deletes its passkeys with it, and the detail view was the only place that
// said which copy held one. Cleaning up duplicates from the list was blind without this.
describe("EntryRow passkey marker", () => {
	it("marks a login that holds one", () => {
		row(1);
		expect(screen.getByLabelText("Holds a passkey")).toBeTruthy();
	});

	it("counts them when there are several", () => {
		row(3);
		expect(screen.getByLabelText("Holds 3 passkeys")).toBeTruthy();
	});

	it("shows nothing for an entry without any", () => {
		row(0);
		expect(screen.queryByLabelText(/Holds/)).toBeNull();
	});

	it("shows nothing for a type that never has them", () => {
		row(undefined);
		expect(screen.queryByLabelText(/Holds/)).toBeNull();
	});
});

// Touch surfaces have no hover, so the row's controls were only reachable by the
// tap-then-hope behaviour WebKit synthesizes. The copy button was effectively
// invisible on mobile.
describe("EntryRow action controls", () => {
	const copyItems = [{ label: "password", value: "s3cret" }];

	it("does not hide them behind hover on mobile", () => {
		renderRow({ target: "ios", copyItems });
		const copy = screen.getByLabelText("Copy");
		expect(copy.closest("div")?.parentElement?.className).not.toContain("opacity-0");
	});

	it("still reveals them on hover on the extension", () => {
		renderRow({ target: "chromium", copyItems });
		const copy = screen.getByLabelText("Copy");
		expect(copy.closest("div")?.parentElement?.className).toContain("opacity-0");
	});

	// Copy and delete are per-entry, so leaving them up during a bulk selection makes
	// every tap ambiguous.
	it("drops them in selection mode", () => {
		renderRow({ copyItems, selectMode: true, onToggleSelect: () => {} });
		expect(screen.queryByLabelText("Copy")).toBeNull();
		expect(screen.queryByLabelText("More options")).toBeNull();
	});
});

describe("EntryRow selection", () => {
	it("offers no checkbox when the list isn't selectable", () => {
		renderRow();
		expect(screen.queryByLabelText("Select GitHub")).toBeNull();
	});

	// Selection mode is entered deliberately, so a row at rest shows no checkbox even
	// on a pointer surface where one could be revealed on hover.
	it("shows no checkbox until selection mode is on", () => {
		renderRow({ onToggleSelect: () => {} });
		expect(screen.queryByRole("checkbox")).toBeNull();
		cleanup();
		renderRow({ onToggleSelect: () => {}, selectMode: true });
		expect(screen.getByRole("checkbox", { name: "Select GitHub" })).toBeTruthy();
	});

	it("toggles from the checkbox", () => {
		const onToggleSelect = vi.fn();
		renderRow({ selectMode: true, onToggleSelect });
		fireEvent.click(screen.getByRole("checkbox", { name: "Select GitHub" }));
		expect(onToggleSelect).toHaveBeenCalledTimes(1);
	});

	it("toggles instead of opening when the row itself is tapped", () => {
		const onSelect = vi.fn();
		const onToggleSelect = vi.fn();
		renderRow({ selectMode: true, onSelect, onToggleSelect });
		fireEvent.click(rowButton());
		expect(onToggleSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

	// The row-wide tap target duplicates the checkbox, so it must not read as a
	// second control to a screen reader.
	it("keeps the row's tap target out of the a11y tree while selecting", () => {
		renderRow({ selectMode: true, onToggleSelect: () => {} });
		expect(rowButton().getAttribute("aria-hidden")).toBe("true");
		expect(rowButton().getAttribute("tabindex")).toBe("-1");
	});

	it("opens the entry on a plain tap when nothing is selected", () => {
		const onSelect = vi.fn();
		renderRow({ onSelect, onToggleSelect: () => {} });
		fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});

describe("EntryRow long press", () => {
	const press = (el: Element, x = 0, y = 0) =>
		fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: y }] });

	function setup(target: Target = "ios") {
		vi.useFakeTimers();
		const onLongPress = vi.fn();
		const onSelect = vi.fn();
		renderRow({ target, onLongPress, onSelect, onToggleSelect: () => {} });
		return { onLongPress, onSelect, button: screen.getByRole("button", { name: "Open GitHub" }) };
	}

	afterEach(() => vi.useRealTimers());

	it("fires after holding still, and swallows the click that follows", () => {
		const { onLongPress, onSelect, button } = setup();
		press(button);
		vi.advanceTimersByTime(600);
		fireEvent.touchEnd(button);
		fireEvent.click(button);
		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

	// Otherwise every flick-scroll through the list drops into selection mode.
	it("is cancelled by a scroll", () => {
		const { onLongPress, button } = setup();
		press(button);
		fireEvent.touchMove(button, { touches: [{ clientX: 0, clientY: 40 }] });
		vi.advanceTimersByTime(600);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it("leaves a short tap alone", () => {
		const { onLongPress, onSelect, button } = setup();
		press(button);
		vi.advanceTimersByTime(100);
		fireEvent.touchEnd(button);
		fireEvent.click(button);
		expect(onLongPress).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("never fires on a pointer surface", () => {
		const { onLongPress, button } = setup("chromium");
		press(button);
		vi.advanceTimersByTime(600);
		expect(onLongPress).not.toHaveBeenCalled();
	});
});
