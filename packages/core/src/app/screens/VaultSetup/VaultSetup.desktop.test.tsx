/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import { initialSetupMode } from "./types";
import { VaultSetup, type VaultSetupMode } from "./VaultSetup";

// Option B from the design: a card above today's tabs for people who already use the desktop app.

vi.mock("../../hooks/useDesktopLink", () => ({
	useDesktopLink: () => ({
		busy: false,
		error: null,
		linking: null,
		legacy: false,
		invite: null,
		outcome: null,
		start: async () => {},
	}),
}));

vi.mock("../../hooks/usePopOut", () => ({
	usePopOut: () => ({ canPopOut: false, popOut: () => {} }),
}));

const withLink = {
	desktopLink: { status: async () => ({ paired: false }) },
} as unknown as Platform;
const withoutLink = {} as unknown as Platform;

function mount(platform: Platform, mode: VaultSetupMode, onModeChange = vi.fn()) {
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultSetup mode={mode} onModeChange={onModeChange} onCreate={async () => {}} />
			</PlatformProvider>
		</I18nProvider>,
	);
	return onModeChange;
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

describe("the desktop link on the setup screen", () => {
	it("offers to link the desktop app above the tabs", () => {
		const onModeChange = mount(withLink, "create");
		expect(screen.getByText(/using bramble desktop\?/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^link$/i }));
		expect(onModeChange).toHaveBeenCalledWith("desktop");
	});

	it("is not offered where there is no desktop app to link", () => {
		mount(withoutLink, "create");
		expect(screen.queryByText(/using bramble desktop\?/i)).toBeNull();
	});

	it("shows the link card in desktop mode, with a way back to the tabs", () => {
		const onModeChange = mount(withLink, "desktop");
		expect(screen.getByText(/connect a browser/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /back/i }));
		expect(onModeChange).toHaveBeenCalledWith("create");
	});

	it("comes back to the link card after the permission reload", () => {
		expect(initialSetupMode("?setup=desktop")).toBe("desktop");
		expect(initialSetupMode("")).toBe("create");
	});
});
