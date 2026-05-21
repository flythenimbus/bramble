export type VaultSetupMode = "create" | "open";

export interface VaultSetupFormValues {
	masterPassword: string;
	confirmPassword: string;
}
