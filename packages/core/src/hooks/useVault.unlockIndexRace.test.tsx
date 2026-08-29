/** @vitest-environment happy-dom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// Unlocking is five steps and only the middle one is the password. The last publishes the autofill
// index, and the host refuses that write whenever the lease no longer names the current session.
// That refusal used to propagate: the VEK had already been unwrapped, so the vault was OPEN, and
// the throw meant setIsLocked(false) never ran. The user saw their correct master password rejected
// with the host's raw token, "unavailable", and it survived every reopen because the session
// generation only resets when the background worker restarts.
//
// Refusing is the SAFE outcome for the index (it keeps stale plaintext out of it). The bug was
// treating it as a failed unlock.

const VAULT_ID = "vault-1";

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01, // SLOT_KIND_PASSWORD
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(32),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(0),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

function makePlatform(autofillOver: Record<string, unknown>): {
	platform: Platform;
	setActiveVaultCalls: (string | null)[];
} {
	const setActiveVaultCalls: (string | null)[] = [];
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] }],
	]);
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			restoreVaultFromBackup: async () => false,
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			// The password is correct throughout. Every failure under test is downstream of it.
			unwrapVekPassword: async () => true,
			decryptEntries: async () => [],
			lock: async () => {},
		},
		autofill: {
			clearIndex: async () => {},
			setIndex: async () => {},
			...autofillOver,
		},
		shell: {
			// Recording null here is what left the host with no session owner to lease against.
			setActiveVault: async (id: string | null) => void setActiveVaultCalls.push(id),
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, setActiveVaultCalls };
}

describe("an autofill index refusal during unlock", () => {
	it("still unlocks when the index lease is refused", async () => {
		// The exact shape of the wedged background: no session owner, so no lease can be issued.
		const { platform } = makePlatform({
			beginIndexUpdate: async () => {
				throw new Error("unavailable");
			},
		});
		const { actions, state } = mountVault(platform);

		await waitFor(() => expect(actions().unlock).toBeTypeOf("function"));
		await actions().unlock("correct-horse");

		// Before the fix this rejected with "unavailable" and the vault stayed locked.
		await waitFor(() => expect(state().isLocked).toBe(false));
	});

	it("still unlocks when the index write itself is refused", async () => {
		// The other half: a lease was issued, then the session moved before the write landed.
		const { platform } = makePlatform({
			beginIndexUpdate: async () => ({ vaultId: VAULT_ID, token: "t" }),
			setIndex: async () => {
				throw new Error("unavailable");
			},
		});
		const { actions, state } = mountVault(platform);

		await waitFor(() => expect(actions().unlock).toBeTypeOf("function"));
		await actions().unlock("correct-horse");

		await waitFor(() => expect(state().isLocked).toBe(false));
	});

	it("never records a null active vault, which is what wedged the host", async () => {
		// The root cause: unlock() recorded `vaultId ?? activeId ?? null`, and a null there leaves
		// the background with no vault to resolve, hence no session owner, hence no lease.
		//
		// A GUARD, not a reproduction, and the difference is worth stating. The two tests above
		// fail without the fix; this one passes either way, because the registry resolves an
		// activeId here so the null branch is never taken. Reproducing that branch needs a vault to
		// unlock with no id resolved for it, which this harness cannot stage. It still earns its
		// place: it pins the invariant so a future edit cannot reintroduce the null write.
		const { platform, setActiveVaultCalls } = makePlatform({
			beginIndexUpdate: async () => ({ vaultId: VAULT_ID, token: "t" }),
		});
		const { actions } = mountVault(platform);

		await waitFor(() => expect(actions().unlock).toBeTypeOf("function"));
		await actions().unlock("correct-horse");

		expect(setActiveVaultCalls).not.toContain(null);
	});
});
