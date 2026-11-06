// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";
import { CombineResult } from "./CombineResult";

type Link = ReturnType<typeof useDesktopLink>;

const link = (
	asking: boolean,
	finishing = false,
	{ held = 2, alias = false, backupTargets = false } = {},
) =>
	({
		combined: {
			heldBack: { items: Array.from({ length: held }, () => ({ name: "a" })), attachments: [] },
			uncarried: 0,
			quarantined: 0,
			keptUnasked: false,
			leftBehind: { alias, backupTargets },
			pendingRemoval: asking ? { id: "v1", copied: {} } : null,
		},
		finishingCombine: finishing,
		copyHeldBack: vi.fn(async () => {}),
		removeOldVault: vi.fn(async () => {}),
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

describe("look-alikes the desktop's vault seems to hold already", () => {
	it("asks about them while the old vault waits to go, with both answers on offer", () => {
		const l = show(link(true));
		expect(l.getByText(/Copy them before the old vault goes\?/)).toBeTruthy();
		expect(l.queryByText(/stayed in the old vault/)).toBeNull();
		expect(screen.getByRole("button", { name: "Copy them anyway" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Leave them out" })).toBeTruthy();
	});

	it("gives each answer to the hook", () => {
		const copied = link(true);
		show(copied);
		fireEvent.click(screen.getByRole("button", { name: "Copy them anyway" }));
		expect(copied.copyHeldBack).toHaveBeenCalledOnce();
		expect(copied.removeOldVault).not.toHaveBeenCalled();
		cleanup();

		const left = link(true);
		show(left);
		fireEvent.click(screen.getByRole("button", { name: "Leave them out" }));
		expect(left.removeOldVault).toHaveBeenCalledOnce();
		expect(left.copyHeldBack).not.toHaveBeenCalled();
	});

	it("takes one answer: neither button works while it is being carried out", () => {
		show(link(true, true));
		for (const name of ["Copy them anyway", "Leave them out"]) {
			expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
		}
	});

	it("only offers the copy when the old vault stays, since nothing is lost by leaving them", () => {
		const l = show(link(false));
		expect(l.getByText(/stayed in the old vault/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy them anyway" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Leave them out" })).toBeNull();
	});
});

describe("what stayed with the desktop's own", () => {
	const REMOVE = "Remove the old vault";

	it("names the alias provider, and removing the old vault is one press away", () => {
		const waiting = link(true, false, { held: 0, alias: true });
		show(waiting);
		expect(screen.getByText(/has its own email alias provider/)).toBeTruthy();
		expect(screen.queryByText(/already has a backup target/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: REMOVE }));
		expect(waiting.removeOldVault).toHaveBeenCalledOnce();
	});

	it("names the backup targets", () => {
		show(link(true, false, { held: 0, backupTargets: true }));
		expect(screen.getByText(/already has a backup target/)).toBeTruthy();
		expect(screen.queryByText(/has its own email alias provider/)).toBeNull();
		expect(screen.getByRole("button", { name: REMOVE })).toBeTruthy();
	});

	it("takes the press once", () => {
		show(link(true, true, { held: 0, alias: true }));
		expect((screen.getByRole("button", { name: REMOVE }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("leaves the look-alikes' answer to remove the vault, with no second button", () => {
		show(link(true, false, { held: 2, alias: true }));
		expect(screen.getByRole("button", { name: "Leave them out" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
	});

	it("still says it with no button once the vault is gone or staying", () => {
		show(link(false, false, { held: 0, alias: true, backupTargets: true }));
		expect(screen.getByText(/has its own email alias provider/)).toBeTruthy();
		expect(screen.getByText(/already has a backup target/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
	});

	it("says nothing when all of it came across", () => {
		show(link(false, false, { held: 0 }));
		expect(screen.queryByText(/email alias provider/)).toBeNull();
		expect(screen.queryByText(/backup target/)).toBeNull();
		expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
	});
});
