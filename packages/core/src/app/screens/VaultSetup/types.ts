export type VaultSetupMode = "create" | "join";

export interface VaultSetupFormValues {
	masterPassword: string;
	confirmPassword: string;
	/** Optional vault name (shown when adding a parallel vault); blank renders as "Vault N". */
	label: string;
}
