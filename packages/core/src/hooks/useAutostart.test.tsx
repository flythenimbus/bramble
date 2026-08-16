/** @vitest-environment happy-dom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { resetAutostartCache, useAutostart } from "./useAutostart";

afterEach(() => {
	cleanup();
	resetAutostartCache();
});

function makePlatform(autostart?: {
	isEnabled: () => Promise<boolean>;
	setEnabled: (on: boolean) => Promise<void>;
}) {
	return { shell: { autostart } } as unknown as Platform;
}

/** Renders the hook's state, plus a button per direction so a click can drive it. */
function Probe({ label = "a" }: { label?: string }) {
	const { available, enabled, error, setEnabled } = useAutostart();
	return (
		<div>
			<span data-testid={`${label}-available`}>{String(available)}</span>
			<span data-testid={`${label}-enabled`}>{String(enabled)}</span>
			<span data-testid={`${label}-error`}>{error ?? ""}</span>
			<button type="button" onClick={() => void setEnabled(true)}>
				on-{label}
			</button>
		</div>
	);
}

describe("useAutostart", () => {
	it("is unavailable where the platform has no autostart", async () => {
		render(
			<PlatformProvider platform={makePlatform()}>
				<Probe />
			</PlatformProvider>,
		);
		expect(screen.getByTestId("a-available").textContent).toBe("false");
		// Never resolves to a boolean, so a Settings row keyed off `available` stays hidden.
		expect(screen.getByTestId("a-enabled").textContent).toBe("null");
	});

	it("reads the current state from the OS", async () => {
		const platform = makePlatform({
			isEnabled: vi.fn(async () => true),
			setEnabled: vi.fn(async () => {}),
		});
		render(
			<PlatformProvider platform={platform}>
				<Probe />
			</PlatformProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("a-enabled").textContent).toBe("true"));
	});

	// Guessing "off" would invite a second write of an entry that already exists.
	it("stays unknown when the read fails", async () => {
		const platform = makePlatform({
			isEnabled: vi.fn(async () => {
				throw new Error("no");
			}),
			setEnabled: vi.fn(async () => {}),
		});
		render(
			<PlatformProvider platform={platform}>
				<Probe />
			</PlatformProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("a-enabled").textContent).toBe("null"));
	});

	// The write is the request; the OS is the authority. A silent no-op would otherwise leave the
	// toggle asserting something untrue.
	it("re-reads after writing rather than trusting the write", async () => {
		const isEnabled = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(false);
		const platform = makePlatform({ isEnabled, setEnabled: vi.fn(async () => {}) });
		render(
			<PlatformProvider platform={platform}>
				<Probe />
			</PlatformProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("a-enabled").textContent).toBe("false"));
		await act(async () => screen.getByText("on-a").click());
		expect(isEnabled).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("a-enabled").textContent).toBe("false");
	});

	it("rolls back and reports when the write fails", async () => {
		const platform = makePlatform({
			isEnabled: vi.fn(async () => false),
			setEnabled: vi.fn(async () => {
				throw new Error("permission denied");
			}),
		});
		render(
			<PlatformProvider platform={platform}>
				<Probe />
			</PlatformProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("a-enabled").textContent).toBe("false"));
		await act(async () => screen.getByText("on-a").click());
		expect(screen.getByTestId("a-enabled").textContent).toBe("false");
		expect(screen.getByTestId("a-error").textContent).toBe("permission denied");
	});

	// Two Settings sections offer this at once. Per-instance state would leave the General toggle
	// claiming the opposite of what the Backups prompt just did.
	it("keeps every instance in step", async () => {
		const platform = makePlatform({
			isEnabled: vi.fn(async () => false),
			setEnabled: vi.fn(async () => {}),
		});
		render(
			<PlatformProvider platform={platform}>
				<Probe label="a" />
				<Probe label="b" />
			</PlatformProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("b-enabled").textContent).toBe("false"));
		await act(async () => screen.getByText("on-a").click());
		expect(screen.getByTestId("b-enabled").textContent).toBe("false"); // read-back said false
		expect(screen.getByTestId("a-enabled").textContent).toBe(
			screen.getByTestId("b-enabled").textContent,
		);
	});
});
