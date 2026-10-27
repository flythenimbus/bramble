/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TRANSFER_INTERRUPTED } from "../adapters/http";
import {
	type BackupTargetConfig,
	backupTargetsKeyFor,
	FOREIGN_CREDS_ERROR,
} from "../backup/config";
import type { Platform } from "../context/PlatformContext";
import { mountBackup } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

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

function makePlatform({ locked = false } = {}) {
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
			isLocked: vi.fn(async () => locked),
		},
		shell: {},
	} as unknown as Platform;
	return { platform, store };
}

it("records a credential from another vault as that, not as a crypto error", async () => {
	const { platform, store } = makePlatform();
	const hook = mountBackup(platform);
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

// Leaving the app mid-backup locks it, and the key goes with it: the credential then fails to open
// for that reason alone. Calling it another vault's would send someone to re-enter credentials that
// are fine, and back the target off as if the provider had refused.
it("records a credential that fails because the vault locked as interrupted", async () => {
	const { platform, store } = makePlatform({ locked: true });
	const hook = mountBackup(platform);
	await act(async () => {});

	await act(async () => {
		await hook.current?.backupNow();
	});

	const target = (
		store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[]
	)[0] as BackupTargetConfig;
	expect(target.lastError).toBe(TRANSFER_INTERRUPTED);
	expect(target.failures).toBeUndefined();
	expect(target.failedAt).toBeUndefined();
});
