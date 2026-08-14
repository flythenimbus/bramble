/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackupTargetConfig, backupTargetsKeyFor } from "../backup/config";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { useBackup } from "./useBackup";
import { VaultRegistryProvider } from "./useVaultRegistry";

afterEach(cleanup);

const VAULT = "11111111-2222-4333-8444-555555555555";

/** A target whose credentials are wrapped under the vault key: the state a machine with no
 * credential store leaves behind, and what the upgrade is supposed to move. */
function wrapped(id = "t1"): BackupTargetConfig {
	return {
		id,
		providerId: "nextcloud",
		provider: "webdav",
		serverUrl: "https://cloud.example.com/remote.php/dav/files/me/",
		frequency: "daily",
		keep: 30,
		creds: { iv: "IV", ciphertext: "CT" },
	};
}

function makePlatform(opts: { unattended: boolean; targets?: BackupTargetConfig[] }) {
	const store = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT, label: "", createdAt: 1 }] }],
		[backupTargetsKeyFor(VAULT), opts.targets ?? [wrapped()]],
	]);
	const backupCreds = {
		status: vi.fn(async () => ({ unattended: opts.unattended })),
		save: vi.fn(async () => {}),
		remove: vi.fn(async () => {}),
		transport: vi.fn(),
		transportWithSecrets: vi.fn(),
	};
	const platform = {
		storage: {
			getMeta: vi.fn(async (k: string) => store.get(k)),
			setMeta: vi.fn(async (k: string, v: unknown) => {
				store.set(k, v);
			}),
			removeMeta: vi.fn(async (k: string) => {
				store.delete(k);
			}),
		},
		crypto: {
			decryptWithVek: vi.fn(async () =>
				JSON.stringify({ username: "admin", password: "app-password" }),
			),
			encryptWithVek: vi.fn(async () => ({ iv: "IV2", ciphertext: "CT2" })),
		},
		shell: {},
		backupCreds,
	} as unknown as Platform;
	return { platform, backupCreds, store };
}

function mount(platform: Platform) {
	function Consumer() {
		useBackup();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider>
				<Consumer />
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
}

// The app chooses where credentials live and never asks, which is exactly what makes moving them
// afterwards safe: there is no preference to respect, only a best available place.
describe("credential upgrade", () => {
	it("moves a vault-wrapped credential into the store once one is available", async () => {
		const { platform, backupCreds, store } = makePlatform({ unattended: true });
		mount(platform);
		await act(async () => {});
		await act(async () => {});

		expect(backupCreds.save).toHaveBeenCalledWith(
			VAULT,
			"t1",
			{ username: "admin", password: "app-password" },
			// Pinned to the origin the target already addresses, not the whole URL.
			"https://cloud.example.com",
		);
		const saved = store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[];
		expect(saved[0]?.creds).toEqual({ wrap: "os" });
	});

	it("leaves credentials alone where nothing can hold them outside the vault", async () => {
		const { platform, backupCreds, store } = makePlatform({ unattended: false });
		mount(platform);
		await act(async () => {});
		await act(async () => {});

		expect(backupCreds.save).not.toHaveBeenCalled();
		const saved = store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[];
		expect(saved[0]?.creds).toEqual({ iv: "IV", ciphertext: "CT" });
	});

	// A credential wrapped under a DIFFERENT vault's key (the device-global era) cannot be
	// unwrapped here. It has to keep working as it does rather than be dropped or half-moved.
	it("leaves a credential it cannot unwrap exactly where it is", async () => {
		const { platform, backupCreds, store } = makePlatform({ unattended: true });
		(platform.crypto.decryptWithVek as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("aead::Error"),
		);
		mount(platform);
		await act(async () => {});
		await act(async () => {});

		expect(backupCreds.save).not.toHaveBeenCalled();
		const saved = store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[];
		expect(saved[0]?.creds).toEqual({ iv: "IV", ciphertext: "CT" });
	});

	it("does not touch a target whose credentials are already outside the vault", async () => {
		const already: BackupTargetConfig = { ...wrapped(), creds: { wrap: "os" } };
		const { platform, backupCreds } = makePlatform({ unattended: true, targets: [already] });
		mount(platform);
		await act(async () => {});
		await act(async () => {});

		expect(backupCreds.save).not.toHaveBeenCalled();
		expect(platform.crypto.decryptWithVek).not.toHaveBeenCalled();
	});
});
