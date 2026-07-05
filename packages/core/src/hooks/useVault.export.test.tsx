/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVaultActions, VaultProvider } from "./useVault";

afterEach(cleanup);

// hasVaultHandle=false makes the mount effect return early (no crypto/decrypt), which is all
// exportVault needs: it reads the blob straight from storage and hands it to shell.exportBytes.
function makePlatform(exportBytes?: (n: string, b: Uint8Array, m: string) => Promise<void>) {
	const storage = {
		hasVaultHandle: vi.fn(async () => false),
		readVaultBlob: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
	};
	const platform = {
		storage,
		crypto,
		autofill: {},
		shell: exportBytes ? { exportBytes } : {},
		clipboard: {},
	} as unknown as Platform;
	return { platform, storage };
}

function mountActions(platform: Platform) {
	let actions: ReturnType<typeof useVaultActions> | null = null;
	function Consumer() {
		actions = useVaultActions();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultProvider>
				<Consumer />
			</VaultProvider>
		</PlatformProvider>,
	);
	return () => {
		if (!actions) throw new Error("actions not captured");
		return actions;
	};
}

describe("exportVault", () => {
	it("reads the vault blob and hands it to shell.exportBytes as a dated .bramble file", async () => {
		const exportBytes = vi.fn<(n: string, b: Uint8Array, m: string) => Promise<void>>(
			async () => {},
		);
		const { platform, storage } = makePlatform(exportBytes);
		const getActions = mountActions(platform);
		await act(async () => {});

		await act(async () => {
			await getActions().exportVault();
		});

		expect(storage.readVaultBlob).toHaveBeenCalledTimes(1);
		expect(exportBytes).toHaveBeenCalledTimes(1);
		const call = exportBytes.mock.calls[0];
		if (!call) throw new Error("exportBytes was not called");
		const [name, bytes, mime] = call;
		expect(name).toMatch(/^bramble-vault-\d{4}-\d{2}-\d{2}\.bramble$/);
		expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(mime).toBe("application/octet-stream");
	});

	it("rejects when the platform can't save files (no shell.exportBytes)", async () => {
		const { platform } = makePlatform(undefined);
		const getActions = mountActions(platform);
		await act(async () => {});
		await expect(getActions().exportVault()).rejects.toThrow();
	});
});
