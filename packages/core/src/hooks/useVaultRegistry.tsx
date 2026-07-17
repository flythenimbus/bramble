import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { StorageAdapter } from "../adapters/storage";
import { usePlatform } from "../context/PlatformContext";
import { syncKeyFor } from "../sync/sync-keys";
import {
	addVault,
	EMPTY_REGISTRY,
	parseRegistry,
	removeVault,
	renameVault,
	VAULT_REGISTRY_KEY,
	type VaultRecord,
	type VaultRegistry,
} from "../vault/vault-registry";

export interface VaultRegistryValue {
	/** True once the registry has been read from storage. */
	ready: boolean;
	vaults: VaultRecord[];
	/** The vault at the flat blob slot (grandfathered, no id suffix on its blob or sync keys); also
	 * the fallback "default vault" before an active vault is selected. Null when none exists yet. */
	legacyBlobVaultId: string | null;
	/** The vault the app currently operates on, or undefined before it resolves (falls back to the
	 * legacy/default vault). */
	activeId: string | undefined;
	/**
	 * The per-vault storage key for a flat sync key (e.g. `"sync.group"`), namespaced to the
	 * active vault. The legacy vault keeps the flat key (no migration); others get `<key>:<id>`.
	 * Resolves against the active vault, falling back to the legacy vault before one is selected.
	 */
	syncKey: (flatKey: string) => string;
	/** Select which vault to operate on (one vault is active at a time). */
	selectVault: (id: string) => void;
	/** Clear the active selection so the picker is shown again (e.g. "switch vault"). */
	clearSelection: () => void;
	/** Register a new empty vault record and select it; returns its id. The blob is written separately. */
	createRecord: (label?: string) => Promise<string>;
	// rename/remove take no target id: they only ever act on the active vault, so a vault
	// can never rename or delete another vault.
	/** Rename the active vault (write-through to storage). */
	rename: (label: string) => Promise<void>;
	// Low-level state cleanup, NOT a delete: forget the active vault's registry record and
	// deselect it. It does not erase the blob and does not re-authenticate. The only place a
	// vault is actually deleted is useVault.deleteVault(), which re-auths, erases the blob,
	// then calls this. Do not call it directly to delete a vault.
	/** Forget the active vault's registry record (state only; no blob delete, no re-auth). */
	dropActiveRecord: () => Promise<void>;
	/** Re-read the registry from storage (after a create/rename/delete elsewhere). */
	refresh: () => Promise<void>;
}

// Value when no provider is mounted (e.g. isolated hook tests): the registry is "ready"
// and empty with no active id, so consumers resolve to the single/default vault via the
// storage adapter's id-omitted path. Keeps VaultProvider usable without this provider.
const DEFAULT: VaultRegistryValue = {
	ready: true,
	vaults: [],
	legacyBlobVaultId: null,
	activeId: undefined,
	syncKey: (k) => k,
	selectVault: () => {},
	clearSelection: () => {},
	createRecord: async () => "",
	rename: async () => {},
	dropActiveRecord: async () => {},
	refresh: async () => {},
};

const VaultRegistryContext = createContext<VaultRegistryValue>(DEFAULT);

export function useVaultRegistry(): VaultRegistryValue {
	return useContext(VaultRegistryContext);
}

