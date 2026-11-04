export type VaultSetupMode = "create" | "join" | "restore" | "desktop";

export interface VaultSetupFormValues {
	masterPassword: string;
	confirmPassword: string;
	/** Optional vault name (shown when adding a parallel vault); blank renders as "Vault N". */
	label: string;
}

/** The setup screen's first mode. `?setup=desktop` survives the reload that granting the
 * browser permission forces, so the user lands back on the link card. */
export function initialSetupMode(search: string): VaultSetupMode {
	return new URLSearchParams(search).get("setup") === "desktop" ? "desktop" : "create";
}
