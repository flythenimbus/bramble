/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	type BackupTargetConfig,
	backupTargetsKeyFor,
	FOREIGN_CREDS_ERROR,
} from "../backup/config";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { useBackup } from "./useBackup";
import { VaultRegistryProvider } from "./useVaultRegistry";

// What a vault sees when it inherits a target from the device-global era: the config is in its
// list, but the secret was sealed under whichever vault entered it, so the unwrap fails here and
// nowhere else. The message that failure turns into is the whole point, because the raw one is
// `aes decrypt: aead::Error`, which tells the reader nothing they can act on.

afterEach(cleanup);

const VAULT = "11111111-2222-4333-8444-555555555555";

const inherited: BackupTargetConfig = {
	id: "t1",
	providerId: "s3",
	provider: "s3",
	endpoint: "https://s3.example.com",
	bucket: "backups",
	frequency: "daily",
	keep: 30,
	creds: { iv: "IV", ciphertext: "CT" },
	// Set by the migration on every copy it hands out.
	sharedFolder: true,
};

function makePlatform() {
	const store = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT, label: "", createdAt: 1 }] }],
		[backupTargetsKeyFor(VAULT), [inherited]],
	]);
	const platform = {
		storage: {
			getMeta: vi.fn(async (k: string) => store.get(k)),
			setMeta: vi.fn(async (k: string, v: unknown) => {
				store.set(k, v);
			}),
			removeMeta: vi.fn(async (k: string) => {
				store.delete(k);
			}),
			readVaultBlob: vi.fn(async () => new Uint8Array([1, 2, 3])),
		},
		// The vault key this hook has is not the one the credential was sealed under.
		crypto: {
			decryptWithVek: vi.fn(async () => {
				throw new Error("aes decrypt: aead::Error");
			}),
			encryptWithVek: vi.fn(async () => ({ iv: "IV2", ciphertext: "CT2" })),
		},
		shell: {},
	} as unknown as Platform;
	return { platform, store };
}

/** Render the hook and hand back its last value. */
function mount(platform: Platform) {
	const seen: { current: ReturnType<typeof useBackup> | null } = { current: null };
	function Probe() {
		seen.current = useBackup();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider>
				<Probe />
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
	return seen;
}

it("records a credential from another vault as that, not as a crypto error", async () => {
	const { platform, store } = makePlatform();
	const hook = mount(platform);
	await act(async () => {});
	expect(hook.current?.targets).toHaveLength(1);

	await act(async () => {
		await hook.current?.backupNow();
	});

	const stored = store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[];
	const target = stored[0] as BackupTargetConfig;
	expect(target.lastError).toBe(FOREIGN_CREDS_ERROR);
	// The raw failure must not reach storage: it is persisted, shown in a settings row, and
	// unactionable. The panel maps the code to something a reader can do something about.
	expect(target.lastError).not.toContain("aead");
	// Still a failure in every other respect, so the backoff and the retry line behave as they
	// do for a server that refused.
	expect(target.failures).toBe(1);
	expect(target.failedAt).toBeGreaterThan(0);
	expect(target.lastBackupAt).toBeUndefined();
});
