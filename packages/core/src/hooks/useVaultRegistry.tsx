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
		// Default the active vault to the primary; keep an explicit selection once made.
		setActiveId((cur) => cur ?? reg.primaryId ?? undefined);
		setReady(true);
	}, [storage]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selectVault = useCallback((id: string) => setActiveId(id), []);

	const value = useMemo<VaultRegistryValue>(
		() => ({
			ready,
			vaults: registry.vaults,
			primaryId: registry.primaryId,
			activeId,
			selectVault,
			refresh,
		}),
		[ready, registry, activeId, selectVault, refresh],
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
