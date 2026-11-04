/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// Linking removes the browser's empty vault once the desktop's has arrived. It is the one path
// that removes a vault other than the open one, so it re-checks emptiness itself, every time.

function makePlatform(meta: Record<string, unknown> = {}) {
	let registry = {
		vaults: [
			{ id: "active", label: "Home", createdAt: 1 },
			{ id: "old", label: "", createdAt: 2 },
		],
	};
	const storage = {
		hasVaultHandle: vi.fn(async () => false),
		getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : meta[k])),
		setMeta: vi.fn(async (k: string, v: unknown) => {
			if (k === VAULT_REGISTRY_KEY) registry = v as typeof registry;
		}),
		removeMeta: vi.fn(async () => {}),
		deleteVaultBlob: vi.fn(async (_id: string) => {}),
	};
	const platform = {
		storage,
		crypto: {
			isLocked: vi.fn(async () => true),
			onExternalLock: vi.fn(() => () => {}),
			onExternalChange: vi.fn(() => () => {}),
		},
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell: { getActiveVault: vi.fn(async () => "active"), setActiveVault: vi.fn(async () => {}) },
		clipboard: {},
	} as unknown as Platform;
	return { platform, storage, registry: () => registry };
}

async function deleteEmpty(platform: Platform, id: string, count = 0) {
	const getActions = mountVaultActions(platform);
	await act(async () => {});
	let ok: boolean | undefined;
	await act(async () => {
		ok = await getActions().deleteEmptyVault(id, count);
	});
	return ok;
}

describe("deleteEmptyVault", () => {
	it("erases a vault that holds nothing and forgets its record", async () => {
		const { platform, storage, registry } = makePlatform();
		expect(await deleteEmpty(platform, "old")).toBe(true);
		expect(storage.deleteVaultBlob).toHaveBeenCalledWith("old");
		expect(registry().vaults.map((v) => v.id)).toEqual(["active"]);
	});

	it("refuses a vault that gained an entry since the check", async () => {
		const { platform, storage } = makePlatform();
		expect(await deleteEmpty(platform, "old", 1)).toBe(false);
		expect(storage.deleteVaultBlob).not.toHaveBeenCalled();
	});

	it("refuses a vault another device still syncs", async () => {
		const { platform, storage } = makePlatform({
			"sync.group:old": { roster: { devices: [{ publicKey: "a" }, { publicKey: "b" }] } },
		});
		expect(await deleteEmpty(platform, "old")).toBe(false);
		expect(storage.deleteVaultBlob).not.toHaveBeenCalled();
	});

	it("never removes the open vault", async () => {
		const { platform, storage } = makePlatform();
		expect(await deleteEmpty(platform, "active")).toBe(false);
		expect(storage.deleteVaultBlob).not.toHaveBeenCalled();
	});
});
