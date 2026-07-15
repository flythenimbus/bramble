import { VaultPicker } from "../screens/VaultPicker/VaultPicker";

/** Route wrapper for the vault picker; the "which screen to show" logic lives in beforeLoad. */
export function SelectVaultRoute() {
	return <VaultPicker />;
}
