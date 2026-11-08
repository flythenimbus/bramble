/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { OpenWebsiteLink } from "./OpenWebsiteLink";

const HREF = "https://example.com/login";

function mount(launchLogin: unknown, entryId: string | undefined = "e1", onOpen = vi.fn()) {
	const platform = { target: "chromium", shell: { launchLogin } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<OpenWebsiteLink href={HREF} entryId={entryId} onOpen={onOpen} />
			</PlatformProvider>
		</I18nProvider>,
	);
	return screen.getByRole("link", { name: "Open website" });
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

describe("OpenWebsiteLink", () => {
	it("launches the login on a plain left click, instead of following the link", () => {
		const launchLogin = vi.fn(async () => {});
		const onOpen = vi.fn();
		const link = mount(launchLogin, "e1", onOpen);
		// fireEvent returns false when the default was prevented.
		expect(fireEvent.click(link)).toBe(false);
		expect(launchLogin).toHaveBeenCalledWith("e1", HREF);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ctrl", { ctrlKey: true }],
		["cmd", { metaKey: true }],
		["shift", { shiftKey: true }],
		["alt", { altKey: true }],
	])("leaves a %s click to the browser", (_name, modifier) => {
		const launchLogin = vi.fn(async () => {});
		const link = mount(launchLogin);
		expect(fireEvent.click(link, modifier)).toBe(true);
		expect(launchLogin).not.toHaveBeenCalled();
	});

	it("stays a plain link where the platform has no launch", () => {
		expect(fireEvent.click(mount(undefined))).toBe(true);
	});

	it("stays a plain link when it isn't for a saved login", () => {
		const launchLogin = vi.fn(async () => {});
		expect(fireEvent.click(mount(launchLogin, ""))).toBe(true);
		expect(launchLogin).not.toHaveBeenCalled();
	});
});
