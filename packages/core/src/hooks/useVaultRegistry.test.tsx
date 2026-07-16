/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../adapters/storage";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { addVault, EMPTY_REGISTRY, VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import {
	makeVaultScopedStorage,
	useVaultRegistry,
	VaultRegistryProvider,
	type VaultRegistryValue,
} from "./useVaultRegistry";

afterEach(cleanup);

function mount(stored: unknown) {
	const getMeta = vi.fn(async (key: string) => (key === VAULT_REGISTRY_KEY ? stored : undefined));
	const setMeta = vi.fn(async () => {});
	const deleteVaultBlob = vi.fn(async () => {});
	const platform = { storage: { getMeta, setMeta, deleteVaultBlob } } as unknown as Platform;
	let value: VaultRegistryValue | null = null;
	function Consumer() {
		value = useVaultRegistry();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider>
				<Consumer />
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
	const get = () => {
		if (!value) throw new Error("registry value not captured");
		return value;
	};
	return { get, setMeta, deleteVaultBlob };
}

const one = addVault(EMPTY_REGISTRY, { id: "a", label: "Personal", createdAt: 1 });
const two = addVault(one, { id: "b", label: "Work", createdAt: 2 });

describe("VaultRegistryProvider", () => {
	it("auto-selects the vault when exactly one exists", async () => {
		const { get } = mount(one);
		await act(async () => {});
		const v = get();
		expect(v.ready).toBe(true);
		expect(v.vaults.map((r) => r.id)).toEqual(["a"]);
		expect(v.activeId).toBe("a");
	});

	it("does not auto-select when several vaults exist (picker)", async () => {
		const { get } = mount(two);
		await act(async () => {});
		const v = get();
		expect(v.vaults.map((r) => r.id)).toEqual(["a", "b"]);
		expect(v.primaryId).toBe("a");
		expect(v.activeId).toBeUndefined();
	});

	it("selectVault and clearSelection move the active vault", async () => {
		const { get } = mount(two);
		await act(async () => {});
		await act(async () => {
			get().selectVault("b");
		});
		expect(get().activeId).toBe("b");
		await act(async () => {
			get().clearSelection();
		});
		expect(get().activeId).toBeUndefined();
	});

	it("createRecord registers a new vault, selects it, and persists", async () => {
		const { get, setMeta } = mount(one);
		await act(async () => {});
		let newId = "";
		await act(async () => {
			newId = await get().createRecord("Work");
		});
		const v = get();
		expect(v.vaults.map((r) => r.id)).toEqual(["a", newId]);
		expect(v.vaults[1]?.label).toBe("Work");
		expect(v.activeId).toBe(newId);
		expect(setMeta).toHaveBeenCalledWith(
			VAULT_REGISTRY_KEY,
			expect.objectContaining({ primaryId: "a" }),
		);
	});

	it("is ready with no vaults and no active id on a fresh install", async () => {
		const { get } = mount(undefined);
		await act(async () => {});
		const v = get();
		expect(v.ready).toBe(true);
		expect(v.vaults).toEqual([]);
		expect(v.primaryId).toBeNull();
		expect(v.activeId).toBeUndefined();
	});

	it("rename renames the active vault", async () => {
		const { get } = mount(two);
		await act(async () => {});
		await act(async () => {
			get().selectVault("b");
		});
		await act(async () => {
			await get().rename("Family");
		});
		expect(get().vaults.find((v) => v.id === "b")?.label).toBe("Family");
	});

	it("setPrimaryVault changes the primary", async () => {
		const { get } = mount(two);
		await act(async () => {});
		await act(async () => {
			await get().setPrimaryVault("b");
		});
		expect(get().primaryId).toBe("b");
	});

	it("remove deletes the active vault's blob + record and deselects it", async () => {
		const { get, deleteVaultBlob } = mount(two);
		await act(async () => {});
		await act(async () => {
			get().selectVault("b");
		});
		expect(get().activeId).toBe("b");
		await act(async () => {
			await get().remove();
		});
		expect(deleteVaultBlob).toHaveBeenCalledWith("b");
		expect(get().vaults.map((v) => v.id)).toEqual(["a"]);
		expect(get().activeId).toBeUndefined();
	});

	it("rename and remove do nothing when no vault is active (can't target another)", async () => {
		const { get, deleteVaultBlob } = mount(two);
		await act(async () => {});
		expect(get().activeId).toBeUndefined();
		await act(async () => {
			await get().rename("Nope");
		});
		await act(async () => {
			await get().remove();
		});
		expect(get().vaults.map((v) => v.id)).toEqual(["a", "b"]);
		expect(deleteVaultBlob).not.toHaveBeenCalled();
	});
});

describe("makeVaultScopedStorage", () => {
	it("binds the vault id to blob methods and passes metadata through", async () => {
		const seen: Record<string, unknown> = {};
		const base = {
			readVaultBlob: vi.fn(async (id?: string) => {
				seen.read = id;
				return new Uint8Array();
			}),
			writeVaultBlob: vi.fn(async (_b: Uint8Array, id?: string) => {
				seen.write = id;
			}),
			hasVaultHandle: vi.fn(async (id?: string) => {
				seen.has = id;
				return true;
			}),
			restoreVaultFromBackup: vi.fn(async (id?: string) => {
				seen.restore = id;
				return false;
			}),
			getMeta: vi.fn(async () => "meta"),
		} as unknown as StorageAdapter;
		const scoped = makeVaultScopedStorage(base, "vault-x");

		await scoped.readVaultBlob();
		await scoped.writeVaultBlob(new Uint8Array());
		await scoped.hasVaultHandle();
		await scoped.restoreVaultFromBackup();
		expect(seen).toEqual({ read: "vault-x", write: "vault-x", has: "vault-x", restore: "vault-x" });

		// An explicit id still wins over the bound one.
		await scoped.readVaultBlob("other");
		expect(seen.read).toBe("other");

		// Metadata passes through unchanged.
		expect(await scoped.getMeta("k")).toBe("meta");
	});

	it("passes undefined (primary) when no vault id is bound", async () => {
		const read = vi.fn(async () => new Uint8Array());
		const base = { readVaultBlob: read } as unknown as StorageAdapter;
		await makeVaultScopedStorage(base, undefined).readVaultBlob();
		expect(read).toHaveBeenCalledWith(undefined);
	});
});
