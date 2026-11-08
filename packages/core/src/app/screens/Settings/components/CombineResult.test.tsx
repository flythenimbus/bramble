// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";
import { CombineResult } from "./CombineResult";

type Link = ReturnType<typeof useDesktopLink>;

const link = ({
	hidden = true,
	finishing = false,
	held = 0,
	alias = false,
	backupTargets = false,
	unreadableTargets = 0,
	conflicted = 0,
	uncarried = 0,
	quarantined = 0,
	copyFailed = false,
	error = null as string | null,
} = {}) =>
	({
		combined: {
			heldBack: {
				items: Array.from({ length: held }, (_, i) => ({ name: `Look-alike ${i + 1}` })),
				attachments: [],
			},
			uncarried,
			quarantined,
			conflicted,
			hidden,
			copyFailed,
			leftBehind: { alias, backupTargets, unreadableTargets },
		},
		error,
		finishingCombine: finishing,
		copyHeldBack: vi.fn(async () => {}),
		closeCombined: vi.fn(),
	}) as unknown as Link;

const show = (l: Link) =>
	render(
		<I18nProvider i18n={i18n}>
			<CombineResult link={l} />
		</I18nProvider>,
	);

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});
afterEach(cleanup);

describe("after a combine that hid the old vault", () => {
	it("asks nothing: no delete, no keep, only Done", () => {
		const l = link({ held: 1 });
		show(l);
		expect(screen.getByRole("heading", { name: "Vaults combined" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
		expect(screen.queryByRole("button", { name: "Keep it" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(l.closeCombined).toHaveBeenCalledOnce();
	});

	it("closes on Escape, except while copying the look-alikes", () => {
		const l = link({ held: 1 });
		show(l);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(l.closeCombined).toHaveBeenCalledOnce();
		cleanup();

		const busy = link({ held: 1, finishing: true });
		show(busy);
		for (const name of ["Done", "Copy them anyway"]) {
			expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
		}
		fireEvent.keyDown(window, { key: "Escape" });
		expect(busy.closeCombined).not.toHaveBeenCalled();
	});

	it("says look-alikes weren't copied, names them, and offers the copy", () => {
		const l = link({ held: 2 });
		show(l);
		expect(screen.getByText(/^2 entries look like ones .* so they weren't copied\.$/)).toBeTruthy();
		expect(screen.queryByText(/delete/i)).toBeNull();
		expect(screen.getByText("Look-alike 1, Look-alike 2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Copy them anyway" }));
		expect(l.copyHeldBack).toHaveBeenCalledOnce();
	});

	it("says how many backup targets couldn't be opened", () => {
		show(link({ unreadableTargets: 2 }));
		expect(screen.getByText(/2 backup targets couldn't be opened/)).toBeTruthy();
		cleanup();
		show(link({ unreadableTargets: 1 }));
		expect(screen.getByText(/1 backup target couldn't be opened/)).toBeTruthy();
	});

	it("says the alias provider stayed the desktop's", () => {
		show(link({ alias: true }));
		expect(screen.getByText(/has its own email alias provider/)).toBeTruthy();
		expect(screen.queryByText(/already has a backup target/)).toBeNull();
	});

	it("says the backup targets stayed the desktop's", () => {
		show(link({ backupTargets: true }));
		expect(screen.getByText(/already has a backup target/)).toBeTruthy();
		expect(screen.queryByText(/has its own email alias provider/)).toBeNull();
	});

	it("says only the version shown of a conflict came across", () => {
		show(link({ conflicted: 3 }));
		expect(screen.getByText(/3 entries have a sync conflict/)).toBeTruthy();
	});

	it("shows what went wrong inside the dialog, where it can be seen", () => {
		show(link({ held: 1, error: "Something broke" }));
		expect(screen.getByText("Something broke")).toBeTruthy();
	});
});

describe("counting one of something", () => {
	it("says it in the singular", () => {
		show(link({ held: 1, conflicted: 1 }));
		expect(screen.getByText(/^1 entry looks like one .* so it wasn't copied\.$/)).toBeTruthy();
		expect(screen.getByText(/^1 entry has a sync conflict/)).toBeTruthy();
		cleanup();

		show(link({ hidden: false, copyFailed: true, held: 1, uncarried: 1, quarantined: 1 }));
		expect(screen.getByText(/^1 entry looked like one .* it stayed in the old vault/)).toBeTruthy();
		expect(screen.getByText(/^1 file didn't copy\. It is still in the old vault\.$/)).toBeTruthy();
		expect(screen.getByText(/^1 damaged entry stayed/)).toBeTruthy();
	});
});

describe("when the old vault stays listed", () => {
	const stays = { hidden: false, copyFailed: true };

	it("says why, and only closes", () => {
		const l = link(stays);
		show(l);
		expect(screen.getByRole("heading", { name: "The old vault stays" })).toBeTruthy();
		expect(screen.getByText(/Some of it didn't copy/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(l.closeCombined).toHaveBeenCalledOnce();
	});

	it("says how many files and damaged entries", () => {
		show(link({ ...stays, uncarried: 2, quarantined: 3 }));
		expect(
			screen.getByText(/^2 files didn't copy\. They are still in the old vault\.$/),
		).toBeTruthy();
		expect(screen.getByText(/3 damaged entries stayed/)).toBeTruthy();
	});

	it("says look-alikes are in the old vault, with the copy still on offer", () => {
		show(link({ ...stays, held: 2 }));
		expect(screen.getByText(/2 entries looked like ones .* stayed in the old vault/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy them anyway" })).toBeTruthy();
	});

	it("explains an unfinished link with the error it came with, and not as a failed copy", () => {
		show(link({ hidden: false, error: "Linking didn't finish. Link again." }));
		expect(screen.getByRole("heading", { name: "The old vault stays" })).toBeTruthy();
		expect(screen.getByText(/Linking didn't finish/)).toBeTruthy();
		expect(screen.queryByText(/Some of it didn't copy/)).toBeNull();
	});
});
