/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVaultRegistry, VaultRegistryProvider } from "./useVaultRegistry";

// A locked vault selection is React state only: shell.setActiveVault is called when a vault
// UNLOCKS, so a locked one is invisible to a new window. With several vaults the router then
// sends the detached window to the picker instead of the unlock screen it was opened for, which
// is what a device hit: "tap to unlock" popped out onto the vault selector. See PopOutHandoff.

function Probe() {
	const { activeId, ready } = useVaultRegistry();
	return <span data-testid="a">{ready ? (activeId ?? "none") : "loading"}</span>;
}

function mount(
	initialActiveId: string | undefined,
	vaults: { id: string; label: string; createdAt: number }[],
) {
	const platform = {
		storage: { getMeta: vi.fn(async () => ({ vaults })) },
		shell: { getActiveVault: vi.fn(async () => null) },
	} as unknown as Platform;
	return render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider initialActiveId={initialActiveId}>
				<Probe />
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
}

const TWO = [
	{ id: "v1", label: "One", createdAt: 1 },
	{ id: "v2", label: "Two", createdAt: 2 },
];

afterEach(cleanup);

describe("a detached window's starting vault", () => {
	it("boots on the vault it was handed, so it does not land on the picker", async () => {
		mount("v2", TWO);
		expect((await screen.findByTestId("a")).textContent).toBe("v2");
	});

	it("still shows the picker when handed nothing and several vaults exist", async () => {
		mount(undefined, TWO);
		expect((await screen.findByTestId("a")).textContent).toBe("none");
	});

	it("auto-selects a lone vault, which is why single-vault never showed the bug", async () => {
		mount(undefined, [{ id: "v1", label: "One", createdAt: 1 }]);
		expect((await screen.findByTestId("a")).textContent).toBe("v1");
	});
});
