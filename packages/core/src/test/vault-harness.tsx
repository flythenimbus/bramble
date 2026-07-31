// Shared mounting for the useVault action tests. Only the provider nesting lives here: each
// suite still builds its own platform stub, because what those stub out IS the test.
//
// Not a `.test.` file, so vitest won't collect it.

import { render } from "@testing-library/react";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVaultActions, VaultProvider } from "../hooks/useVault";
import { VaultRegistryProvider } from "../hooks/useVaultRegistry";

/**
 * Render the provider stack against `platform` and return a getter for the vault actions.
 * The getter (rather than the value) is what lets a test read the CURRENT actions after an
 * `act()`, instead of a stale closure from the first render.
 */
export function mountVaultActions(platform: Platform): () => ReturnType<typeof useVaultActions> {
	let actions: ReturnType<typeof useVaultActions> | null = null;
	function Consumer() {
		actions = useVaultActions();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider>
				<VaultProvider>
					<Consumer />
				</VaultProvider>
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
	return () => {
		if (!actions) throw new Error("actions not captured");
		return actions;
	};
}
