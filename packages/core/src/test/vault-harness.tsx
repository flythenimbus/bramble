// Shared mounting for the useVault action tests. Only the provider nesting lives here: each
// suite still builds its own platform stub, because what those stub out IS the test.
//
// Not a `.test.` file, so vitest won't collect it.

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { render } from "@testing-library/react";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVault, useVaultActions, VaultProvider } from "../hooks/useVault";
import { useVaultRegistry, VaultRegistryProvider } from "../hooks/useVaultRegistry";

// VaultProvider translates the errors it rejects with, so it needs a live i18n context.
// An empty catalog resolves every id to its source string, which is what assertions read.
i18n.load("en", {});
i18n.activate("en");

/**
 * Render the provider stack against `platform` and return a getter for the vault actions.
 * The getter (rather than the value) is what lets a test read the CURRENT actions after an
 * `act()`, instead of a stale closure from the first render.
 */
export function mountVaultActions(platform: Platform): () => ReturnType<typeof useVaultActions> {
	return mountVault(platform).actions;
}

/**
 * As above, plus a getter for the vault registry, for a test that has to switch the active vault
 * (per-vault state cached inside the provider only shows its seams when a switch happens under it).
 */
export function mountVault(platform: Platform): {
	actions: () => ReturnType<typeof useVaultActions>;
	registry: () => ReturnType<typeof useVaultRegistry>;
	state: () => ReturnType<typeof useVault>;
} {
	let actions: ReturnType<typeof useVaultActions> | null = null;
	let registry: ReturnType<typeof useVaultRegistry> | null = null;
	let state: ReturnType<typeof useVault> | null = null;
	function Consumer() {
		actions = useVaultActions();
		registry = useVaultRegistry();
		state = useVault();
		return null;
	}
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultRegistryProvider>
					<VaultProvider>
						<Consumer />
					</VaultProvider>
				</VaultRegistryProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	return {
		actions: () => {
			if (!actions) throw new Error("actions not captured");
			return actions;
		},
		registry: () => {
			if (!registry) throw new Error("registry not captured");
			return registry;
		},
		// `isLocked` and friends live on the state context, not on actions, so a test asserting
		// that an unlock actually took needs this rather than the action's return.
		state: () => {
			if (!state) throw new Error("state not captured");
			return state;
		},
	};
}
