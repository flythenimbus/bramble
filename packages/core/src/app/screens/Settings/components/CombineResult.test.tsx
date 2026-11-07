// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";
import { CombineResult } from "./CombineResult";

type Link = ReturnType<typeof useDesktopLink>;

const DELETE = "Delete old vault";
const KEEP = "Keep it";

const link = ({
	offered = true,
	finishing = false,
	held = 0,
	alias = false,
	backupTargets = false,
	unreadableTargets = 0,
	copyUnconfirmed = false,
	conflicted = 0,
	uncarried = 0,
	quarantined = 0,
	keptUnasked = false,
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
			keptUnasked,
			copyUnconfirmed,
			leftBehind: { alias, backupTargets, unreadableTargets },
			pendingRemoval: offered ? { id: "v1", copied: {} } : null,
		},
		error,
		finishingCombine: finishing,
		copyHeldBack: vi.fn(async () => {}),
		removeOldVault: vi.fn(async () => {}),
		keepOldVault: vi.fn(async () => {}),
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

describe("the question after a combine", () => {
	it("asks, with both answers, when all of it came across", () => {
		show(link());
		expect(screen.getByRole("heading", { name: "Delete the old vault?" })).toBeTruthy();
		expect(screen.getByText(/Its entries and files are in the desktop's vault now/)).toBeTruthy();
		expect(screen.getByRole("button", { name: DELETE })).toBeTruthy();
		expect(screen.getByRole("button", { name: KEEP })).toBeTruthy();
	});

	it("gives each answer to the hook", () => {
		const deleting = link();
		show(deleting);
		fireEvent.click(screen.getByRole("button", { name: DELETE }));
		expect(deleting.removeOldVault).toHaveBeenCalledOnce();
		expect(deleting.keepOldVault).not.toHaveBeenCalled();
		cleanup();

		const keeping = link();
		show(keeping);
		fireEvent.click(screen.getByRole("button", { name: KEEP }));
		expect(keeping.keepOldVault).toHaveBeenCalledOnce();
		expect(keeping.removeOldVault).not.toHaveBeenCalled();
	});

	it("reads closing it as no answer yet, neither keeping nor deleting", () => {
		const l = link();
		show(l);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(l.closeCombined).toHaveBeenCalledOnce();
		expect(l.keepOldVault).not.toHaveBeenCalled();
		expect(l.removeOldVault).not.toHaveBeenCalled();
	});

	it("takes one answer: nothing works while it is being carried out, closing included", () => {
		const l = link({ finishing: true, held: 1 });
		show(l);
		for (const name of [DELETE, KEEP, "Copy them anyway"]) {
			expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
		}
		fireEvent.keyDown(window, { key: "Escape" });
		expect(l.closeCombined).not.toHaveBeenCalled();
	});

	it("shows what went wrong inside the dialog, where it can be seen", () => {
		show(link({ error: "Something broke" }));
		expect(screen.getByText("Something broke")).toBeTruthy();
	});
});

describe("what the dialog says before deleting", () => {
	it("says look-alikes go with the vault unless copied, and offers the copy", () => {
		const l = link({ held: 2 });
		show(l);
		expect(screen.getByText(/2 entries look like ones .* They go if you delete/)).toBeTruthy();
		expect(screen.queryByText(/Its entries and files are in/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Copy them anyway" }));
		expect(l.copyHeldBack).toHaveBeenCalledOnce();
		expect(l.removeOldVault).not.toHaveBeenCalled();
	});

	it("names the look-alikes, since what they hold is what would go", () => {
		show(link({ held: 2 }));
		expect(screen.getByText("Look-alike 1, Look-alike 2")).toBeTruthy();
	});

	it("says how many backup targets couldn't be opened", () => {
		show(link({ unreadableTargets: 2 }));
		expect(screen.getByText(/2 backup targets couldn't be opened/)).toBeTruthy();
		expect(screen.queryByText(/Its entries and files are in/)).toBeTruthy();
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

	it("says none of that when all of it came across", () => {
		show(link());
		for (const text of [/alias provider/, /backup target/, /sync conflict/, /look like/]) {
			expect(screen.queryByText(text)).toBeNull();
		}
	});
});

describe("counting one of something", () => {
	it("says it in the singular", () => {
		show(link({ held: 1, conflicted: 1 }));
		expect(screen.getByText(/^1 entry looks like one .* It goes if you delete/)).toBeTruthy();
		expect(screen.getByText(/^1 entry has a sync conflict/)).toBeTruthy();
		cleanup();

		show(link({ offered: false, keptUnasked: true, held: 1, uncarried: 1, quarantined: 1 }));
		expect(screen.getByText(/^1 entry looked like one .* it stayed in the old vault/)).toBeTruthy();
		expect(screen.getByText(/^1 file didn't copy\. It is still/)).toBeTruthy();
		expect(screen.getByText(/^1 damaged entry stayed/)).toBeTruthy();
	});
});

describe("when the old vault has to stay", () => {
	const stays = { offered: false, keptUnasked: true };

	it("offers no delete, says why, and only closes", () => {
		const l = link(stays);
		show(l);
		expect(screen.getByRole("heading", { name: "The old vault stays" })).toBeTruthy();
		expect(screen.getByText(/Some of it didn't copy/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: DELETE })).toBeNull();
		expect(screen.queryByRole("button", { name: KEEP })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(l.closeCombined).toHaveBeenCalledOnce();
		expect(l.keepOldVault).not.toHaveBeenCalled();
	});

	it("gives the real reason when the check at the press failed", () => {
		show(link({ offered: false, copyUnconfirmed: true }));
		expect(screen.getByText(/The copy couldn't be confirmed/)).toBeTruthy();
		expect(screen.queryByText(/Some of it didn't copy/)).toBeNull();
	});

	it("says how many files and damaged entries", () => {
		show(link({ ...stays, uncarried: 2, quarantined: 3 }));
		expect(screen.getByText(/2 files didn't copy/)).toBeTruthy();
		expect(screen.getByText(/3 damaged entries stayed/)).toBeTruthy();
	});

	it("says look-alikes are in the old vault, with the copy still on offer", () => {
		show(link({ ...stays, held: 2 }));
		expect(screen.getByText(/2 entries looked like ones .* stayed in the old vault/)).toBeTruthy();
		expect(screen.queryByText(/They go if you delete/)).toBeNull();
		expect(screen.getByRole("button", { name: "Copy them anyway" })).toBeTruthy();
	});

	it("explains an unfinished link with the error it came with, and not as a failed copy", () => {
		show(link({ offered: false, error: "Linking didn't finish. Link again." }));
		expect(screen.getByRole("heading", { name: "The old vault stays" })).toBeTruthy();
		expect(screen.getByText(/Linking didn't finish/)).toBeTruthy();
		expect(screen.queryByText(/Some of it didn't copy/)).toBeNull();
	});
});
