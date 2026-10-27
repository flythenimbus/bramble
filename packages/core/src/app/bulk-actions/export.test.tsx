/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Entry } from "../../hooks/useVault";
import type { EntryConflict, FileRecord } from "../../sync";
import { fileRecord } from "../../test/vault-fixtures";
import { exportAction } from "./export";

const h = vi.hoisted(() => ({
	conflicts: new Map<string, EntryConflict>(),
	files: [] as FileRecord[],
}));

vi.mock("../../hooks/useVault", () => ({
	useVaultState: () => ({ conflicts: h.conflicts, files: h.files }),
}));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const platform = { shell: { exportBytes: async () => {} }, crypto: {} } as unknown as Platform;
const entry = (id: string) => ({ id, type: "note", name: id }) as unknown as Entry;

function show(ids: string[]) {
	const Dialog = exportAction.Dialog;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<Dialog
					open
					onClose={() => {}}
					onDone={() => {}}
					ids={ids}
					entries={ids.map(entry)}
					hiddenCount={0}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
}

describe("the selection export dialog", () => {
	it("counts entries with other versions", () => {
		h.conflicts = new Map([
			["1", { versions: 1, deleted: false }],
			["2", { versions: 2, deleted: false }],
			["3", { versions: 0, deleted: true }],
		]);
		show(["1", "2", "3"]);
		expect(
			screen.getByText(
				/2 of these entries have a sync conflict\. Only the version you see is exported\./,
			),
		).toBeTruthy();
	});

	it("says nothing when no exported entry has another version", () => {
		h.conflicts = new Map([
			["3", { versions: 0, deleted: true }],
			["9", { versions: 1, deleted: false }],
		]);
		show(["1", "3"]);
		expect(screen.queryByText(/sync conflict/)).toBeNull();
	});

	it("says how many files on the selected entries stay behind", () => {
		h.conflicts = new Map();
		h.files = [
			fileRecord({ id: "f1", entryId: "1" }),
			fileRecord({ id: "f2", entryId: "1" }),
			fileRecord({ id: "f3", entryId: "9" }),
			fileRecord({ id: "f4" }),
		];
		show(["1", "2"]);
		expect(
			screen.getByText(/Attachments aren't transferred: 2 files on these entries won't be in/),
		).toBeTruthy();
	});
});
