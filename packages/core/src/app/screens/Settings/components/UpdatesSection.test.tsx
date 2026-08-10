/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { UpdatesSection } from "./UpdatesSection";

// The desktop can be told to update from two places: this section, and the native dialog shown at
// launch. That second one is why progress is subscribed rather than local state — a section that
// only knew about its own clicks would offer "Check for updates" while the app was busy
// downloading itself, and then restart with no warning.

const h = vi.hoisted(() => ({
	/** Progress subscribers, so a test can push a download that this section did not start. */
	watchers: new Set<(f: number | null | undefined) => void>(),
	installs: 0,
}));

function platformWithUpdates(): Platform {
	return {
		target: "desktop",
		shell: {
			updates: {
				check: async () => ({ version: "1.2.0" }),
				install: async () => {
					h.installs++;
				},
				onProgress: (cb: (f: number | null | undefined) => void) => {
					h.watchers.add(cb);
					cb(undefined);
					return () => h.watchers.delete(cb);
				},
			},
		},
	} as unknown as Platform;
}

function mount(platform: Platform) {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<UpdatesSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

/** Push progress the way the adapter does when a download starts elsewhere. */
async function pushProgress(fraction: number | null | undefined) {
	await act(async () => {
		for (const w of h.watchers) w(fraction);
	});
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	h.watchers.clear();
	h.installs = 0;
});

describe("UpdatesSection", () => {
	it("renders away where the host cannot update itself", () => {
		// The extension is updated by the store; offering a button here would be a lie.
		const { container } = mount({ target: "extension", shell: {} } as unknown as Platform);

		expect(container.textContent).toBe("");
	});

	it("shows a download it did not start", async () => {
		// The launch dialog starts the install and routes here. Nothing was clicked in this
		// component, so its own state says idle.
		mount(platformWithUpdates());
		expect(screen.getByText(/check for updates/i)).toBeTruthy();

		await pushProgress(0.42);

		expect(screen.getByText(/downloading 42%/i)).toBeTruthy();
		expect(screen.queryByText(/check for updates/i)).toBeNull();
	});

	it("falls back to a label when the server sent no length", async () => {
		// A bar pinned at zero reads as stuck, which is worse than not showing a number.
		mount(platformWithUpdates());

		await pushProgress(null);

		expect(screen.getByText(/downloading…/i)).toBeTruthy();
	});

	it("does not offer to start a second download while one is running", async () => {
		mount(platformWithUpdates());

		await pushProgress(0.1);

		const buttons = screen.getAllByRole("button");
		expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
		expect(h.installs).toBe(0);
	});
});
