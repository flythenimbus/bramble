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
import {
	addVault,
	EMPTY_REGISTRY,
	parseRegistry,
	VAULT_REGISTRY_KEY,
	type VaultRecord,
	type VaultRegistry,
} from "../vault/vault-registry";

export interface VaultRegistryValue {
	/** True once the registry has been read from storage. */
	ready: boolean;
	vaults: VaultRecord[];
	primaryId: string | null;
	/** The vault the app currently operates on, or undefined before it resolves (falls back to the primary). */
	activeId: string | undefined;
	/** Select which vault to operate on (one vault is active at a time). */
	selectVault: (id: string) => void;
	/** Clear the active selection so the picker is shown again (e.g. "switch vault"). */
	clearSelection: () => void;
	/** Register a new empty vault record and select it; returns its id. The blob is written separately. */
	createRecord: (label?: string) => Promise<string>;
	/** Re-read the registry from storage (after a create/rename/delete elsewhere). */
	refresh: () => Promise<void>;
}

// Value when no provider is mounted (e.g. isolated hook tests): the registry is "ready"
// and empty with no active id, so consumers resolve to the single/primary vault via the
// storage adapter's id-omitted path. Keeps VaultProvider usable without this provider.
const DEFAULT: VaultRegistryValue = {
	ready: true,
	vaults: [],
	primaryId: null,
	activeId: undefined,
	selectVault: () => {},
	clearSelection: () => {},
	createRecord: async () => "",
	refresh: async () => {},
};

const VaultRegistryContext = createContext<VaultRegistryValue>(DEFAULT);

export function useVaultRegistry(): VaultRegistryValue {
	return useContext(VaultRegistryContext);
}

/** Loads the device-local vault registry and tracks which vault is active. */
export function VaultRegistryProvider({ children }: { children: ReactNode }) {
	const { storage } = usePlatform();
	const [ready, setReady] = useState(false);
	const [registry, setRegistry] = useState<VaultRegistry>(EMPTY_REGISTRY);
	const [activeId, setActiveId] = useState<string | undefined>(undefined);

	const refresh = useCallback(async () => {
		const reg = parseRegistry(await storage.getMeta(VAULT_REGISTRY_KEY));
		setRegistry(reg);
		// Auto-select only when there's exactly one vault (direct unlock). With several, the
		// active id stays unset so the picker shows; keep an explicit selection once made.
		setActiveId((cur) => cur ?? (reg.vaults.length === 1 ? reg.vaults[0]?.id : undefined));
		setReady(true);
	}, [storage]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selectVault = useCallback((id: string) => setActiveId(id), []);
	const clearSelection = useCallback(() => setActiveId(undefined), []);

	const createRecord = useCallback(
		async (label = "") => {
			const id = crypto.randomUUID();
			const next = addVault(registry, { id, label, createdAt: Date.now() });
			await storage.setMeta(VAULT_REGISTRY_KEY, next);
			setRegistry(next);
			setActiveId(id);
			return id;
		},
		[registry, storage],
	);

	const value = useMemo<VaultRegistryValue>(
		() => ({
			ready,
			vaults: registry.vaults,
			primaryId: registry.primaryId,
			activeId,
			selectVault,
			clearSelection,
			createRecord,
			refresh,
		}),
		[ready, registry, activeId, selectVault, clearSelection, createRecord, refresh],
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
		// Device-global metadata: pass through untouched (the adapter methods don't use `this`).
		getMeta: storage.getMeta,
		setMeta: storage.setMeta,
		removeMeta: storage.removeMeta,
		subscribeMeta: storage.subscribeMeta,
	};
}
