/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { Target } from "../../../../flags";
import { setDevFlagsOpener } from "../../../dev-flags-open";
import { AboutSection } from "./AboutSection";

// The tap run is the only way into the flag panel on a phone, so "seven taps opens it" is load
// bearing: too few and it opens by accident in front of a user, too many (or a reset that never
// fires) and there is no way to arm a store-review ask on a device build at all.

const VERSION = "1.4.3";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	setDevFlagsOpener(null);
	vi.useRealTimers();
});

function mount(target: Target = "ios") {
	const opened = vi.fn();
	setDevFlagsOpener(opened);
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={{ target, shell: { version: VERSION } } as unknown as Platform}>
				<AboutSection />
			</PlatformProvider>
		</I18nProvider>,
	);
	return { opened };
}

const version = () => screen.getByRole("button", { name: VERSION });
const tap = (times: number) => {
	for (let i = 0; i < times; i++) fireEvent.click(version());
};

describe("AboutSection version taps", () => {
	it("stays shut short of the full run", () => {
		const h = mount();
		tap(6);
		expect(h.opened).not.toHaveBeenCalled();
	});

	it("opens the panel on the seventh tap", () => {
		const h = mount();
		tap(7);
		expect(h.opened).toHaveBeenCalledOnce();
	});

	it("resets after a pause, so idle taps never accumulate", () => {
		vi.useFakeTimers();
		const h = mount();
		tap(6);
		// Longer than the window: the run is abandoned, not banked.
		vi.advanceTimersByTime(4000);
		tap(6);
		expect(h.opened).not.toHaveBeenCalled();
		tap(1);
		expect(h.opened).toHaveBeenCalledOnce();
	});

	it("needs a fresh run for a second opening", () => {
		const h = mount();
		tap(7);
		tap(1);
		expect(h.opened).toHaveBeenCalledOnce();
		tap(6);
		expect(h.opened).toHaveBeenCalledTimes(2);
	});
});

describe("AboutSection review link", () => {
	it("offers the store link where there is a listing", () => {
		mount("ios");
		expect(screen.getByRole("link", { name: /leave a review/i })).toHaveProperty(
			"href",
			expect.stringContaining("apps.apple.com"),
		);
	});

	it("hides it where there is none, rather than linking nowhere", () => {
		mount("android");
		expect(screen.queryByRole("link", { name: /leave a review/i })).toBeNull();
	});
});
