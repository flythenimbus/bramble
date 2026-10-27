/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import type { Entry } from "../../../hooks/useVault";
import { EntryDetail } from "./EntryDetail";

// The attachments section reads the vault; these cases are about the entry's own actions.
vi.mock("../../entry-modes/attachments", () => ({ AttachmentsDetail: () => null }));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const CARD = {
	id: "c1",
	type: "card",
	name: "Personal",
	cardholderName: "Alice Example",
	number: "5555 5555 5555 4444",
	expMonth: "04",
	expYear: "29",
	cvv: "123",
	tags: ["work"],
} as unknown as Entry;

const platform = { clipboard: { copy: vi.fn(async () => {}) } } as unknown as Platform;

function show(entry: Entry = CARD) {
	const onEdit = vi.fn();
	const onDelete = vi.fn(async () => {});
	const onSetArchived = vi.fn(async (_archived: boolean) => {});
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<EntryDetail
					entry={entry}
					onEdit={onEdit}
					onDelete={onDelete}
					onSetArchived={onSetArchived}
					onSelectTag={() => {}}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
	return { onEdit, onDelete, onSetArchived };
}

const precedes = (a: Element, b: Element) =>
	(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// Issue #94: three look-alike icons side by side made Archive and Delete easy to hit by
// mistake when reaching for Edit.
describe("EntryDetail actions", () => {
	it("keeps Edit above the fields and moves Archive and Delete below them", () => {
		show();
		const edit = screen.getByRole("button", { name: "Edit entry" });
		const firstField = screen.getByRole("button", { name: /copy card number/i });
		const lastField = screen.getByRole("button", { name: "Show everything tagged work" });
		const archive = screen.getByRole("button", { name: "Archive entry" });
		const del = screen.getByRole("button", { name: "Delete entry" });

		expect(precedes(edit, firstField)).toBe(true);
		expect(precedes(lastField, archive)).toBe(true);
		expect(precedes(archive, del)).toBe(true);
	});

	it("labels each action in text, not only with an icon", () => {
		show();
		expect(screen.getByRole("button", { name: "Edit entry" }).textContent).toBe("Edit");
		expect(screen.getByRole("button", { name: "Archive entry" }).textContent).toBe("Archive");
		expect(screen.getByRole("button", { name: "Delete entry" }).textContent).toBe("Delete");
	});

	it("edits", () => {
		const { onEdit } = show();
		fireEvent.click(screen.getByRole("button", { name: "Edit entry" }));
		expect(onEdit).toHaveBeenCalledOnce();
	});

	it("archives a live entry", async () => {
		const { onSetArchived } = show();
		fireEvent.click(screen.getByRole("button", { name: "Archive entry" }));
		await vi.waitFor(() => expect(onSetArchived).toHaveBeenCalledExactlyOnceWith(true));
	});

	it("offers Restore in the same place on an archived entry", async () => {
		const { onSetArchived } = show({ ...CARD, archivedAt: 1 } as Entry);
		expect(screen.queryByRole("button", { name: "Archive entry" })).toBeNull();
		const restore = screen.getByRole("button", { name: "Restore entry" });
		expect(restore.textContent).toBe("Restore");
		expect(
			precedes(screen.getByRole("button", { name: "Show everything tagged work" }), restore),
		).toBe(true);

		fireEvent.click(restore);
		await vi.waitFor(() => expect(onSetArchived).toHaveBeenCalledExactlyOnceWith(false));
	});

	it("deletes only after the confirming click", async () => {
		const { onDelete } = show();
		fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
		expect(screen.getByText("Delete this entry permanently?")).toBeTruthy();
		expect(onDelete).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await vi.waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
	});

	it("backs out of a delete", () => {
		const { onDelete } = show();
		fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Delete this entry permanently?")).toBeNull();
		expect(onDelete).not.toHaveBeenCalled();
	});
});

// The compare view renders each version through the mode's own detail body, but copying from a
// version you are only comparing is not a use of the entry.
describe("EntryDetail conflict", () => {
	it("copying a field in the compare view doesn't record a use", async () => {
		const onUse = vi.fn();
		const sibling = { ...CARD, number: "4111 1111 1111 1111" } as unknown as Entry;
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<EntryDetail
						entry={CARD}
						onEdit={() => {}}
						onDelete={async () => {}}
						onSetArchived={async () => {}}
						onSelectTag={() => {}}
						onUse={onUse}
						conflict={{ versions: 1, deleted: false }}
						onReadConflictVersions={async () => [
							{ hlc: { wall: 5, counter: 0, node: "phone" }, data: sibling },
						]}
						onResolveConflict={async () => {}}
					/>
				</PlatformProvider>
			</I18nProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
		await screen.findByRole("button", { name: "Use this one" });
		const other = screen.getByText("The other version").closest("div.rounded-lg") as HTMLElement;
		fireEvent.click(within(other).getByRole("button", { name: /copy card number/i }));
		await waitFor(() =>
			expect(platform.clipboard.copy).toHaveBeenLastCalledWith(expect.stringContaining("4111")),
		);
		expect(onUse).not.toHaveBeenCalled();
	});
});
