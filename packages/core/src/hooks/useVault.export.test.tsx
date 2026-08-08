/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVaultActions, VaultProvider } from "./useVault";

afterEach(cleanup);

// VaultProvider translates the errors it rejects with; an empty catalog keeps source strings.
i18n.load("en", {});
i18n.activate("en");

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
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultProvider>
					<Consumer />
				</VaultProvider>
			</PlatformProvider>
		</I18nProvider>,
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

// exportKdbx needs a saveKdbx-capable crypto adapter as well as a save mechanism; both are
// optional on the CryptoAdapter/ShellAdapter, so each absence has its own guard.
function makeKdbxPlatform(opts: {
	exportBytes?: (n: string, b: Uint8Array, m: string) => Promise<void>;
	saveKdbx?: (i: { entries: unknown[]; password: string }) => Promise<string>;
}) {
	const storage = {
		hasVaultHandle: vi.fn(async () => false),
		readVaultBlob: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		...(opts.saveKdbx ? { saveKdbx: opts.saveKdbx } : {}),
	};
	const platform = {
		storage,
		crypto,
		autofill: {},
		shell: opts.exportBytes ? { exportBytes: opts.exportBytes } : {},
		clipboard: {},
	} as unknown as Platform;
	return platform;
}

describe("exportKdbx", () => {
	it("writes a dated .kdbx from the bytes saveKdbx returns", async () => {
		const exportBytes = vi.fn<(n: string, b: Uint8Array, m: string) => Promise<void>>(
			async () => {},
		);
		// base64 for [222, 173, 190, 239]
		const saveKdbx = vi.fn(async () => "3q2+7w==");
		const getActions = mountActions(makeKdbxPlatform({ exportBytes, saveKdbx }));

		await act(async () => {
			await getActions().exportKdbx("file-password");
		});

		expect(saveKdbx).toHaveBeenCalledWith({ entries: [], password: "file-password" });
		const call = exportBytes.mock.calls[0];
		if (!call) throw new Error("exportBytes was not called");
		expect(call[0]).toMatch(/^bramble-vault-\d{4}-\d{2}-\d{2}\.kdbx$/);
		expect(Array.from(call[1])).toEqual([222, 173, 190, 239]);
	});

	it("rejects without a save mechanism, before asking for any crypto", async () => {
		const saveKdbx = vi.fn(async () => "3q2+7w==");
		const getActions = mountActions(makeKdbxPlatform({ saveKdbx }));

		await expect(getActions().exportKdbx("pw")).rejects.toThrow(/Export isn't available/);
		expect(saveKdbx).not.toHaveBeenCalled();
	});

	it("rejects where the crypto adapter can't write a .kdbx", async () => {
		const getActions = mountActions(makeKdbxPlatform({ exportBytes: async () => {} }));

		await expect(getActions().exportKdbx("pw")).rejects.toThrow(/KDBX export isn't available/);
	});

	it("rejects an empty password rather than writing an unopenable file", async () => {
		const saveKdbx = vi.fn(async () => "3q2+7w==");
		const getActions = mountActions(makeKdbxPlatform({ exportBytes: async () => {}, saveKdbx }));

		await expect(getActions().exportKdbx("")).rejects.toThrow(/Choose a password/);
		expect(saveKdbx).not.toHaveBeenCalled();
	});
});
