/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { EntryRow } from "./EntryRow";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const platform = {
	clipboard: { copy: vi.fn(async () => {}) },
} as unknown as Platform;

function row(passkeys?: number) {
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<EntryRow
					name="GitHub"
					secondary="octocat"
					icon={KeyRound}
					passkeys={passkeys}
					copyItems={[]}
					onSelect={() => {}}
					onEdit={() => {}}
					onDelete={async () => {}}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
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
