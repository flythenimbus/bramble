/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import { EntryForm } from "./EntryForm";

vi.mock("../../../hooks/useVault", () => ({ useVaultState: () => ({ entries: [] }) }));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function renderForm(onSave: () => Promise<void>, pendingNativeCalls?: () => string[]) {
	const platform = { shell: { pendingNativeCalls } } as unknown as Platform;
	const wrapper = ({ children }: { children: ReactNode }) => (
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>{children}</PlatformProvider>
		</I18nProvider>
	);
	render(<EntryForm type="note" submitLabel="Save note" onBack={() => {}} onSave={onSave} />, {
		wrapper,
	});
}

describe("EntryForm: a save that doesn't finish", () => {
	it("says so after 15 seconds, with the native calls it is waiting on", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderForm(
			() => new Promise<void>(() => {}),
			() => ["NativeWebRTC.send 42s"],
		);

		fireEvent.click(screen.getByRole("button", { name: "Save note" }));
		await screen.findByRole("button", { name: "Saving…" });
		expect(screen.queryByText(/taking longer than it should/)).toBeNull();

		await act(() => vi.advanceTimersByTimeAsync(15_000));
		expect(screen.getByText(/taking longer than it should/)).toBeTruthy();
		expect(screen.getByText("NativeWebRTC.send 42s")).toBeTruthy();
	});

	it("shows nothing for a save that finishes in time", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onSave = vi.fn(async () => {});
		renderForm(onSave, () => ["NativeWebRTC.send 42s"]);

		fireEvent.click(screen.getByRole("button", { name: "Save note" }));
		await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
		await act(() => vi.advanceTimersByTimeAsync(20_000));
		expect(screen.queryByText(/taking longer than it should/)).toBeNull();
	});
});
