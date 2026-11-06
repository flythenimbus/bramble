// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";
import { CombineResult } from "./CombineResult";

type Link = ReturnType<typeof useDesktopLink>;

const link = (asking: boolean, answering = false) =>
	({
		combined: {
			heldBack: { items: [{ name: "a" }, { name: "b" }], attachments: [] },
			uncarried: 0,
			quarantined: 0,
			keptUnasked: false,
			pendingRemoval: asking ? { id: "v1", copied: {} } : null,
		},
		answeringHeldBack: answering,
		copyHeldBack: vi.fn(async () => {}),
		leaveOutHeldBack: vi.fn(async () => {}),
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
		expect(copied.leaveOutHeldBack).not.toHaveBeenCalled();
		cleanup();

		const left = link(true);
		show(left);
		fireEvent.click(screen.getByRole("button", { name: "Leave them out" }));
		expect(left.leaveOutHeldBack).toHaveBeenCalledOnce();
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