/** Loads the device-local vault registry and tracks which vault is active. */
export function VaultRegistryProvider({ children }: { children: ReactNode }) {
	const { storage, shell } = usePlatform();
	const [ready, setReady] = useState(false);
	const [registry, setRegistry] = useState<VaultRegistry>(EMPTY_REGISTRY);
	const [activeId, setActiveId] = useState<string | undefined>(undefined);

	const refresh = useCallback(async () => {
		const reg = parseRegistry(await storage.getMeta(VAULT_REGISTRY_KEY));
		setRegistry(reg);
		// Restore the unlocked vault on reopen: while a vault is unlocked its id is recorded
		// (shell.setActiveVault), so jump straight to it instead of the picker. Otherwise
		// auto-select only when there's exactly one vault; several with none unlocked -> picker.
		const unlocked = (await shell?.getActiveVault?.()) ?? null;
		const restore = unlocked && reg.vaults.some((v) => v.id === unlocked) ? unlocked : undefined;
		setActiveId(
			(cur) => cur ?? restore ?? (reg.vaults.length === 1 ? reg.vaults[0]?.id : undefined),
		);
		setReady(true);
	}, [storage, shell]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selectVault = useCallback((id: string) => setActiveId(id), []);
	const clearSelection = useCallback(() => setActiveId(undefined), []);

	// Namespace a flat sync key to the active vault (fallback: the legacy/default vault, before one
	// is selected). The legacy vault keeps the flat key so its pairing survives with no migration.
	const syncKey = useCallback(
		(flatKey: string) => {
			const v = activeId ?? registry.legacyBlobVaultId;
			return v ? syncKeyFor(flatKey, v, registry.legacyBlobVaultId) : flatKey;
		},
		[activeId, registry.legacyBlobVaultId],
	);

	// Write a new registry to storage and reflect it in state.
	const persist = useCallback(
		async (next: VaultRegistry) => {
			await storage.setMeta(VAULT_REGISTRY_KEY, next);
			setRegistry(next);
		},
		[storage],
	);

	const createRecord = useCallback(
		async (label = "") => {
			const id = crypto.randomUUID();
			await persist(addVault(registry, { id, label, createdAt: Date.now() }));
			setActiveId(id);
			return id;
		},
		[registry, persist],
	);
	// rename/remove only ever act on the active vault (no target id), so a vault can never
	// rename or delete another vault.
	const rename = useCallback(
		async (label: string) => {
			if (activeId) await persist(renameVault(registry, activeId, label));
		},
		[registry, persist, activeId],
	);
	// State only: forget the active vault's record and deselect it. The blob is erased by
	// useVault.deleteVault() (after re-auth), which then calls this. Not a standalone delete.
	const dropActiveRecord = useCallback(async () => {
		if (!activeId) return;
		await persist(removeVault(registry, activeId));
		setActiveId(undefined);
	}, [registry, persist, activeId]);

	const value = useMemo<VaultRegistryValue>(
		() => ({
			ready,
			vaults: registry.vaults,
			legacyBlobVaultId: registry.legacyBlobVaultId,
			activeId,
			syncKey,
			selectVault,
			clearSelection,
			createRecord,
			rename,
			dropActiveRecord,
			refresh,
		}),
		[
			ready,
			registry,
			activeId,
			syncKey,
			selectVault,
			clearSelection,
			createRecord,
			rename,
			dropActiveRecord,
			refresh,
		],
	);

	return <VaultRegistryContext.Provider value={value}>{children}</VaultRegistryContext.Provider>;
}

/**
 * Bind a vault id to a StorageAdapter's blob methods so callers that pass no id operate on
 * the active vault instead of the primary. Metadata is device-global and passes through
 * unchanged. An explicit id still wins (`id ?? vaultId`), so per-vault calls keep working.
 */
export function makeVaultScopedStorage(
	storage: StorageAdapter,
	vaultId: string | undefined,
): StorageAdapter {
	return {
		hasVaultHandle: (id) => storage.hasVaultHandle(id ?? vaultId),
		readVaultBlob: (id) => storage.readVaultBlob(id ?? vaultId),
		writeVaultBlob: (blob, id) => storage.writeVaultBlob(blob, id ?? vaultId),
		restoreVaultFromBackup: (id) => storage.restoreVaultFromBackup(id ?? vaultId),
		// Delete always targets an explicit vault; no active-vault default.
		deleteVaultBlob: (id) => storage.deleteVaultBlob(id),
		// Device-global metadata: pass through untouched (the adapter methods don't use `this`).
		getMeta: storage.getMeta,
		setMeta: storage.setMeta,
		removeMeta: storage.removeMeta,
		subscribeMeta: storage.subscribeMeta,
	};
}
